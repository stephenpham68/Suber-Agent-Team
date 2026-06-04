/**
 * MCP server. Exposes a SMALL tool surface (delegate / fanout / map_reduce) so it
 * adds minimal schema overhead to the orchestrator's context. Each tool runs the
 * fleet on the cheap provider and returns concise text + a "tokens offloaded" footer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FleetConfig } from "./config.js";
import {
  runFleet,
  runSingle,
  runMapReduce,
  summarize,
  type FleetAgentResult,
} from "./agent.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], isError };
}

function footer(config: FleetConfig, model: string, results: FleetAgentResult[]): string {
  const s = summarize(results);
  const fallback = s.textToolFallback ? " · text-tool fallback (no native tool_use on this endpoint)" : "";
  return (
    `\n\n---\n[Suber] ${s.count} worker(s) on '${model}' (${config.provider}) · ` +
    `${s.ok} ok / ${s.failed} failed · ${s.toolCalls} tool calls · ` +
    `~${s.inputTokens} in / ${s.outputTokens} out tokens billed to your FLEET provider, ` +
    `not your main account${fallback}.`
  );
}

function renderResults(results: FleetAgentResult[]): string {
  return results
    .map((r) => {
      const head = `### Task ${r.index + 1}${r.ok ? "" : " — FAILED"}`;
      const tail = r.ok ? r.text || "[empty result]" : `ERROR: ${r.error}`;
      return `${head}\n${tail}`;
    })
    .join("\n\n");
}

export function createServer(config: FleetConfig): McpServer {
  const server = new McpServer({ name: "suber-agent-team", version: "0.1.0" });

  server.registerTool(
    "delegate",
    {
      title: "Delegate one task to a cheap-model worker",
      description:
        "Delegate ONE task to a single autonomous worker running on the configured CHEAP model. " +
        "The worker uses tools (read/grep/glob/web) to gather evidence itself, so context-heavy grunt " +
        "work never touches your main account quota. Returns a concise result.",
      inputSchema: {
        task: z.string().describe("The task for the worker. Be specific and self-contained."),
        context: z.string().optional().describe("Optional shared background to prepend to the task."),
        model: z.string().optional().describe("Override the fleet model for this call."),
      },
    },
    async ({ task, context, model }) => {
      try {
        const m = model || config.model;
        const r = await runSingle(config, task, { model, sharedContext: context });
        const body = r.ok ? r.text || "[empty result]" : `ERROR: ${r.error}`;
        return text(body + footer(config, m, [r]), !r.ok);
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "fanout",
    {
      title: "Run many tasks in parallel on cheap-model workers",
      description:
        "Run MANY tasks in parallel, each on its own autonomous cheap-model worker (bounded by " +
        "maxConcurrency). Each worker uses tools itself. Returns one labeled result per task. " +
        "Ideal for parallel research/scans/audits at scale without burning your main quota.",
      inputSchema: {
        tasks: z.array(z.string()).min(1).describe("List of independent tasks to run in parallel."),
        context: z.string().optional().describe("Optional shared background prepended to every task."),
        model: z.string().optional().describe("Override the fleet model for this call."),
      },
    },
    async ({ tasks, context, model }) => {
      try {
        const m = model || config.model;
        const results = await runFleet(config, tasks, { model, sharedContext: context });
        return text(renderResults(results) + footer(config, m, results));
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "map_reduce",
    {
      title: "Map a prompt over items, then reduce to one synthesis",
      description:
        "Map a prompt over many items in parallel on cheap-model workers, then a single worker reduces " +
        "all per-item results into one synthesis. Returns the reduced output. Use when you want a single " +
        "combined answer over a large list without the orchestrator reading every item.",
      inputSchema: {
        items: z.array(z.string()).min(1).describe("Items to map over (e.g. file paths, URLs, chunks)."),
        mapPrompt: z.string().describe("Instruction applied to EACH item."),
        reducePrompt: z.string().describe("Instruction to combine all per-item results into one answer."),
        model: z.string().optional().describe("Override the fleet model for this call."),
      },
    },
    async ({ items, mapPrompt, reducePrompt, model }) => {
      try {
        const m = model || config.model;
        const { mapped, reduced } = await runMapReduce(config, items, mapPrompt, reducePrompt, { model });
        const body = reduced.ok ? reduced.text || "[empty result]" : `ERROR: ${reduced.error}`;
        return text(body + footer(config, m, [...mapped, reduced]), !reduced.ok);
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      }
    },
  );

  return server;
}
