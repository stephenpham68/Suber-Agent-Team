#!/usr/bin/env node
/**
 * Suber Agent Team - MCP server entry point (stdio transport).
 *
 * IMPORTANT: stdout is reserved for the MCP JSON-RPC protocol. All human-readable
 * output (banner, logs, errors) goes to stderr so it never corrupts the stream.
 *
 * Process hygiene: stdio MCP runs one process per client session. To avoid orphaned
 * processes lingering after the client window closes (a known Claude-Code-on-Windows
 * leak), we exit promptly when the parent closes our stdin or sends a termination
 * signal. This keeps RAM/process count clean across many sessions.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, formatBanner, type FleetConfig } from "./config.js";
import { createServer } from "./server.js";
import { disposeAllSerena, setupVision } from "./serena.js";

let exiting = false;
/**
 * Graceful shutdown: kill any child Serena MCP processes (they don't auto-die with us on
 * Windows), then exit. Capped so we never hang the session if a child won't close.
 */
function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;
  try {
    process.stderr.write("[Suber Agent Team] shutting down.\n");
  } catch {
    /* stderr may be gone */
  }
  void disposeAllSerena().finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

function installCleanExit(): void {
  // Parent (the MCP client) closed our stdin pipe -> the session is over.
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGHUP", () => shutdown(0));
}

const VERSION = "0.3.0";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`suber-agent-team ${VERSION}\n`);
    process.exit(0);
  }
  // `setup-vision`: one-command install of Serena (LSP vision) for the fleet. This does NOT
  // start the MCP server -- it installs Serena via uv, then exits. Kept off the hot path.
  if (argv.includes("setup-vision") || argv.includes("--setup-vision")) {
    process.exit(await setupVision());
  }
  // `--check` / `--doctor`: validate config + print the banner, then exit WITHOUT starting
  // the MCP server. A clutter-free way to confirm Suber is installed and configured
  // (there is no tray icon by design). For live connection status use Claude Code's /mcp.
  const checkMode = argv.includes("--check") || argv.includes("--doctor");

  let config: FleetConfig;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`\n[Suber Agent Team] CONFIG ERROR\n  ${(e as Error).message}\n`);
    process.exit(1);
  }

  console.error(formatBanner(config));

  if (checkMode) {
    console.error(`[Suber Agent Team] v${VERSION} config OK (--check). Not starting the server.`);
    process.exit(0);
  }

  installCleanExit();

  const server = createServer(config);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    process.stderr.write("[Suber Agent Team] transport closed.\n");
    shutdown(0);
  };
  await server.connect(transport);

  console.error("[Suber Agent Team] MCP server ready on stdio. Waiting for the orchestrator...");
}

main().catch((e) => {
  console.error("[Suber Agent Team] FATAL:", e);
  process.exit(1);
});
