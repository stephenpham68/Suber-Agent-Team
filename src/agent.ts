/**
 * The fleet: run one task or many tasks in parallel on cheap-model workers.
 * Each worker is an autonomous tool-use loop (see providers.ts). The orchestrator
 * (your main model) only sees concise results, so its own quota is preserved.
 *
 * `runResearch` adds an orchestrator-worker layer (Anthropic's Research pattern):
 * a synth-tier lead decomposes the objective into subtasks, scout-tier workers run
 * them in parallel, then a synth-tier worker synthesizes (and optionally verifies)
 * the findings into one cited answer -- all on the cheap provider.
 */
import type { FleetConfig } from "./config.js";
import { createProvider, type ProviderClient } from "./providers.js";
import { buildToolset, type AgentTool } from "./tools.js";

const SYSTEM_PROMPT = `You are a worker sub-agent in "Suber Agent Team", running on a fast, low-cost model on behalf of a more powerful orchestrator model.
Your job: complete ONE focused task using the available tools, then return a concise, factual result.

Rules:
- Use the tools to gather REAL evidence (read files, grep, glob, list_dir, fetch). Never guess or invent file contents, paths, or facts.
- Cite concrete evidence: exact file paths with line numbers, URLs, or exact values.
- Be concise and information-dense. Return ONLY what the orchestrator needs. No preamble, no restating the task, no filler.
- PROVING ABSENCE: before you assert that something does NOT exist, is NEVER called, is missing, or is broken, you MUST search the ENTIRE workspace with grep using NO 'path' and NO 'glob' scope (the default '**/*'), AND list_dir the plausible directories. A negative result from a scoped/narrow search is NOT evidence of absence -- widen the search before claiming it. If after a full-workspace search you still find nothing, say "not found after full-workspace search" rather than asserting it cannot exist.
- If you genuinely cannot determine something, say so plainly instead of guessing.
- When you have the answer, reply with plain text and NO tool call. That ends your turn.`;

const LEAD_PROMPT = `You are the LEAD planner of "Suber Agent Team". You DECOMPOSE one research objective into independent subtasks that cheap scout workers can run in parallel.

Rules for good decomposition (from Anthropic's multi-agent research guidance):
- Scale effort to complexity: simple fact-finding = 1-3 subtasks; comparisons = 3-5; broad research = 5-10. Do NOT over-spawn.
- Each subtask must be SELF-CONTAINED: a clear objective, what to look at (files/globs/areas or what to search), and what to return. No overlap between subtasks; divide labor cleanly.
- Subtasks must be independently executable in parallel (no subtask depends on another's output).
- You MAY use the tools first to scope the workspace (glob/grep) before deciding the split.

When ready, output ONLY a JSON array of subtask strings and nothing else, e.g.:
["Audit the auth flow in src/auth/*.ts for token-refresh races; report file:line.", "..."]`;

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
  maxTokens?: number;
  thinkingBudget?: number;
  /** Jail workers to this directory for this run. Absolute path. Defaults to config.workspaceRoot. */
  root?: string;
}

async function runOne(
  provider: ProviderClient,
  tools: AgentTool[],
  index: number,
  task: string,
  model: string,
  opts: FleetOptions,
): Promise<FleetAgentResult> {
  const prompt = (opts.sharedContext ? `Shared context:\n${opts.sharedContext}\n\n` : "") + `Task:\n${task}`;
  try {
    const r = await provider.runAgent({
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      model,
      maxTokens: opts.maxTokens,
      thinkingBudget: opts.thinkingBudget,
    });
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
  const tools = buildToolset(config, opts.root);
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
      results[i] = await runOne(provider, tools, i, task, model, opts);
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

export interface MapReduceOptions extends FleetOptions {
  /** Model for the reduce step. Defaults to the synth tier. */
  reduceModel?: string;
}

export interface MapReduceResult {
  mapped: FleetAgentResult[];
  reduced: FleetAgentResult;
}

/** Map a prompt over many items in parallel, then reduce all outputs with one (synth) worker. */
export async function runMapReduce(
  config: FleetConfig,
  items: string[],
  mapPrompt: string,
  reducePrompt: string,
  opts: MapReduceOptions = {},
): Promise<MapReduceResult> {
  const mapTasks = items.map((it) => `${mapPrompt}\n\n--- ITEM ---\n${it}`);
  const mapped = await runFleet(config, mapTasks, {
    model: opts.model ?? config.models.scout,
    sharedContext: opts.sharedContext,
    maxTokens: opts.maxTokens,
  });

  const combined = mapped
    .map((r) => `### Item ${r.index + 1}${r.ok ? "" : " (FAILED)"}\n${r.ok ? r.text : r.error}`)
    .join("\n\n");

  const reduceTask = `${reducePrompt}\n\n--- COLLECTED RESULTS FROM ${items.length} ITEMS ---\n${combined}`;
  const reduced = await runSingle(config, reduceTask, {
    model: opts.reduceModel ?? config.models.synth,
    maxTokens: config.synthMaxTokens,
    thinkingBudget: config.thinkingBudget,
  });
  return { mapped, reduced };
}

/** Parse the lead's plan: a JSON array of subtask strings (with graceful fallbacks). */
export function parsePlan(text: string, max: number): string[] {
  const clean = text.trim();
  // Prefer the first JSON array in the text.
  const match = clean.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]) as unknown[];
      const tasks = arr
        .map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "task" in x ? String((x as any).task) : ""))
        .map((s) => s.trim())
        .filter(Boolean);
      if (tasks.length) return tasks.slice(0, max);
    } catch {
      /* fall through */
    }
  }
  // Fallback: numbered/bulleted lines.
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((l) => l.length > 8);
  return lines.slice(0, max);
}

export interface ResearchOptions {
  context?: string;
  /** Cap on the number of subtasks the lead may spawn. */
  maxSubagents?: number;
  scoutModel?: string;
  synthModel?: string;
  /** Jail all workers (lead + scouts + synth) to this directory. Absolute path. */
  root?: string;
  /** When true, the synthesis step is told to flag any claim lacking concrete evidence. */
  verify?: boolean;
}

export interface ResearchResult {
  objective: string;
  plan: string[];
  lead: FleetAgentResult;
  mapped: FleetAgentResult[];
  /** Adversarial refutation pass. Present only when opts.verify is true. */
  skeptic?: FleetAgentResult;
  synthesis: FleetAgentResult;
}

const SKEPTIC_PROMPT = `You are the SKEPTIC of "Suber Agent Team". Your ONLY job is to try to REFUTE the findings below, not to agree with them.
You have the same tools as the scouts (read_file, grep, glob, list_dir, web_fetch).

Method:
- For EVERY claim that asserts something does NOT exist, is missing, is NEVER called, or is broken: RE-RUN grep across the ENTIRE workspace with NO 'path' and NO 'glob' scope (default '**/*'), and list_dir the plausible directories. If you find counter-evidence, the claim is REFUTED -- record the exact file:line that disproves it.
- For every other claim: check that it is backed by concrete evidence (exact file:line / URL / value) that actually says what the claim says.
- Default to skepticism: if a non-existence/broken claim was based only on a scoped search, treat it as UNCONFIRMED until you re-verify it workspace-wide.

Output a terse report, one line per claim, each tagged exactly one of:
  REFUTED: <claim> -- counter-evidence at <file:line>
  CONFIRMED: <claim> -- evidence at <file:line/URL>
  UNCONFIRMED: <claim> -- no concrete evidence found after full-workspace search
Do not restate anything else.`;

/**
 * Orchestrator-worker research in one call:
 *   1. synth-tier LEAD decomposes the objective into independent subtasks,
 *   2. scout-tier workers run them in parallel,
 *   3. synth-tier worker synthesizes (and optionally verifies) into one cited answer.
 */
export async function runResearch(
  config: FleetConfig,
  objective: string,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  const provider = createProvider(config);
  const tools = buildToolset(config, opts.root);
  const scoutModel = opts.scoutModel ?? config.models.scout;
  const synthModel = opts.synthModel ?? config.models.synth;
  const maxSubagents = Math.max(1, Math.min(opts.maxSubagents ?? 8, config.maxConcurrency * 2));

  // 1. LEAD decomposes.
  const leadPrompt =
    (opts.context ? `Shared context:\n${opts.context}\n\n` : "") +
    `Research objective:\n${objective}\n\nDecompose into at most ${maxSubagents} independent subtasks.`;
  let lead: FleetAgentResult;
  try {
    const r = await provider.runAgent({
      system: LEAD_PROMPT,
      prompt: leadPrompt,
      tools,
      model: synthModel,
      maxTokens: config.synthMaxTokens,
      thinkingBudget: config.thinkingBudget,
    });
    lead = {
      index: 0,
      task: "[lead] decompose",
      ok: true,
      text: r.text,
      iterations: r.iterations,
      toolCalls: r.toolCalls,
      textToolFallback: r.textToolFallback,
      usage: r.usage,
    };
  } catch (e) {
    lead = {
      index: 0, task: "[lead] decompose", ok: false, text: "", error: (e as Error).message,
      iterations: 0, toolCalls: 0, textToolFallback: false, usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const plan = lead.ok ? parsePlan(lead.text, maxSubagents) : [];
  // If decomposition failed, fall back to running the objective as a single subtask.
  const subtasks = plan.length ? plan : [objective];

  // 2. scout-tier fan-out.
  const mapped = await runFleet(config, subtasks, {
    model: scoutModel,
    sharedContext: opts.context,
    maxTokens: config.maxTokens,
    root: opts.root,
  });

  // 3. synth-tier synthesis (+ optional adversarial verification).
  const findings = mapped
    .map((r) => `### Subtask ${r.index + 1}${r.ok ? "" : " (FAILED)"}: ${r.task}\n${r.ok ? r.text : r.error}`)
    .join("\n\n");

  // 3a. OPTIONAL adversarial refute pass: a skeptic worker (with tools) re-greps the
  // whole workspace to disprove every non-existence/broken claim before we trust it.
  // This is what kills the "scoped grep found nothing -> it must be missing" false positive.
  let skeptic: FleetAgentResult | undefined;
  if (opts.verify) {
    const skepticTask =
      `Try to refute these findings for the objective: ${objective}\n\n--- FINDINGS TO REFUTE (${mapped.length}) ---\n${findings}`;
    skeptic = await runSingle(config, skepticTask, {
      model: synthModel,
      sharedContext: SKEPTIC_PROMPT,
      maxTokens: config.synthMaxTokens,
      thinkingBudget: config.thinkingBudget,
      root: opts.root,
    });
  }

  const verifyClause = opts.verify
    ? "\nVERIFY using the SKEPTIC REPORT below: DROP every claim the skeptic marked REFUTED, and move every UNCONFIRMED claim into a 'Unverified / needs follow-up' section instead of asserting it. Keep only CONFIRMED findings (and uncontested ones backed by concrete evidence) in the main answer."
    : "";
  const skepticBlock =
    opts.verify && skeptic?.ok && skeptic.text
      ? `\n\n--- SKEPTIC REPORT (adversarial) ---\n${skeptic.text}`
      : "";
  const synthTask =
    `You are the LEAD synthesizer. Combine the subtask findings below into ONE coherent, cited answer to the objective.\n` +
    `Objective: ${objective}${verifyClause}\n` +
    `Be concise and information-dense; preserve concrete evidence (file:line / URL). Drop filler and duplicates.\n\n` +
    `--- SUBTASK FINDINGS (${mapped.length}) ---\n${findings}${skepticBlock}`;
  const synthesis = await runSingle(config, synthTask, {
    model: synthModel,
    maxTokens: config.synthMaxTokens,
    thinkingBudget: config.thinkingBudget,
    root: opts.root,
  });

  return { objective, plan: subtasks, lead, mapped, skeptic, synthesis };
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
