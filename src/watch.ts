/**
 * `suber-agent-team watch` -- the live viewer.
 *
 * Tails <workspaceRoot>/.suber/progress.jsonl (written by progress.ts when telemetry is on) and
 * renders a live TUI tree of the fleet: every run, every phase, every agent, and the tool each
 * agent is calling RIGHT NOW -- one window for the whole fleet, NOT one per agent.
 *
 * Lifecycle (so nothing lingers): the viewer writes a lockfile while alive, and self-exits when
 *   - it sees the session_end sentinel (server shut down), or
 *   - the fleet has been idle (no active run) past a short grace, or
 *   - the file has gone completely silent for a long stale timeout (crash safety).
 * Running the program directly (not via a keep-open shell) means exiting closes the window too.
 *
 * This process OWNS its stdout (it is not the MCP server), so it draws freely with ANSI.
 */
import fs from "node:fs";
import path from "node:path";

import { lockFileFor, type ProgressEvent } from "./progress.js";

// ---- timing knobs ----
const RENDER_MS = 120; // redraw + poll cadence
const IDLE_GRACE_MS = 8000; // close this long after the last run finishes
const STALE_MS = 120_000; // hard safety: close after this much total silence (covers a server crash)
const LINGER_AFTER_END_MS = 15_000; // keep a finished run on screen this long before hiding it

// ---- ANSI ----
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GREY = `${ESC}90m`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface AgentRow {
  phase: string;
  index: number;
  label: string;
  status: "queued" | "running" | "ok" | "fail";
  tool?: string; // current in-flight tool name
  toolArgs?: string;
  lastResult?: string; // "grep → 12 lines" from the most recent finished tool
  toolCalls: number;
  toolFails: number; // tool calls that returned an error (surfaced even when the agent ends ok)
  startTs?: number;
  endTs?: number;
  durationMs?: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
}

interface RunState {
  runId: string;
  runKind: string;
  title: string;
  startTs: number;
  endTs?: number;
  ok?: boolean;
  agents: Map<string, AgentRow>; // key = `${phase}#${index}`
  phaseOrder: string[];
}

const runs = new Map<string, RunState>();
const runOrder: string[] = [];

let lastEventTs = Date.now();
let idleSince: number | null = null;
let sessionEnded = false;
let frame = 0;
let lockFile = "";

const key = (phase: string, index: number) => `${phase}#${index}`;

function ensureRun(e: ProgressEvent): RunState {
  let r = runs.get(e.runId);
  if (!r) {
    r = {
      runId: e.runId,
      runKind: e.runKind ?? "run",
      title: e.title ?? "",
      startTs: e.ts,
      agents: new Map(),
      phaseOrder: [],
    };
    runs.set(e.runId, r);
    runOrder.push(e.runId);
  }
  return r;
}

function ensureRow(r: RunState, phase: string, index: number, label?: string): AgentRow {
  const k = key(phase, index);
  let row = r.agents.get(k);
  if (!row) {
    if (!r.phaseOrder.includes(phase)) r.phaseOrder.push(phase);
    row = { phase, index, label: label ?? "", status: "queued", toolCalls: 0, toolFails: 0, tokensIn: 0, tokensOut: 0 };
    r.agents.set(k, row);
  } else if (label) {
    row.label = label;
  }
  return row;
}

function apply(e: ProgressEvent): void {
  lastEventTs = Date.now();
  switch (e.kind) {
    case "session_end":
      sessionEnded = true;
      return;
    case "run_start":
      ensureRun(e);
      return;
    case "run_end": {
      const r = runs.get(e.runId);
      if (r) {
        r.endTs = e.ts;
        r.ok = e.ok;
      }
      return;
    }
    case "plan": {
      const r = ensureRun(e);
      const labels = e.labels ?? [];
      labels.forEach((label, i) => ensureRow(r, e.phase ?? "worker", i, label));
      return;
    }
    case "agent_start": {
      const r = ensureRun(e);
      const row = ensureRow(r, e.phase ?? "worker", e.agent ?? 0, e.label);
      row.status = "running";
      row.startTs = e.ts;
      return;
    }
    case "tool_start": {
      const r = ensureRun(e);
      const row = ensureRow(r, e.phase ?? "worker", e.agent ?? 0);
      row.tool = e.tool;
      row.toolArgs = e.toolArgs;
      return;
    }
    case "tool_end": {
      const r = ensureRun(e);
      const row = ensureRow(r, e.phase ?? "worker", e.agent ?? 0);
      row.toolCalls++;
      if (e.ok === false) row.toolFails++;
      row.lastResult = `${e.tool ?? "tool"}${e.ok === false ? " ✗" : ""} → ${e.toolResult ?? ""}`.trim();
      row.tool = undefined;
      row.toolArgs = undefined;
      return;
    }
    case "agent_end": {
      const r = ensureRun(e);
      const row = ensureRow(r, e.phase ?? "worker", e.agent ?? 0, e.label);
      row.status = e.ok ? "ok" : "fail";
      row.endTs = e.ts;
      row.durationMs = e.durationMs;
      if (typeof e.toolCalls === "number") row.toolCalls = e.toolCalls;
      row.tokensIn = e.tokensIn ?? row.tokensIn;
      row.tokensOut = e.tokensOut ?? row.tokensOut;
      row.error = e.error;
      row.tool = undefined;
      row.toolArgs = undefined;
      return;
    }
  }
}

// ---- rendering helpers ----

function termCols(): number {
  return Math.max(40, process.stdout.columns || 80);
}

/** Truncate to visible width (input must be plain text, no ANSI). */
function clip(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + "…";
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function statusIcon(row: AgentRow): string {
  switch (row.status) {
    case "ok":
      return `${GREEN}✓${RESET}`;
    case "fail":
      return `${RED}✗${RESET}`;
    case "running":
      return `${CYAN}${SPINNER[frame % SPINNER.length]}${RESET}`;
    default:
      return `${GREY}·${RESET}`;
  }
}

function render(): void {
  const now = Date.now();
  const cols = termCols();
  const out: string[] = [];

  // Only show runs that are active or finished recently (keeps the screen focused).
  const visible = runOrder
    .map((id) => runs.get(id))
    .filter((r): r is RunState => !!r && (!r.endTs || now - r.endTs < LINGER_AFTER_END_MS));

  out.push(`${BOLD}${CYAN} Suber Agent Team — live fleet${RESET}${GREY}   (auto-closes when idle · q to quit)${RESET}`);

  if (!visible.length) {
    out.push("");
    out.push(`${GREY}   waiting for the fleet…${RESET}`);
  }

  for (const r of visible) {
    const dur = fmtDur((r.endTs ?? now) - r.startTs);
    const rows = [...r.agents.values()];
    const running = rows.filter((a) => a.status === "running").length;
    const done = rows.filter((a) => a.status === "ok").length;
    const failed = rows.filter((a) => a.status === "fail").length;
    const calls = rows.reduce((n, a) => n + a.toolCalls, 0);
    const toolErrs = rows.reduce((n, a) => n + a.toolFails, 0);
    const tin = rows.reduce((n, a) => n + a.tokensIn, 0);
    const tout = rows.reduce((n, a) => n + a.tokensOut, 0);
    const head = r.endTs ? (r.ok ? `${GREEN}done${RESET}` : `${RED}done (error)${RESET}`) : `${YELLOW}${dur}${RESET}`;

    out.push("");
    out.push(` ${GREY}┌─${RESET} ${BOLD}${r.runKind}${RESET} ${head}`);
    if (r.title) out.push(` ${GREY}│${RESET}  ${DIM}${clip(r.title, cols - 5)}${RESET}`);

    for (const phase of r.phaseOrder) {
      const inPhase = rows.filter((a) => a.phase === phase).sort((a, b) => a.index - b.index);
      const total = inPhase.length;
      for (const a of inPhase) {
        const tag = `${phase} ${a.index + 1}/${total}`;
        // tokens + duration on finished rows so an expensive agent (e.g. the skeptic) is obvious.
        const dur = a.durationMs ?? (a.endTs && a.startTs ? a.endTs - a.startTs : 0);
        const stats = `${GREY}· ${a.toolCalls} calls · ${fmtDur(dur)} · ${fmtTokens(a.tokensIn)}/${fmtTokens(a.tokensOut)} tok${RESET}`;
        const warn = a.toolFails > 0 ? ` ${YELLOW}⚠${a.toolFails}${RESET}` : "";
        // Right-aligned status blurb.
        let right: string;
        if (a.status === "running") right = `${YELLOW}${fmtDur(now - (a.startTs ?? now))}${RESET}${warn}`;
        else if (a.status === "ok") right = `${GREEN}ok${RESET} ${stats}${warn}`;
        else if (a.status === "fail") right = `${RED}fail${RESET} ${stats}${warn}`;
        else right = `${GREY}queued${RESET}`;

        const left = ` ${GREY}│${RESET} ${statusIcon(a)} ${CYAN}${tag}${RESET}  ${clip(a.label || "(task)", cols - 44)}`;
        out.push(`${left}  ${right}`);

        // Nested live activity line (only while running).
        if (a.status === "running" && a.tool) {
          const act = `${a.tool}${a.toolArgs ? " " + a.toolArgs : ""}`;
          out.push(` ${GREY}│     └ ${RESET}${DIM}${clip(act, cols - 9)}${RESET}`);
        } else if (a.status === "running" && a.lastResult) {
          out.push(` ${GREY}│     └ ${RESET}${GREY}${clip(a.lastResult, cols - 9)}${RESET}`);
        }
      }
    }

    out.push(
      ` ${GREY}└─${RESET} ${running} running · ${GREEN}${done} done${RESET} · ` +
        `${failed ? RED : GREY}${failed} fail${RESET} · ${calls} tool calls` +
        (toolErrs ? ` · ${YELLOW}⚠${toolErrs} tool errs${RESET}` : "") +
        ` · ${GREY}~${fmtTokens(tin)}/${fmtTokens(tout)} tok (fleet)${RESET}`,
    );
  }

  // Draw: home, overwrite each line clearing to EOL, then clear everything below.
  let buf = `${ESC}H`;
  for (const line of out) buf += line + `${ESC}K\n`;
  buf += `${ESC}J`;
  process.stdout.write(buf);
}

// ---- file tailing ----

let readOffset = 0;
let carry = "";

function poll(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // file not created yet
  }
  if (stat.size < readOffset) {
    // truncated/rotated -> restart from the top
    readOffset = 0;
    carry = "";
  }
  if (stat.size <= readOffset) return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const len = stat.size - readOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, readOffset);
    readOffset = stat.size;
    carry += buf.toString("utf8");
  } catch {
    return;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  let nl: number;
  while ((nl = carry.indexOf("\n")) >= 0) {
    const line = carry.slice(0, nl).trim();
    carry = carry.slice(nl + 1);
    if (!line) continue;
    try {
      apply(JSON.parse(line) as ProgressEvent);
    } catch {
      /* ignore a malformed/partial line */
    }
  }
}

function activeRunCount(): number {
  let n = 0;
  for (const r of runs.values()) if (!r.endTs) n++;
  return n;
}

let exiting = false;
function shutdown(): void {
  if (exiting) return;
  exiting = true;
  try {
    process.stdout.write(`${ESC}?25h\n`); // show cursor
  } catch {
    /* ignore */
  }
  try {
    if (lockFile && fs.existsSync(lockFile)) fs.rmSync(lockFile);
  } catch {
    /* ignore */
  }
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

/** Resolve the telemetry file from --file, env, or the default under the cwd. */
export function resolveWatchFile(argv: string[]): string {
  const i = argv.indexOf("--file");
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1] as string);
  if (process.env.SUBER_PROGRESS_FILE) return path.resolve(process.env.SUBER_PROGRESS_FILE);
  return path.resolve(process.cwd(), ".suber", "progress.jsonl");
}

/** Entry point for the `watch` subcommand. Blocks (renders) until idle/end, then exits. */
export function runWatch(argv: string[]): void {
  const file = resolveWatchFile(argv);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  // Derive the lockfile from the file path so it pairs with THIS server's progress-<pid>.jsonl
  // (the server checks the exact same name before deciding whether to spawn a window).
  lockFile = lockFileFor(file);
  try {
    fs.writeFileSync(lockFile, String(process.pid));
  } catch {
    /* ignore */
  }

  process.on("exit", () => {
    try {
      if (lockFile && fs.existsSync(lockFile)) fs.rmSync(lockFile);
    } catch {
      /* ignore */
    }
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Quit on 'q' / Ctrl-C without waiting for idle.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (d) => {
        const s = d.toString("utf8");
        if (s === "q" || s === "\x03") shutdown();
      });
    } catch {
      /* ignore */
    }
  }

  process.stdout.write(`${ESC}?25l`); // hide cursor
  process.stdout.write(`${ESC}2J`); // clear once at start

  const tick = (): void => {
    if (exiting) return;
    poll(file);
    frame++;
    render();

    const now = Date.now();
    const active = activeRunCount();
    if (active > 0) idleSince = null;
    else if (idleSince === null) idleSince = now;

    if (sessionEnded) {
      render();
      setTimeout(shutdown, 1500);
      return;
    }
    if (idleSince !== null && runs.size > 0 && now - idleSince > IDLE_GRACE_MS) return shutdown();
    if (now - lastEventTs > STALE_MS) return shutdown();
  };

  const timer = setInterval(tick, RENDER_MS);
  // Don't keep the loop alive purely on the timer if everything else is gone.
  if (typeof timer.unref === "function") {
    /* keep it referenced: we WANT to stay alive until an exit condition fires */
  }
}
