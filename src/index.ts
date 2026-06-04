#!/usr/bin/env node
/**
 * Suber Agent Team - MCP server entry point (stdio transport).
 *
 * IMPORTANT: stdout is reserved for the MCP JSON-RPC protocol. All human-readable
 * output (banner, logs, errors) goes to stderr so it never corrupts the stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, formatBanner, type FleetConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  let config: FleetConfig;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`\n[Suber Agent Team] CONFIG ERROR\n  ${(e as Error).message}\n`);
    process.exit(1);
  }

  console.error(formatBanner(config));

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[Suber Agent Team] MCP server ready on stdio. Waiting for the orchestrator...");
}

main().catch((e) => {
  console.error("[Suber Agent Team] FATAL:", e);
  process.exit(1);
});
