/**
 * Live progress telemetry for the fleet (OFF by default; gated behind config.progress.enabled).
 *
 * WHY a file + separate viewer: the MCP server is a HEADLESS child of the orchestrator -- its
 * stdout is the JSON-RPC stream, so it cannot draw a UI itself. Instead, when progress is on,
 * every fleet milestone and every worker tool call is appended as one JSONL line to
 * <workspaceRoot>/.suber/progress.jsonl. A separate `suber watch` viewer (watch.ts) tails that
 * file and renders a live TUI in its OWN terminal window. The server lazily spawns ONE such
 * window per session (reused across runs, never one-per-agent) and the viewer self-closes when
 * the fleet goes idle -- so nothing lingers and the machine stays light.
 *
 * Discipline: NOTHING here writes to stdout (it carries MCP). Events go to the file; the only
 * diagnostics go to stderr. When disabled, `emit()` is a no-op with effectively zero cost.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import type { FleetConfig } from "./config.js";

export type ProgressKind =
  | "run_start"
  | "run_end"
  | "plan"
  | "agent_start"
  | "agent_end"
  | "tool_start"
  | "tool_end"
  | "session_end";

/** One line in progress.jsonl. Optional fields are populated per `kind`. */
export interface ProgressEvent {
  ts: number;
  kind: ProgressKind;
  runId: string;
  /** research | fanout | map_reduce | delegate (on run_start). */
  runKind?: string;
  /** Short human descriptor of the run (on run_start). */
  title?: string;
  /** Phase within a run: lead | scout | map | worker | skeptic | synth. */
  phase?: string;
  /** Agent index within its phase. */
  agent?: number;
  /** Per-agent display label. */
  label?: string;
  /** Labels for ALL agents of a phase (on plan), so the viewer can pre-list queued rows. */
  labels?: string[];
  /** Tool activity. */
  tool?: string;
  toolArgs?: string;
  toolResult?: string;
  ok?: boolean;
  error?: string;
  toolCalls?: number;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Threaded through a fleet call so every event it emits shares one runId + phase.
 * `labels` are index-aligned display names; a worker falls back to its task text when absent
 * (single-agent phases like skeptic/synth set a clean one-element label so the giant assembled
 * prompt never shows up as the row title).
 */
export interface ProgressContext {
  runId: string;
  phase: string;
  labels?: string[];
}

/** Per-tool-call hooks handed to the provider loop; fire around each executeTool. */
export interface ToolHooks {
  onStart?: (tool: string, args: Record<string, unknown>) => void;
  onEnd?: (tool: string, ok: boolean, output: string) => void;
}

// ---------------------------------------------------------------------------
// Singleton sink. The whole process shares one writer + one lazy watch window.
// ---------------------------------------------------------------------------

class Sink {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly stream: fs.WriteStream;
  private lastSpawn = 0;
  private closed = false;

  constructor(private readonly config: FleetConfig) {
    const dir = path.join(config.workspaceRoot, ".suber");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "progress.jsonl");
    this.lockFile = path.join(dir, "watch.pid");
    // Fresh file each session so a viewer launched mid-session doesn't replay stale runs forever.
    this.stream = fs.createWriteStream(this.file, { flags: "w" });
  }

  write(event: ProgressEvent): void {
    if (this.closed) return;
    try {
      this.stream.write(JSON.stringify(event) + "\n");
    } catch {
      /* best-effort telemetry: never let a write failure break the fleet */
    }
    // Spawn (or reuse) the watch window the moment a run begins.
    if (event.kind === "run_start") this.ensureWindow();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stream.end();
    } catch {
      /* ignore */
    }
  }

  /** Spawn the watch window unless one is already alive (or just launched). */
  private ensureWindow(): void {
    if (!this.config.progress.window) return;
    if (this.isWatcherAlive()) return;
    // The watcher takes ~1s to boot + write its lockfile; debounce so back-to-back run_starts
    // in that window don't pop a second terminal.
    if (Date.now() - this.lastSpawn < 4000) return;
    this.lastSpawn = Date.now();
    try {
      openWindow(watcherLaunchArgv(this.file));
    } catch (e) {
      process.stderr.write(`[Suber] could not open the watch window: ${(e as Error).message}\n`);
    }
  }

  /** True iff the lockfile names a live process (the running viewer). */
  private isWatcherAlive(): boolean {
    try {
      const pid = Number(fs.readFileSync(this.lockFile, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0); // signal 0 = existence check; throws if the pid is gone
      return true;
    } catch (e) {
      // EPERM means the process exists but we can't signal it -> still alive.
      return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
  }
}

let sink: Sink | null = null;

/** Initialize telemetry from config. No-op (and zero overhead afterwards) when disabled. */
export function initProgress(config: FleetConfig): void {
  if (!config.progress.enabled) return;
  try {
    sink = new Sink(config);
  } catch (e) {
    process.stderr.write(`[Suber] progress telemetry disabled (init failed): ${(e as Error).message}\n`);
    sink = null;
  }
}

export function progressOn(): boolean {
  return sink !== null;
}

/** Append one event (timestamp is stamped here). Cheap no-op when telemetry is off. */
export function emit(e: Omit<ProgressEvent, "ts">): void {
  if (!sink) return;
  sink.write({ ...e, ts: Date.now() });
}

/** Write the session-end sentinel (so the viewer can close promptly) and stop writing. */
export function shutdownProgress(): void {
  if (!sink) return;
  emit({ kind: "session_end", runId: "" });
  sink.close();
  sink = null;
}

// ---------------------------------------------------------------------------
// Compact summarizers (used to keep tool_start/tool_end lines short & readable).
// ---------------------------------------------------------------------------

/** "pattern="useAuth" glob="**\/*.ts"" -- the salient scalar args, capped. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null || typeof v === "object") continue;
    let val = String(v);
    if (val.length > 40) val = val.slice(0, 39) + "…";
    parts.push(typeof v === "string" ? `${k}="${val}"` : `${k}=${val}`);
    if (parts.join(" ").length > 70) break;
  }
  const s = parts.join(" ");
  return s.length > 72 ? s.slice(0, 71) + "…" : s;
}

/** "12 lines" / first error line / short value -- enough to glance at, never the full blob. */
export function summarizeResult(out: string): string {
  if (!out) return "";
  const first = out.split("\n")[0] ?? "";
  if (out.startsWith("Error:") || out.startsWith("[command failed]") || /tool error/i.test(first)) {
    return first.slice(0, 60);
  }
  const lines = out.split("\n").length;
  if (lines > 1) return `${lines} lines`;
  return first.length > 50 ? first.slice(0, 49) + "…" : first;
}

// ---------------------------------------------------------------------------
// Window spawning. Re-invoke THIS executable's `watch` subcommand in a new console.
// ---------------------------------------------------------------------------

/**
 * Argv to relaunch ourselves as the viewer. Handles BOTH ways Suber runs:
 *   - node:  process.argv = [node, dist/index.js, ...]  -> keep the script path
 *   - bun single-file exe: no script arg               -> just the exe + subcommand
 */
function watcherLaunchArgv(file: string): string[] {
  const script = process.argv[1];
  const isScript = !!script && /\.(c?js|mjs|ts)$/i.test(script);
  return isScript
    ? [process.execPath, script, "watch", "--file", file]
    : [process.execPath, "watch", "--file", file];
}

function hasCmd(cmd: string): boolean {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Open a NEW, visible terminal window running `argv`. The window closes by itself when the viewer
 * exits (we run the program directly, not via a keep-open shell). Returns false if no terminal
 * could be opened (the user can still run `suber watch` manually).
 */
function openWindow(argv: string[]): boolean {
  const title = "Suber Agent Team — live";
  const exe = argv[0];
  if (!exe) return false;
  const rest = argv.slice(1);

  if (process.platform === "win32") {
    // Classic console via `start` is the most reliable way to get a SEPARATE window that
    // closes on exit. (Windows Terminal would reuse an existing window/tab.)
    spawn("cmd", ["/c", "start", title, exe, ...rest], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
    return true;
  }

  if (process.platform === "darwin") {
    const inner = argv.map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(" ");
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(inner)}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return true;
  }

  // Linux: try common terminal emulators.
  for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    if (!hasCmd(term)) continue;
    const args = term === "gnome-terminal" ? ["--", ...argv] : ["-e", ...argv];
    spawn(term, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  return false;
}
