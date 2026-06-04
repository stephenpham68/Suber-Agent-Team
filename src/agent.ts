/**
 * The fleet: run one task or many tasks in parallel on cheap-model workers.
 * Each worker is an autonomous tool-use loop (see providers.ts). The orchestrator
 * (your main model) only sees concise results, so its own quota is preserved.
 */
import type { FleetConfig } from "./config.js";
import { createProvider, type ProviderClient } from "./providers.js";
import { buildToolset, type AgentTool } from "./tools.js";

const SYSTEM_PROMPT = `You are a worker sub-agent in "Suber Agent Team", running on a fast, low-cost model on behalf of a more powerful orchestrator model.
Your job: complete ONE focused task using the available tools, then return a concise, factual result.

Rules:
- Use the tools to gather REAL evidence (read files, grep, glob, fetch). Never guess or invent file contents, paths, or facts.
- Cite concrete evidence: exact file paths with line numbers, URLs, or exact values.
- Be concise and information-dense. Return ONLY what the orchestrator needs. No preamble, no restating the task, no filler.
- If you cannot find something, say so plainly instead of guessing.
- When you have the answer, reply with plain text and NO tool call. That ends your turn.`;

export interface FleetAgentResult {
  index: number;
  task: string;
  ok: boolean;
  text: string;
  error?: string;
  iterations: number;
  toolCalls: number;
  textToolFallback: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export interface FleetOptions {
  model?: string;
  sharedContext?: string;
}

async function runOne(
  provider: ProviderClient,
  tools: AgentTool[],
  index: number,
  task: string,
  model: string,
  sharedContext?: string,
): Promise<FleetAgentResult> {
  const prompt = (sharedContext ? `Shared context:\n${sharedContext}\n\n` : "") + `Task:\n${task}`;
  try {
    const r = await provider.runAgent({ system: SYSTEM_PROMPT, prompt, tools, model });
    return {
      index,
      task,
      ok: true,
      text: r.text,
      iterations: r.iterations,
      toolCalls: r.toolCalls,
      textToolFallback: r.textToolFallback,
      usage: r.usage,
    };
  } catch (e) {
    return {
      index,
      task,
      ok: false,
      text: "",
      error: (e as Error).message,
      iterations: 0,
      toolCalls: 0,
      textToolFallback: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

/** Bounded-concurrency parallel map over tasks. */
export async function runFleet(
  config: FleetConfig,
  tasks: string[],
  opts: FleetOptions = {},
): Promise<FleetAgentResult[]> {
  const provider = createProvider(config);
  const tools = buildToolset(config);
  const model = opts.model || config.model;
  const limit = Math.max(1, Math.min(config.maxConcurrency, tasks.length));

  const results: FleetAgentResult[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      if (task === undefined) return;
      results[i] = await runOne(provider, tools, i, task, model, opts.sharedContext);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** Single task convenience wrapper. */
export async function runSingle(
  config: FleetConfig,
  task: string,
  opts: FleetOptions = {},
): Promise<FleetAgentResult> {
  const [r] = await runFleet(config, [task], opts);
  return r as FleetAgentResult;
}

export interface MapReduceResult {
  mapped: FleetAgentResult[];
  reduced: FleetAgentResult;
}

/** Map a prompt over many items in parallel, then reduce all outputs with one worker. */
export async function runMapReduce(
  config: FleetConfig,
  items: string[],
  mapPrompt: string,
  reducePrompt: string,
  opts: FleetOptions = {},
): Promise<MapReduceResult> {
  const mapTasks = items.map((it) => `${mapPrompt}\n\n--- ITEM ---\n${it}`);
  const mapped = await runFleet(config, mapTasks, opts);

  const combined = mapped
    .map((r) => `### Item ${r.index + 1}${r.ok ? "" : " (FAILED)"}\n${r.ok ? r.text : r.error}`)
    .join("\n\n");

  const reduceTask = `${reducePrompt}\n\n--- COLLECTED RESULTS FROM ${items.length} ITEMS ---\n${combined}`;
  const reduced = await runSingle(config, reduceTask, { model: opts.model });
  return { mapped, reduced };
}

/** Aggregate usage across a set of results, for the "tokens offloaded" footer. */
export function summarize(results: FleetAgentResult[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let ok = 0;
  let textToolFallback = false;
  for (const r of results) {
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
    toolCalls += r.toolCalls;
    if (r.ok) ok++;
    if (r.textToolFallback) textToolFallback = true;
  }
  return {
    inputTokens,
    outputTokens,
    toolCalls,
    ok,
    failed: results.length - ok,
    count: results.length,
    textToolFallback,
  };
}
