/**
 * Worker tool layer. Each worker (running on the cheap model) calls these tools
 * to gather real evidence instead of hallucinating. Read-only by default.
 *
 * All filesystem access is jailed to config.workspaceRoot. Bash is denylist-guarded.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { glob } from "tinyglobby";

import type { FleetConfig } from "./config.js";

const execAsync = promisify(exec);

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  parameters: Record<string, unknown>;
  dangerous?: boolean;
  run(args: Record<string, unknown>): Promise<string>;
}

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/bin-dist/**"];
const MAX_FILE_BYTES = 1_000_000;

function resolveInRoot(root: string, p: string): string {
  if (typeof p !== "string" || p.length === 0) throw new Error("path is required");
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`Path '${p}' escapes the workspace root and is not allowed.`);
  }
  return abs;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readFileTool(root: string): AgentTool {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace. Returns its contents (truncated if very large).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        maxBytes: { type: "number", description: "Optional cap on returned characters (default 200000)." },
      },
      required: ["path"],
    },
    async run(args) {
      const p = String(args.path ?? "");
      const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : 200_000;
      const abs = resolveInRoot(root, p);
      const buf = await fsp.readFile(abs);
      let text = buf.toString("utf8");
      if (text.length > maxBytes) {
        text = text.slice(0, maxBytes) + `\n...[truncated; file is ${buf.length} bytes]`;
      }
      return text || "[empty file]";
    },
  };
}

function globTool(root: string): AgentTool {
  return {
    name: "glob",
    description: "List files matching a glob pattern (e.g. 'src/**/*.ts') inside the workspace.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob pattern." } },
      required: ["pattern"],
    },
    async run(args) {
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required");
      const files = await glob([pattern], { cwd: root, absolute: false, dot: false, ignore: IGNORE });
      if (!files.length) return "No files matched.";
      const head = files.slice(0, 500).join("\n");
      return files.length > 500 ? `${head}\n...[${files.length - 500} more matches]` : head;
    },
  };
}

function grepTool(root: string): AgentTool {
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns 'path:line: text' matches. " +
      "Scope with an optional single file path or a glob.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (case-insensitive)." },
        path: { type: "string", description: "Optional single file to search." },
        glob: { type: "string", description: "Optional glob of files to search (default '**/*')." },
        maxMatches: { type: "number", description: "Max matches to return (default 100)." },
      },
      required: ["pattern"],
    },
    async run(args) {
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required");
      const maxMatches = typeof args.maxMatches === "number" ? args.maxMatches : 100;
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch (e) {
        throw new Error(`Invalid regex: ${(e as Error).message}`);
      }

      let files: string[];
      if (typeof args.path === "string" && args.path) {
        files = [resolveInRoot(root, args.path)];
      } else {
        const g = typeof args.glob === "string" && args.glob ? args.glob : "**/*";
        files = await glob([g], { cwd: root, absolute: true, dot: false, ignore: IGNORE });
      }

      const out: string[] = [];
      for (const f of files) {
        let content: string;
        try {
          const st = await fsp.stat(f);
          if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
          content = await fsp.readFile(f, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (re.test(line)) {
            out.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (out.length >= maxMatches) {
              return `${out.join("\n")}\n...[truncated at ${maxMatches} matches]`;
            }
          }
        }
      }
      return out.length ? out.join("\n") : "No matches.";
    },
  };
}

function webFetchTool(): AgentTool {
  return {
    name: "web_fetch",
    description: "Fetch a URL and return its text (HTML stripped to plain text, truncated).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        maxChars: { type: "number", description: "Max characters to return (default 8000)." },
      },
      required: ["url"],
    },
    async run(args) {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must be an absolute http(s) URL");
      const maxChars = typeof args.maxChars === "number" ? args.maxChars : 8000;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "suber-agent-team/0.1 (+https://github.com)" },
      });
      const ct = res.headers.get("content-type") ?? "";
      let text = await res.text();
      if (/html/i.test(ct)) text = stripHtml(text);
      if (!res.ok) return `[HTTP ${res.status} ${res.statusText}]\n${text.slice(0, maxChars)}`;
      return text.slice(0, maxChars);
    },
  };
}

function writeFileTool(root: string): AgentTool {
  return {
    name: "write_file",
    description: "DANGEROUS. Create or overwrite a file inside the workspace.",
    dangerous: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full file contents to write." },
      },
      required: ["path", "content"],
    },
    async run(args) {
      const p = String(args.path ?? "");
      const content = String(args.content ?? "");
      const abs = resolveInRoot(root, p);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
    },
  };
}

const BASH_DENY: RegExp[] = [
  /\brm\s+-rf?\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\s*\(\s*\)\s*\{/, // fork bomb
  />\s*\/dev\/sd/i,
  /\bsudo\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bgit\s+push\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh/i,
];

function assertSafeCommand(cmd: string): void {
  for (const re of BASH_DENY) {
    if (re.test(cmd)) {
      throw new Error(
        `Command blocked by Suber safety denylist (matched ${re}). ` +
          `Edit src/tools.ts BASH_DENY if you intentionally need it.`,
      );
    }
  }
}

function bashTool(root: string): AgentTool {
  return {
    name: "bash",
    description: "DANGEROUS. Run a shell command in the workspace (60s timeout, output capped, denylist-guarded).",
    dangerous: true,
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command to run." } },
      required: ["command"],
    },
    async run(args) {
      const command = String(args.command ?? "");
      if (!command) throw new Error("command is required");
      assertSafeCommand(command);
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: root,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        const out = (stdout || "").slice(0, 20_000);
        const err = stderr ? `\n[stderr]\n${stderr.slice(0, 4000)}` : "";
        return out + err || "[no output]";
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        return `[command failed] ${err.message}\n${(err.stdout || "").slice(0, 4000)}\n${(err.stderr || "").slice(0, 4000)}`;
      }
    },
  };
}

/** Build the toolset a worker is allowed to use, based on config. */
export function buildToolset(config: FleetConfig): AgentTool[] {
  const root = config.workspaceRoot;
  const scoutFactories: Record<string, () => AgentTool> = {
    read_file: () => readFileTool(root),
    glob: () => globTool(root),
    grep: () => grepTool(root),
    web_fetch: () => webFetchTool(),
  };

  const tools: AgentTool[] = [];
  for (const name of config.tools) {
    const factory = scoutFactories[name];
    if (factory) tools.push(factory());
  }
  if (config.capabilities.write) tools.push(writeFileTool(root));
  if (config.capabilities.bash) tools.push(bashTool(root));
  return tools;
}
