/**
 * Serena integration: give cheap workers SEMANTIC ("LSP") vision.
 *
 * Suber stays a tiny TS single-binary and keeps Serena as a SEPARATE program (a Python
 * package installed via `uv tool install serena-agent`). We do NOT fork its source or
 * download a binary on the hot path. Instead Suber acts as an MCP *client*: it spawns a
 * Serena MCP server over stdio, lists its tools, and wraps a READ-ONLY allowlist of its
 * symbol-level tools (find_symbol / get_symbols_overview / find_referencing_symbols / ...)
 * as ordinary `AgentTool`s. Workers then navigate code by structure instead of reading whole
 * files -- far fewer input tokens, and `find_referencing_symbols` is real semantic proof of
 * "who calls X" (much stronger than grep) which sharpens the fleet's proving-absence rule.
 *
 * Lifecycle: ONE Serena process per absolute workspace root, created lazily and SHARED by
 * every worker in a run (LSP startup is slow -- never one-per-worker). Fail-soft: if Serena
 * is absent or fails to start, workers transparently fall back to the built-in textual tools.
 */
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { FleetConfig } from "./config.js";
import type { AgentTool } from "./tools.js";

interface SerenaConn {
  client: Client;
  tools: AgentTool[];
}

/**
 * One Serena connection per absolute workspace root, keyed so the whole fleet shares a single
 * LSP-backed process. We cache the PROMISE (so concurrent workers don't race a second spawn)
 * and cache `null` on failure (so a missing Serena doesn't trigger a spawn-storm across workers).
 */
const pool = new Map<string, Promise<SerenaConn | null>>();

/** Join MCP content blocks into the plain string an AgentTool.run must return. */
function blocksToText(res: unknown): { text: string; isError: boolean } {
  const r = res as { content?: unknown; isError?: boolean };
  const blocks = Array.isArray(r?.content) ? (r.content as Array<Record<string, unknown>>) : [];
  const text = blocks
    .map((b) => (b?.type === "text" ? String(b.text ?? "") : `[${String(b?.type ?? "block")}]`))
    .join("\n")
    .trim();
  return { text, isError: r?.isError === true };
}

/**
 * Per-tool token-thrift hints appended to Serena's own description. Cheap workers otherwise pull
 * full symbol bodies by reflex; steering find_symbol toward navigation-mode keeps results small
 * (and small results stay cheap under the re-sent history).
 */
const SERENA_THRIFT_HINTS: Record<string, string> = {
  find_symbol:
    " TOKEN THRIFT: call with include_body=false to LOCATE a symbol (cheap -- returns its path/signature); " +
    "set include_body=true ONLY when you must read or quote the source. Use 'depth' to limit children.",
};

/** Wrap one Serena MCP tool as an AgentTool that proxies run() -> serena tools/call. */
function wrapTool(client: Client, tool: { name: string; description?: string; inputSchema?: unknown }): AgentTool {
  const params =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  return {
    name: tool.name,
    // Tag the source so workers (and the text-tool protocol) know these are semantic, not textual.
    description: `[serena/LSP] ${tool.description ?? ""}${SERENA_THRIFT_HINTS[tool.name] ?? ""}`.trim(),
    parameters: params,
    async run(args) {
      // Generous timeout: an LSP call can be slow on first touch of a language.
      const res = await client.callTool({ name: tool.name, arguments: args ?? {} }, undefined, {
        timeout: 120_000,
      });
      const { text, isError } = blocksToText(res);
      if (isError) return `Serena tool error: ${text || "(no detail)"}`;
      return text || "[empty result]";
    },
  };
}

/** Spawn + handshake one Serena MCP server jailed to `root`, returning the wrapped read-only tools. */
async function connect(config: FleetConfig, root: string): Promise<SerenaConn> {
  const args = [
    "start-mcp-server",
    "--context",
    config.serena.context,
    "--transport",
    "stdio",
    "--project",
    root,
    // Headless: never pop a browser dashboard for a fleet worker, keep logs quiet.
    "--enable-web-dashboard",
    "false",
    "--open-web-dashboard",
    "false",
    "--log-level",
    "ERROR",
  ];
  const transport = new StdioClientTransport({
    command: config.serena.command,
    args,
    cwd: root,
    stderr: "ignore", // Serena's own logs would clutter Suber's stderr banner; drop them.
  });
  const client = new Client({ name: "suber-agent-team", version: "0.4.0" });
  // connect() runs start() + the MCP initialize handshake. Allow time for a cold LSP boot.
  await client.connect(transport, { timeout: 120_000 });

  const listed = await client.listTools();
  const allow = new Set(config.serena.tools);
  const tools = (listed.tools ?? [])
    .filter((t) => allow.has(t.name))
    .map((t) => wrapTool(client, t as { name: string; description?: string; inputSchema?: unknown }));
  return { client, tools };
}

/**
 * Read-only Serena vision tools for `root`, or [] when Serena is off/absent/unhealthy.
 * Pooled per root; never throws (fail-soft -- the fleet keeps its textual tools).
 */
export async function getSerenaTools(config: FleetConfig, root: string): Promise<AgentTool[]> {
  if (config.serena.mode === "off") return [];
  let entry = pool.get(root);
  if (!entry) {
    entry = connect(config, root).catch((e) => {
      const msg = (e as Error).message;
      if (config.serena.mode === "on") {
        // Explicitly requested -> say why it didn't attach.
        process.stderr.write(
          `[Suber] Serena vision unavailable: ${msg}\n` +
            `        Workers fall back to textual tools. Run 'setup-vision' to install Serena.\n`,
        );
      } else if (process.env.SUBER_SERENA_DEBUG) {
        // auto -> stay silent unless debugging.
        process.stderr.write(`[Suber] Serena not attached (auto): ${msg}\n`);
      }
      return null;
    });
    pool.set(root, entry);
  }
  const conn = await entry;
  return conn ? conn.tools : [];
}

/** Best-effort teardown of every Serena child process. Called on clean exit. */
export async function disposeAllSerena(): Promise<void> {
  const entries = Array.from(pool.values());
  pool.clear();
  await Promise.allSettled(
    entries.map(async (p) => {
      const conn = await p.catch(() => null);
      if (conn) await conn.client.close().catch(() => {});
    }),
  );
}

// ---------------------------------------------------------------------------
// `setup-vision` CLI command: one-command install of Serena for the community.
// Serena is a Python app installed via uv (its official method); there is no single
// pre-built binary to fetch. We keep this OFF the fleet hot path -- it runs only when
// the user explicitly invokes it, with full output + consent.
// ---------------------------------------------------------------------------

/** Run a command inheriting stdio (so the user sees uv's progress). Resolves with the exit code. */
function runInherit(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // shell:true so Windows resolves uv/serena shims (.exe/.cmd) via PATHEXT. Args are fixed literals.
    const child = spawn(command, args, { stdio: "inherit", shell: true });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/**
 * Install Serena via uv so the fleet gains LSP vision. Returns a process exit code.
 * Human output goes to stderr (this command never starts the MCP server, so stdout is free,
 * but we stay consistent with the rest of Suber).
 */
export async function setupVision(): Promise<number> {
  process.stderr.write("\n[Suber] Setting up Serena (semantic LSP vision) for the fleet...\n\n");

  if ((await runInherit("uv", ["--version"])) !== 0) {
    process.stderr.write(
      "\n[Suber] `uv` was not found. Serena installs via uv (Astral). Install uv first:\n" +
        '  Windows : powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"\n' +
        "  macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
        "Then re-run: suber-agent-team setup-vision\n",
    );
    return 1;
  }

  const code = await runInherit("uv", ["tool", "install", "-p", "3.13", "serena-agent"]);
  if (code !== 0) {
    process.stderr.write("\n[Suber] Serena install failed (see uv output above).\n");
    return code;
  }

  await runInherit("serena", ["--version"]);
  process.stderr.write(
    "\n[Suber] Serena installed. The fleet now gains LSP vision automatically (SUBER_SERENA=auto).\n" +
      "        Re-launch Suber; workers get find_symbol / get_symbols_overview / find_referencing_symbols, etc.\n" +
      "        (First use of each language downloads its language server on demand.)\n",
  );
  return 0;
}
