/**
 * Worker tool layer. Each worker (running on the cheap model) calls these tools
 * to gather real evidence instead of hallucinating. Read-only by default.
 *
 * All filesystem access is jailed to config.workspaceRoot. Bash is denylist-guarded.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { glob } from "tinyglobby";

import type { FleetConfig } from "./config.js";

const execAsync = promisify(exec);

/**
 * Fast content search via ripgrep when it is on PATH. Returns formatted 'path:line: text'
 * matches, or null when rg is unavailable or errors (the caller then falls back to the
 * dependency-free in-JS scan). rg is far faster on big trees, so workers no longer have a
 * reason to avoid a full-workspace grep -- which is what makes negative results trustworthy.
 */
function ripgrepSearch(
  root: string,
  pattern: string,
  opts: { path?: string; glob?: string; maxMatches: number },
): Promise<string | null> {
  const args = ["--line-number", "--no-heading", "--color=never", "--ignore-case"];
  if (opts.glob) args.push("--glob", opts.glob);
  // Exclusions go LAST so they win over an inclusive --glob (ripgrep: last match wins).
  for (const ig of ["!**/node_modules/**", "!**/.git/**", "!**/dist/**", "!**/bin-dist/**"]) {
    args.push("--glob", ig);
  }
  args.push("--regexp", pattern, opts.path ?? ".");
  return new Promise((resolve) => {
    execFile(
      "rg",
      args,
      { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const code = err ? (err as NodeJS.ErrnoException).code : 0;
        if (code === "ENOENT") return resolve(null); // ripgrep not installed -> fall back
        if (typeof code === "number" && code >= 2) return resolve(null); // rg error -> fall back
        const lines = (stdout || "").split(/\r?\n/).filter(Boolean);
        const matches: string[] = [];
        for (const raw of lines) {
          const m = raw.match(/^(.+?):(\d+):(.*)$/);
          if (!m) continue;
          const p = (m[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
          matches.push(`${p}:${m[2]}: ${(m[3] ?? "").trim().slice(0, 200)}`);
          if (matches.length >= opts.maxMatches) break;
        }
        if (!matches.length) return resolve("No matches.");
        const out = matches.join("\n");
        resolve(lines.length > opts.maxMatches ? `${out}\n...[truncated at ${opts.maxMatches} matches]` : out);
      },
    );
  });
}

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

function listDirTool(root: string): AgentTool {
  const SKIP = new Set(["node_modules", ".git", "dist", "bin-dist"]);
  return {
    name: "list_dir",
    description:
      "List a directory inside the workspace (subdirs get a trailing '/'). Use it to SEE the tree and orient " +
      "before grepping, so you don't search a narrow scope by mistake. recursive=true gives a depth-limited tree.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root (default '.')." },
        recursive: { type: "boolean", description: "List nested entries up to maxDepth (default false)." },
        maxDepth: { type: "number", description: "Max recursion depth when recursive (default 2, max 8)." },
      },
    },
    async run(args) {
      const p = typeof args.path === "string" && args.path ? args.path : ".";
      const abs = resolveInRoot(root, p);
      const recursive = args.recursive === true;
      const maxDepth = typeof args.maxDepth === "number" ? Math.max(1, Math.min(args.maxDepth, 8)) : 2;
      const acc: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) =>
          a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
        );
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          if (acc.length >= 1000) return;
          const full = path.join(dir, e.name);
          const rel = path.relative(root, full).replace(/\\/g, "/");
          acc.push(e.isDirectory() ? `${rel}/` : rel);
          if (recursive && e.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
        }
      };
      await walk(abs, 1);
      if (!acc.length) return "[empty directory]";
      return acc.length >= 1000 ? `${acc.join("\n")}\n...[truncated at 1000 entries]` : acc.join("\n");
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

      const scopePath = typeof args.path === "string" && args.path ? args.path : undefined;
      const scopeGlob = typeof args.glob === "string" && args.glob ? args.glob : undefined;
      if (scopePath) resolveInRoot(root, scopePath); // reject scopes that escape the root

      // Fast path: ripgrep, when installed. Falls through to the in-JS scan on miss/error.
      const rg = await ripgrepSearch(root, pattern, { path: scopePath, glob: scopeGlob, maxMatches });
      if (rg !== null) return rg;

      // Fallback: dependency-free in-process scan (reads each matched file).
      let files: string[];
      if (scopePath) {
        files = [resolveInRoot(root, scopePath)];
      } else {
        const g = scopeGlob ?? "**/*";
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

function webSearchTool(apiKey: string): AgentTool {
  return {
    name: "web_search",
    description:
      "Search the web via Tavily and return ranked results (title, URL, snippet). Use this to FIND pages by " +
      "query; use web_fetch afterwards to read a specific URL in full.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        maxResults: { type: "number", description: "Max results to return (default 5, max 20)." },
      },
      required: ["query"],
    },
    async run(args) {
      const query = String(args.query ?? "");
      if (!query) throw new Error("query is required");
      const maxResults = typeof args.maxResults === "number" ? Math.max(1, Math.min(args.maxResults, 20)) : 5;
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return `[Tavily HTTP ${res.status} ${res.statusText}] ${t.slice(0, 500)}`;
      }
      const data = (await res.json()) as {
        answer?: string;
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const parts: string[] = [];
      if (data.answer) parts.push(`Answer: ${data.answer}`);
      for (const r of data.results ?? []) {
        parts.push(`- ${r.title ?? "(untitled)"}\n  ${r.url ?? ""}\n  ${(r.content ?? "").slice(0, 300)}`);
      }
      return parts.length ? parts.join("\n") : "No results.";
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

function editFileTool(root: string): AgentTool {
  return {
    name: "edit_file",
    description:
      "DANGEROUS. Surgically replace an exact text snippet in a file (no full-file clobber). " +
      "oldText must occur EXACTLY once unless replaceAll=true; include enough surrounding context to be unique.",
    dangerous: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        oldText: { type: "string", description: "Exact text to find (verbatim, including whitespace)." },
        newText: { type: "string", description: "Replacement text." },
        replaceAll: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "oldText", "newText"],
    },
    async run(args) {
      const p = String(args.path ?? "");
      const oldText = String(args.oldText ?? "");
      const newText = String(args.newText ?? "");
      if (!oldText) throw new Error("oldText is required");
      if (oldText === newText) throw new Error("oldText and newText are identical; nothing to do.");
      const replaceAll = args.replaceAll === true;
      const abs = resolveInRoot(root, p);
      const content = await fsp.readFile(abs, "utf8");
      const count = content.split(oldText).length - 1;
      if (count === 0) throw new Error(`oldText not found in ${p}.`);
      if (count > 1 && !replaceAll) {
        throw new Error(`oldText occurs ${count}x in ${p}; add more context to make it unique, or pass replaceAll=true.`);
      }
      // split/join and the replacer function both treat newText literally ($ is not special).
      const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
      await fsp.writeFile(abs, updated, "utf8");
      const n = replaceAll ? count : 1;
      return `Edited ${p} (${n} replacement${n === 1 ? "" : "s"}).`;
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
export function buildToolset(config: FleetConfig, rootOverride?: string): AgentTool[] {
  const root = rootOverride ?? config.workspaceRoot;
  const scoutFactories: Record<string, () => AgentTool> = {
    read_file: () => readFileTool(root),
    glob: () => globTool(root),
    list_dir: () => listDirTool(root),
    grep: () => grepTool(root),
    web_fetch: () => webFetchTool(),
  };

  const tools: AgentTool[] = [];
  for (const name of config.tools) {
    const factory = scoutFactories[name];
    if (factory) tools.push(factory());
  }
  // web_search auto-enables when a Tavily key is configured (it needs no allowlist entry).
  if (config.tavilyApiKey) tools.push(webSearchTool(config.tavilyApiKey));
  if (config.capabilities.write) {
    tools.push(writeFileTool(root));
    tools.push(editFileTool(root));
  }
  if (config.capabilities.bash) tools.push(bashTool(root));
  return tools;
}
