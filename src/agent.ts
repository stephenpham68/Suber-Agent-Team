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
import { getSerenaTools } from "./serena.js";
import { emit, summarizeArgs, summarizeResult, type ProgressContext, type ToolHooks } from "./progress.js";

/**
 * Built-in textual tools + (when enabled & reachable) Serena's read-only LSP vision tools,
 * all jailed to `root`. Serena attachment is pooled per root and fail-soft: if it is off,
 * absent, or unhealthy, workers simply keep the textual toolset.
 */
async function assembleToolset(config: FleetConfig, root?: string): Promise<AgentTool[]> {
  const abs = root ?? config.workspaceRoot;
  const tools = buildToolset(config, abs);
  const serena = await getSerenaTools(config, abs);
  if (serena.length) tools.push(...serena);
  return tools;
}

const SYSTEM_PROMPT = `You are a worker sub-agent in "Suber Agent Team", running on a fast, low-cost model on behalf of a more powerful orchestrator model.
Your job: complete ONE focused task using the available tools, then return a concise, factual result.

Rules:
- Use the tools to gather REAL evidence (read files, grep, glob, list_dir, fetch). Never guess or invent file contents, paths, or facts.
- Cite concrete evidence: exact file paths with line numbers, URLs, or exact values. Use ONLY line numbers that ACTUALLY appear in tool output -- read_file is line-numbered (each line is prefixed with "<N>\t"), and grep returns "path:line:". NEVER invent, estimate, or count line numbers yourself; if you don't have the number from a tool result, cite the file/symbol without a line number rather than guessing. When a Serena symbol tool returns a structured location (body_location / start_line / end_line), cite THOSE exact numbers -- never restate a line number from prose or from your own earlier narration; carry it from the tool result.
- EVIDENCE TIER -- tag every nontrivial claim so the synthesizer can trust or drop it:
  * \`[verified: file:line]\` -- you read it DIRECTLY in a tool result (read/grep/Serena) this run. Only these may be presented as fact.
  * \`[inferred]\` -- you reasoned it from evidence but did not read it verbatim.
  * \`[from-memory]\` -- NOT read from any tool result (prior knowledge, a remembered API/type signature, a version number, a GitHub/issue ID, an external fact). from-memory claims are UNTRUSTED: verify them with a tool or omit them. NEVER state a type signature, version, issue number, or external fact as fact unless a tool result shows it verbatim.
- DOC IS NOT CODE: documentation, changelogs, postmortems, audit notes, and code comments describe the code AS OF SOME PAST DATE -- it may have been fixed since. NEVER report a current bug just because a doc/comment says so. Any claim whose only source is a doc MUST be re-verified against the CURRENT code (grep/read/Serena) before you call it real; if the code disagrees, the code wins. If you cannot find the claim in current code, label it exactly \`DOC-CLAIM (<source>, <date if known>) -- not verified in current code\` and do NOT present it as a confirmed bug. This is the #1 source of false positives -- a doc described a since-fixed problem.
- CAPABILITY HONESTY: you have ONLY the tools in your tool schema for this run. If the task needs something none of them can do (e.g. it says SEARCH THE WEB but you have no web_search/web_fetch tool, or RUN/WRITE something but you have no bash/write_file tool), do NOT answer from memory and do NOT imply you did it. Emit one line \`CAPABILITY UNAVAILABLE: <what you could not do> (no <tool>)\` and complete only the part you can actually evidence.
- Be concise and information-dense. Return ONLY what the orchestrator needs. No preamble, no restating the task, no filler.
- TOKEN THRIFT (you run on a metered cheap model, usually with NO prompt caching -- every tool result you pull is re-sent on EVERY later turn, so keep them small and few):
  * Locate BEFORE you read: use grep / get_symbols_overview / glob to find the exact file:line, THEN read only that window with read_file(offset, limit). Do NOT read a whole file when a range will do.
  * With Serena, prefer find_symbol(include_body=false) to navigate; pull a body only when you must quote it.
  * Batch independent tool calls in ONE turn (you may emit several at once) instead of one-per-turn -- fewer round-trips means less re-sent history.
  * Never re-read something already in your context; cite it from the earlier result. (Older tool results may be collapsed to a stub -- if you truly need one again, re-run that tool.)
- PROVING ABSENCE: before you assert that something does NOT exist, is NEVER called, is missing, or is broken, you MUST search the ENTIRE workspace with grep using NO 'path' and NO 'glob' scope (the default '**/*'), AND list_dir the plausible directories. A negative result from a scoped/narrow search is NOT evidence of absence -- widen the search before claiming it. If after a full-workspace search you still find nothing, say "not found after full-workspace search" rather than asserting it cannot exist.
- If you genuinely cannot determine something, say so plainly instead of guessing.
- When you have the answer, reply with plain text and NO tool call. That ends your turn.`;

const LEAD_PROMPT = `You are the LEAD planner of "Suber Agent Team". You DECOMPOSE one research objective into independent subtasks that cheap scout workers can run in parallel.

Rules for good decomposition (from Anthropic's multi-agent research guidance):
- Scale effort to complexity: simple fact-finding = 1-3 subtasks; comparisons = 3-5; broad research = 5-10. Do NOT over-spawn.
- Each subtask must be SELF-CONTAINED: a clear objective, what to look at (files/globs/areas or what to search), and what to return. No overlap between subtasks; divide labor cleanly.
- Subtasks must be independently executable in parallel (no subtask depends on another's output).
- Do NOT call any tools. You are a PURE PLANNER: decompose from the objective text alone. The scout workers will do the actual file/grep/web investigation -- your only job is to produce the split.

PARTITION TOOLS PER SUBTASK (this is how a role stays in its lane). Give each subtask a "tools" allowlist holding ONLY the tools its role needs, chosen from AVAILABLE WORKER TOOLS (provided in the objective message). Typical roles:
- code/navigation -> read_file, grep, glob, list_dir, and Serena tools if present (get_symbols_overview, find_symbol, find_referencing_symbols, find_implementations, find_declaration, get_diagnostics_for_file)
- web research     -> web_search, web_fetch
- log/doc reading  -> read_file, grep, glob, list_dir
- scripting/verify -> bash, write_file, edit_file (plus read_file/grep)
A tight allowlist stops a "web" worker from quietly grepping code (or a "code" worker from web-fetching). If a role's core tool is NOT in AVAILABLE WORKER TOOLS, still create the subtask -- the worker will declare the capability missing rather than fabricate. Omit "tools" only when a subtask genuinely needs everything.

Output ONLY a JSON array and nothing else. Each element is EITHER a plain string (worker gets all tools) OR an object {"task": "...", "tools": ["..."]}. Example:
[{"task":"Audit the auth flow in src/auth/*.ts for token-refresh races; report file:line.","tools":["grep","read_file","find_symbol","find_referencing_symbols"]},{"task":"Find upstream CVEs/issues for library X published 2025-2026; return URLs.","tools":["web_search","web_fetch"]}]`;

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
  /** Pre-assembled toolset to reuse instead of building one (avoids a second slow Serena boot when
   *  the caller already assembled it -- e.g. runResearch shares one toolset across lead+scouts). */
  tools?: AgentTool[];
  /** Per-task tool allowlist, aligned by index with `tasks` (B3 role partitioning). Each entry
   *  restricts that worker to the named tools (intersection with the assembled toolset); undefined
   *  = full toolset. An allowlist that intersects to nothing falls back to the full toolset so a
   *  worker is never stranded with zero tools. */
  taskTools?: (string[] | undefined)[];
  /** Live-progress context (runId + phase + per-agent labels). Absent = no telemetry for this call. */
  progress?: ProgressContext;
}

/** Restrict a toolset to an allowlist of tool names (B3). Returns the FULL set when the allowlist
 *  is absent/empty or would leave the worker toolless -- a bad allowlist must never disable a
 *  worker; the worker then declares any genuinely missing capability per the CAPABILITY HONESTY rule. */
function filterTools(tools: AgentTool[], allow?: string[]): AgentTool[] {
  if (!allow || !allow.length) return tools;
  const set = new Set(allow);
  const kept = tools.filter((t) => set.has(t.name));
  return kept.length ? kept : tools;
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

  // Live progress (no-op when telemetry is off): announce this agent, stream its tool calls.
  const pc = opts.progress;
  const label = pc?.labels?.[index] ?? task;
  const started = Date.now();
  if (pc) emit({ kind: "agent_start", runId: pc.runId, phase: pc.phase, agent: index, label });
  const toolHooks: ToolHooks | undefined = pc
    ? {
        onStart: (tool, args) =>
          emit({ kind: "tool_start", runId: pc.runId, phase: pc.phase, agent: index, tool, toolArgs: summarizeArgs(args) }),
        onEnd: (tool, ok, output) =>
          emit({ kind: "tool_end", runId: pc.runId, phase: pc.phase, agent: index, tool, ok, toolResult: summarizeResult(output) }),
      }
    : undefined;

  let result: FleetAgentResult;
  try {
    const r = await provider.runAgent({
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      model,
      maxTokens: opts.maxTokens,
      thinkingBudget: opts.thinkingBudget,
      toolHooks,
    });
    // A worker that ran out of turns produced no real answer -- count it as a failure (and surface
    // why) instead of letting the sentinel masquerade as a successful result in the stats.
    const incomplete = r.stopReason === "max_iterations";
    result = {
      index,
      task,
      ok: !incomplete,
      text: r.text,
      error: incomplete ? "worker reached max iterations without a final answer" : undefined,
      iterations: r.iterations,
      toolCalls: r.toolCalls,
      textToolFallback: r.textToolFallback,
      usage: r.usage,
    };
  } catch (e) {
    result = {
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
  if (pc) {
    emit({
      kind: "agent_end",
      runId: pc.runId,
      phase: pc.phase,
      agent: index,
      ok: result.ok,
      error: result.error,
      toolCalls: result.toolCalls,
      durationMs: Date.now() - started,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
    });
  }
  return result;
}

/** Bounded-concurrency parallel map over tasks. */
export async function runFleet(
  config: FleetConfig,
  tasks: string[],
  opts: FleetOptions = {},
): Promise<FleetAgentResult[]> {
  const provider = createProvider(config);
  const tools = opts.tools ?? (await assembleToolset(config, opts.root));
  const model = opts.model || config.model;
  const limit = Math.max(1, Math.min(config.maxConcurrency, tasks.length));

  // Pre-list every agent as a queued row so the viewer shows the whole plan up front.
  if (opts.progress) {
    const pc = opts.progress;
    emit({ kind: "plan", runId: pc.runId, phase: pc.phase, labels: tasks.map((t, i) => pc.labels?.[i] ?? t) });
  }

  const results: FleetAgentResult[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      if (task === undefined) return;
      // Per-worker tool partitioning (B3): a code role sees only code tools, a web role only web tools, etc.
      results[i] = await runOne(provider, filterTools(tools, opts.taskTools?.[i]), i, task, model, opts);
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
  /** Run id for live progress (the map/reduce phases derive their own contexts from it). */
  runId?: string;
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
  const runId = opts.runId;
  const mapTasks = items.map((it) => `${mapPrompt}\n\n--- ITEM ---\n${it}`);
  const mapped = await runFleet(config, mapTasks, {
    model: opts.model ?? config.models.scout,
    sharedContext: opts.sharedContext,
    maxTokens: opts.maxTokens,
    // Show the original items as row labels, not the giant map prompt prepended to each.
    progress: runId ? { runId, phase: "map", labels: items } : undefined,
  });

  const combined = mapped
    .map((r) => `### Item ${r.index + 1}${r.ok ? "" : " (FAILED)"}\n${r.ok ? r.text : r.error}`)
    .join("\n\n");

  const reduceTask = `${reducePrompt}\n\n--- COLLECTED RESULTS FROM ${items.length} ITEMS ---\n${combined}`;
  const reduced = await runSingle(config, reduceTask, {
    model: opts.reduceModel ?? config.models.synth,
    maxTokens: config.synthMaxTokens,
    thinkingBudget: config.thinkingBudget,
    progress: runId ? { runId, phase: "synth", labels: ["reduce: synthesize"] } : undefined,
  });
  return { mapped, reduced };
}

/** A "[suber] ..." line is an internal status/sentinel (e.g. the max-iterations message), never a
 *  real subtask. Drop it so a failed lead can't smuggle its error string into the plan. */
function isSuberStatus(s: string): boolean {
  return /^\[suber\]/i.test(s.trim());
}

/** One planned subtask. `tools`, when present, is the per-worker allowlist (B3 role partitioning):
 *  it RESTRICTS that worker to the named tools (intersection with the assembled toolset), never
 *  broadens. Absent = the worker gets the full toolset. */
export interface PlannedSubtask {
  task: string;
  tools?: string[];
}

/** Parse the lead's plan: a JSON array of subtask strings or {task, tools} objects (graceful fallbacks). */
export function parsePlan(text: string, max: number): PlannedSubtask[] {
  const clean = text.trim();
  // Prefer the first JSON array in the text.
  const match = clean.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]) as unknown[];
      const tasks = arr
        .map((x): PlannedSubtask | null => {
          if (typeof x === "string") return { task: x.trim() };
          if (x && typeof x === "object" && "task" in x) {
            const o = x as { task: unknown; tools?: unknown };
            const tools = Array.isArray(o.tools)
              ? o.tools.map((t) => String(t).trim()).filter(Boolean)
              : undefined;
            return { task: String(o.task).trim(), tools: tools && tools.length ? tools : undefined };
          }
          return null;
        })
        .filter((s): s is PlannedSubtask => !!s && s.task.length > 0 && !isSuberStatus(s.task));
      if (tasks.length) return tasks.slice(0, max);
    } catch {
      /* fall through */
    }
  }
  // Fallback: numbered/bulleted lines (prose gives us no tool allowlist).
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((l) => l.length > 8 && !isSuberStatus(l))
    .map((task): PlannedSubtask => ({ task }));
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
  /** Run id for live progress; each phase (lead/scout/skeptic/synth) derives its own context. */
  runId?: string;
}

export interface ResearchResult {
  objective: string;
  plan: PlannedSubtask[];
  lead: FleetAgentResult;
  mapped: FleetAgentResult[];
  /** Adversarial refutation pass. Present only when opts.verify is true. */
  skeptic?: FleetAgentResult;
  synthesis: FleetAgentResult;
}

const SKEPTIC_PROMPT = `You are the SKEPTIC of "Suber Agent Team". Your ONLY job is to try to REFUTE the findings below, not to agree with them.
You have the same tools as the scouts (read_file, grep, glob, list_dir, web_fetch, and Serena symbol tools if present).

Method:
- REFUTED NEEDS POSITIVE COUNTER-EVIDENCE (asymmetric burden -- this is what stops you from dropping a TRUE finding):
  * Tag a claim REFUTED ONLY when you hold positive counter-evidence at a specific file:line/value that makes it FALSE (the claim says "X is missing" but you FOUND X at path:line; the claim says a value is N but you read M). REFUTED = "I found proof it's wrong", never "I couldn't find proof it's right".
  * NEVER tag REFUTED just because YOUR search found nothing. Failed-to-find = UNCONFIRMED, never REFUTED. Absence of evidence is NOT evidence of absence: a grep misses on a wrong pattern, casing, a multi-line span, or a glob that skipped the file. Concluding "X does not exist" from one empty grep is the most damaging mistake you can make -- it deletes a correct finding.
  * BEFORE you assert "X does not exist / zero matches" about any symbol/function/identifier a finding RELIES ON, you MUST: (a) try >=2 different grep patterns (the bare name, then a looser variant); (b) if Serena tools are present, call find_symbol / get_symbols_overview -- the LSP is AUTHORITATIVE and resolves definitions a text grep can miss; and (c) read the cited file around the cited line. Only if symbol-search AND >=2 greps AND the file read ALL come up empty may you say "not found after symbol+grep search" -- and that is UNCONFIRMED, not REFUTED.
- ONE SEARCH PER MISSING-CLAIM (do NOT batch): enumerate EVERY scout claim of the form "X does not exist / is missing / is absent / is never called / is broken / lacks Y / has no Z" as a SEPARATE item, and run its OWN grep across the ENTIRE workspace with NO 'path' and NO 'glob' scope (default '**/*'), plus list_dir of plausible directories. A search that found nothing for claim A is NOT evidence about claim B. If a search FINDS the thing -> that missing-claim is REFUTED (record the file:line that disproves it -- positive counter-evidence). If your search ALSO finds nothing, the missing-claim stays UNCONFIRMED (your miss does not prove the absence).
- DOC-SOURCED claims: if a claim's only evidence is a doc / comment / postmortem / changelog / audit note (not current code), RE-CHECK the current code. If the current code already does the right thing (positive counter-evidence), mark REFUTED (the doc described a since-fixed state). If you cannot locate it after symbol+grep search, mark UNCONFIRMED. A doc citation alone NEVER confirms a current bug.
- For every other claim: check it is backed by concrete evidence (exact file:line / URL / value) that actually says what the claim says.
- UNVERIFIABLE-from-tools: type signatures, version numbers, GitHub/issue IDs, external/web facts, and anything tagged [from-memory] or [inferred] are UNCONFIRMED unless a tool result in the evidence shows them verbatim.

Output a terse report, one line per claim, each tagged exactly one of:
  REFUTED: <claim> -- POSITIVE counter-evidence at <file:line/value> (NEVER use REFUTED for "couldn't find it")
  CONFIRMED: <claim> -- evidence at <file:line/URL>
  UNCONFIRMED: <claim> -- no concrete evidence either way after symbol+grep search (or doc-only / from-memory / unverifiable)
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
  const scoutModel = opts.scoutModel ?? config.models.scout;
  const synthModel = opts.synthModel ?? config.models.synth;
  const maxSubagents = Math.max(1, Math.min(opts.maxSubagents ?? 8, config.maxConcurrency * 2));
  const runId = opts.runId;

  // Assemble the toolset ONCE: (a) the lead is told which tools exist so it can hand each subtask a
  // real allowlist (B3), and (b) the scout fan-out reuses it so Serena's slow LSP boot happens once.
  const tools = await assembleToolset(config, opts.root);
  const toolNames = tools.map((t) => t.name);

  // 1. LEAD decomposes.
  const leadPrompt =
    (opts.context ? `Shared context:\n${opts.context}\n\n` : "") +
    `Research objective:\n${objective}\n\n` +
    `AVAILABLE WORKER TOOLS (pick each subtask's "tools" allowlist from these): ${toolNames.join(", ")}\n\n` +
    `Decompose into at most ${maxSubagents} independent subtasks.`;
  const leadStart = Date.now();
  if (runId) emit({ kind: "agent_start", runId, phase: "lead", agent: 0, label: "decompose objective" });
  let lead: FleetAgentResult;
  try {
    // The lead is a PURE PLANNER: give it NO tools so a reasoning model can't rabbit-hole into a
    // tool loop (and hit max-iterations, which used to feed the sentinel straight into the plan).
    const r = await provider.runAgent({
      system: LEAD_PROMPT,
      prompt: leadPrompt,
      tools: [],
      model: synthModel,
      maxTokens: config.synthMaxTokens,
      thinkingBudget: config.thinkingBudget,
    });
    const incomplete = r.stopReason === "max_iterations";
    lead = {
      index: 0,
      task: "[lead] decompose",
      ok: !incomplete,
      text: r.text,
      error: incomplete ? "lead reached max iterations without a plan" : undefined,
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

  if (runId) {
    emit({
      kind: "agent_end",
      runId,
      phase: "lead",
      agent: 0,
      ok: lead.ok,
      error: lead.error,
      toolCalls: lead.toolCalls,
      durationMs: Date.now() - leadStart,
      tokensIn: lead.usage.inputTokens,
      tokensOut: lead.usage.outputTokens,
    });
  }

  const plan = lead.ok ? parsePlan(lead.text, maxSubagents) : [];
  // If decomposition failed, fall back to running the objective as a single subtask (full toolset).
  const subtasks: PlannedSubtask[] = plan.length ? plan : [{ task: objective }];

  // 2. scout-tier fan-out. Reuse the assembled toolset and hand each worker its role allowlist (B3).
  const mapped = await runFleet(config, subtasks.map((s) => s.task), {
    model: scoutModel,
    sharedContext: opts.context,
    maxTokens: config.maxTokens,
    root: opts.root,
    tools,
    taskTools: subtasks.map((s) => s.tools),
    progress: runId ? { runId, phase: "scout" } : undefined,
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
      progress: runId ? { runId, phase: "skeptic", labels: ["refute findings"] } : undefined,
    });
  }

  const verifyClause = opts.verify
    ? "\nVERIFY using the SKEPTIC REPORT below: DROP a REFUTED claim ONLY when the skeptic cited POSITIVE counter-evidence (a file:line/value showing it false). A 'REFUTED' that rests on 'not found / zero matches' with NO positive counter-evidence is NOT a refutation -- KEEP that finding (a failed search never disproves a finding that carries its own [verified: file:line] evidence) and just note the skeptic could not re-locate it. Move every UNCONFIRMED claim into a 'Unverified / needs follow-up' section. Keep CONFIRMED findings (and uncontested ones backed by concrete evidence) in the main answer."
    : "";
  // These guards apply WHETHER OR NOT verify ran -- they stop the two failure modes that produce
  // confident-but-false bugs: a doc that described a since-fixed problem (B1), and an unchecked
  // "X is missing" assertion (B2). A scout can't smuggle either into the confirmed section.
  const synthGuards =
    "\nGUARDRAILS (always):\n" +
    "- DOC-CLAIM demotion (B1): any finding whose only evidence is a doc/comment/postmortem/changelog/audit-note (no CURRENT-code file:line) goes to 'Unverified / needs follow-up' tagged DOC-CLAIM -- NEVER into a confirmed-bug section. A doc describing a problem is not proof the code still has it.\n" +
    "- MISSING-CLAIM demotion (B2): any finding of the form 'X is missing/absent/does not exist/never called' that is NOT backed by a fresh full-workspace negative grep in the evidence must be DEMOTED to 'Unverified', however confidently a scout stated it.\n" +
    "- EVIDENCE TIER (B5): only \\[verified: file:line] claims may appear as fact in the main answer; \\[inferred]/\\[from-memory] claims, type signatures, version numbers, and issue IDs go to 'Unverified' unless a tool result backs them.\n" +
    "- ARTIFACT FIDELITY (B4): if a subtask produced a script, patch, command, or command output, reproduce it VERBATIM inside a fenced code block -- do NOT paraphrase a deliverable into prose.\n" +
    "- CAPABILITY GAPS (B6): if any subtask reported 'CAPABILITY UNAVAILABLE: ...', add a 'Capability gaps (not investigated)' section listing exactly what could not be done and why -- never silently omit it or imply the work was done.";
  const skepticBlock =
    opts.verify && skeptic?.ok && skeptic.text
      ? `\n\n--- SKEPTIC REPORT (adversarial) ---\n${skeptic.text}`
      : "";
  const synthTask =
    `You are the LEAD synthesizer. Combine the subtask findings below into ONE coherent, cited answer to the objective.\n` +
    `Objective: ${objective}${verifyClause}${synthGuards}\n` +
    `Be concise and information-dense; preserve concrete evidence (file:line / URL). Drop filler and duplicates.\n\n` +
    `--- SUBTASK FINDINGS (${mapped.length}) ---\n${findings}${skepticBlock}`;
  const synthesis = await runSingle(config, synthTask, {
    model: synthModel,
    maxTokens: config.synthMaxTokens,
    thinkingBudget: config.thinkingBudget,
    root: opts.root,
    progress: runId ? { runId, phase: "synth", labels: ["synthesize findings"] } : undefined,
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
