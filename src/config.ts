/**
 * Suber Agent Team - configuration loading.
 *
 * Precedence (low -> high): DEFAULTS  <  preset  <  config file  <  environment variables.
 * Every field has a SUBER_* env override so the server works with zero config files.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import orbitAnthropic from "../presets/orbit-anthropic.json" with { type: "json" };
import orbitOpenai from "../presets/orbit-openai.json" with { type: "json" };
import orbitTiered from "../presets/orbit-tiered.json" with { type: "json" };

export type Provider = "anthropic" | "openai";
export type AuthStyle = "bearer" | "x-api-key";
export type Tier = "scout" | "worker" | "synth";
export type SerenaMode = "auto" | "on" | "off";

/**
 * Serena (semantic LSP vision) integration. Suber connects to a SEPARATELY installed Serena
 * as an MCP client and exposes a read-only allowlist of its symbol-level tools to workers.
 *   - "auto": attach if Serena is reachable, else silently fall back to textual tools.
 *   - "on"  : always attempt to attach; log loudly if it fails.
 *   - "off" : disabled.
 */
export interface SerenaSettings {
  mode: SerenaMode;
  /** Command launching Serena's MCP server (default "serena"; resolved on PATH). */
  command: string;
  /** Serena context to run under (default "agent"). */
  context: string;
  /** Read-only Serena tools exposed to workers (the vision allowlist). */
  tools: string[];
}

export interface Capabilities {
  write: boolean;
  bash: boolean;
}

/**
 * Live progress telemetry (OFF by default). When enabled, the fleet writes a JSONL event stream
 * of every milestone + worker tool call, and a separate `suber watch` viewer renders it live in
 * its own terminal window. See progress.ts / watch.ts.
 *   - enabled: master switch. Off = zero overhead (no events, no file, no window).
 *   - window : auto-spawn (and self-close) the watch window when a run starts. Turn it off to drive
 *              the viewer yourself with `suber-agent-team watch`.
 */
export interface ProgressSettings {
  enabled: boolean;
  window: boolean;
}

/**
 * Heterogeneous model tiers. The orchestrator-worker power move (Anthropic's
 * Research system: Opus lead + Sonnet workers, +90.2%) is to run cheap scouts for
 * breadth and a smarter model for planning/synthesis. With Orbit, ALL tiers still
 * bill to Orbit, not your main account.
 *   - scout : cheapest, breadth fan-out (default for `fanout`)
 *   - worker: mid reasoning, one focused task (default for `delegate`)
 *   - synth : smartest, decomposition + reduce/verify (lead for `research`, reduce for `map_reduce`)
 */
export interface ModelTiers {
  scout: string;
  worker: string;
  synth: string;
}

export interface FleetConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  authStyle: AuthStyle;
  anthropicVersion: string;
  /** Optional Tavily API key. When set, workers gain a web_search tool (query -> results). */
  tavilyApiKey: string;
  /** Legacy single model. Used as the fallback for every tier when a tier is unset. */
  model: string;
  /** Resolved per-role models. Defaults to `model` for any tier not explicitly set. */
  models: ModelTiers;
  maxConcurrency: number;
  maxIterationsPerAgent: number;
  /**
   * Hard cap on the characters of a SINGLE tool result entering the message history. The full
   * history is re-sent on every turn (cheap providers usually have no prompt caching), so a fat
   * result is paid for again on each later turn. Keep it tight. Default 10000 (~2.5K tokens).
   */
  maxToolResultChars: number;
  /**
   * Sliding-window size: how many of the MOST RECENT tool results stay verbatim in history.
   * Older ones are collapsed to a one-line stub (the model is told to re-run the tool if it needs
   * them again), turning the per-turn context from linear-growing into ~constant. Default 3.
   * 0 disables compaction (keep everything verbatim).
   */
  toolResultWindow: number;
  /** Response token cap for scout/worker turns. */
  maxTokens: number;
  /** Response token cap for the synth tier (decompose + reduce). Bigger by design. */
  synthMaxTokens: number;
  /** Extended-thinking budget (Anthropic only). 0 = off. Applied to worker/synth tiers. */
  thinkingBudget: number;
  /** Transient-error retry attempts (429/5xx/network) on top of the first try. */
  retryAttempts: number;
  /** Base backoff in ms (exponential with jitter). */
  retryBaseMs: number;
  /** Client-side request cap (per process, per base URL) so a fan-out self-paces under provider limits. 0 = off. */
  requestsPerMinute: number;
  requestsPerSecond: number;
  workspaceRoot: string;
  /** Read-only scout tools exposed to every worker. */
  tools: string[];
  capabilities: Capabilities;
  acknowledgeDangerous: boolean;
  /** Serena semantic-vision integration (read-only LSP tools for workers). */
  serena: SerenaSettings;
  /** Live progress telemetry + watch window (off by default). */
  progress: ProgressSettings;
  /** Non-fatal notes surfaced in the startup banner. */
  warnings: string[];
}

const PRESETS: Record<string, Partial<FleetConfig>> = {
  "orbit-anthropic": orbitAnthropic as unknown as Partial<FleetConfig>,
  "orbit-openai": orbitOpenai as unknown as Partial<FleetConfig>,
  "orbit-tiered": orbitTiered as unknown as Partial<FleetConfig>,
};

const SCOUT_TOOLS = ["read_file", "glob", "list_dir", "grep", "web_fetch"];

/** Default read-only Serena tools (symbol-level "vision"). Editing/exec tools are intentionally excluded. */
const SERENA_VISION_TOOLS = [
  "find_symbol",
  "get_symbols_overview",
  "find_referencing_symbols",
  "find_implementations",
  "find_declaration",
  "get_diagnostics_for_file",
];

function envStr(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? undefined : v;
}

function envNum(key: string): number | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(key: string): boolean | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Parse a Serena mode from an env/file value (bool, "auto", or on/off synonyms). */
function parseSerenaMode(v: unknown): SerenaMode | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v ? "on" : "off";
  const s = String(v).trim().toLowerCase();
  if (s === "auto") return "auto";
  if (/^(on|1|true|yes)$/.test(s)) return "on";
  if (/^(off|0|false|no)$/.test(s)) return "off";
  return undefined;
}

/**
 * Strip // line comments and block comments so config files can be JSONC -- settings
 * up top, plain-language `// notes` underneath. String-aware: it leaves `//` inside
 * a value alone (so `"https://..."` and `"// key"` annotations survive untouched, which
 * keeps older comment-key config files parsing exactly as before).
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Failed to parse config file ${file}: ${(e as Error).message}`);
  }
}

function locateConfigFile(): Record<string, unknown> | undefined {
  const explicit = envStr("SUBER_CONFIG");
  if (explicit) {
    const found = readJsonFile(path.resolve(explicit));
    if (!found) throw new Error(`SUBER_CONFIG points to a missing file: ${explicit}`);
    return found;
  }
  // Discovery order (first match wins). The quick 3-field "settings" file
  // (baseUrl/apiKey/model) sits ABOVE the full "config" file at each scope, so the
  // everyday hot fields can live in one tiny file - copy suber.settings.example.json.
  // A 3-field settings file alone satisfies validation; everything else uses defaults.
  const candidates = [
    path.resolve(process.cwd(), "suber.config.local.json"),
    path.resolve(process.cwd(), "suber.settings.json"),
    path.resolve(process.cwd(), "suber.config.json"),
    path.join(os.homedir(), ".suber", "settings.json"),
    path.join(os.homedir(), ".suber", "config.json"),
  ];
  for (const c of candidates) {
    const found = readJsonFile(c);
    if (found) return found;
  }
  return undefined;
}

export function loadConfig(): FleetConfig {
  const fileCfg = locateConfigFile() ?? {};

  const presetName = envStr("SUBER_PRESET") ?? (fileCfg["preset"] as string | undefined);
  const preset = presetName ? PRESETS[presetName] : undefined;
  if (presetName && !preset) {
    throw new Error(
      `Unknown preset '${presetName}'. Available: ${Object.keys(PRESETS).join(", ")}`,
    );
  }

  const warnings: string[] = [];

  // ---- scalar merge (defaults < preset < file < env) ----
  const provider = (envStr("SUBER_PROVIDER") ??
    (fileCfg["provider"] as string | undefined) ??
    preset?.provider ??
    "anthropic") as Provider;

  const baseUrl = (envStr("SUBER_BASE_URL") ??
    (fileCfg["baseUrl"] as string | undefined) ??
    preset?.baseUrl ??
    "").replace(/\/+$/, "");

  const apiKey =
    envStr("SUBER_API_KEY") ??
    (fileCfg["apiKey"] as string | undefined) ??
    preset?.apiKey ??
    envStr("ANTHROPIC_AUTH_TOKEN") ??
    envStr("ANTHROPIC_API_KEY") ??
    envStr("OPENAI_API_KEY") ??
    "";

  let authStyle = (envStr("SUBER_AUTH_STYLE") ??
    (fileCfg["authStyle"] as string | undefined) ??
    preset?.authStyle) as AuthStyle | undefined;
  if (!authStyle) {
    authStyle = provider === "anthropic" && /api\.anthropic\.com/i.test(baseUrl) ? "x-api-key" : "bearer";
  }

  const anthropicVersion =
    envStr("SUBER_ANTHROPIC_VERSION") ??
    (fileCfg["anthropicVersion"] as string | undefined) ??
    preset?.anthropicVersion ??
    "2023-06-01";

  const tavilyApiKey =
    envStr("SUBER_TAVILY_API_KEY") ??
    (fileCfg["tavilyApiKey"] as string | undefined) ??
    envStr("TAVILY_API_KEY") ??
    "";

  const model =
    envStr("SUBER_MODEL") ??
    (fileCfg["model"] as string | undefined) ??
    preset?.model ??
    "";

  // ---- model tiers (each falls back to the single `model`) ----
  const fileModels = (fileCfg["models"] as Partial<ModelTiers> | undefined) ?? {};
  const presetModels = (preset?.models as Partial<ModelTiers> | undefined) ?? {};
  const resolveTier = (envKey: string, key: keyof ModelTiers): string =>
    envStr(envKey) ?? fileModels[key] ?? presetModels[key] ?? model;
  const models: ModelTiers = {
    scout: resolveTier("SUBER_MODEL_SCOUT", "scout"),
    worker: resolveTier("SUBER_MODEL_WORKER", "worker"),
    synth: resolveTier("SUBER_MODEL_SYNTH", "synth"),
  };

  const maxConcurrency =
    envNum("SUBER_MAX_CONCURRENCY") ?? (fileCfg["maxConcurrency"] as number | undefined) ?? 8;
  const maxIterationsPerAgent =
    envNum("SUBER_MAX_ITERATIONS") ?? (fileCfg["maxIterationsPerAgent"] as number | undefined) ?? 10;
  const maxToolResultChars =
    envNum("SUBER_MAX_TOOL_RESULT_CHARS") ?? (fileCfg["maxToolResultChars"] as number | undefined) ?? 10_000;
  // window may legitimately be 0 (disable), so don't coerce 0 -> default.
  const toolResultWindowRaw =
    envNum("SUBER_TOOL_RESULT_WINDOW") ?? (fileCfg["toolResultWindow"] as number | undefined);
  const toolResultWindow = toolResultWindowRaw === undefined ? 3 : Math.max(0, Math.floor(toolResultWindowRaw));
  const maxTokens = envNum("SUBER_MAX_TOKENS") ?? (fileCfg["maxTokens"] as number | undefined) ?? 8192;
  const synthMaxTokens =
    envNum("SUBER_SYNTH_MAX_TOKENS") ??
    (fileCfg["synthMaxTokens"] as number | undefined) ??
    Math.max(maxTokens, 16384);
  const thinkingBudget =
    envNum("SUBER_THINKING_BUDGET") ?? (fileCfg["thinkingBudget"] as number | undefined) ?? 0;
  const retryAttempts =
    envNum("SUBER_RETRY_ATTEMPTS") ?? (fileCfg["retryAttempts"] as number | undefined) ?? 3;
  const retryBaseMs =
    envNum("SUBER_RETRY_BASE_MS") ?? (fileCfg["retryBaseMs"] as number | undefined) ?? 800;
  const requestsPerMinute =
    envNum("SUBER_RPM") ??
    (fileCfg["requestsPerMinute"] as number | undefined) ??
    preset?.requestsPerMinute ??
    0;
  const requestsPerSecond =
    envNum("SUBER_RPS") ??
    (fileCfg["requestsPerSecond"] as number | undefined) ??
    preset?.requestsPerSecond ??
    0;

  const rootRaw =
    envStr("SUBER_WORKSPACE_ROOT") ?? (fileCfg["workspaceRoot"] as string | undefined) ?? ".";
  const workspaceRoot = path.resolve(process.cwd(), rootRaw);

  const toolsEnv = envStr("SUBER_TOOLS");
  const tools = toolsEnv
    ? toolsEnv.split(",").map((t) => t.trim()).filter(Boolean)
    : ((fileCfg["tools"] as string[] | undefined) ?? SCOUT_TOOLS);

  // ---- capabilities (dangerous, off unless acknowledged) ----
  const fileCaps = (fileCfg["capabilities"] as Partial<Capabilities> | undefined) ?? {};
  const wantWrite = envBool("SUBER_ALLOW_WRITE") ?? fileCaps.write ?? false;
  const wantBash = envBool("SUBER_ALLOW_BASH") ?? fileCaps.bash ?? false;
  const ack =
    envBool("SUBER_ACK_DANGEROUS") ?? (fileCfg["acknowledgeDangerous"] as boolean | undefined) ?? false;

  if ((wantWrite || wantBash) && !ack) {
    warnings.push(
      "write/bash capability was requested but acknowledgeDangerous=false -> FORCED OFF (read-only). " +
        "Set acknowledgeDangerous=true (or SUBER_ACK_DANGEROUS=1) to grant it.",
    );
  }
  const capabilities: Capabilities = { write: wantWrite && ack, bash: wantBash && ack };

  // ---- serena (semantic LSP vision) ----
  // `serena` in the config file may be a scalar (true/false/"auto") or an object with
  // { mode|enabled, command, context, tools }. Env always wins.
  const serenaFileRaw = fileCfg["serena"];
  const serenaObj =
    serenaFileRaw && typeof serenaFileRaw === "object"
      ? (serenaFileRaw as Record<string, unknown>)
      : {};
  const serenaFileScalar =
    serenaFileRaw && typeof serenaFileRaw === "object"
      ? (serenaObj["mode"] ?? serenaObj["enabled"])
      : serenaFileRaw;
  const serenaMode: SerenaMode =
    parseSerenaMode(envStr("SUBER_SERENA")) ?? parseSerenaMode(serenaFileScalar) ?? "auto";
  const serenaCommand =
    envStr("SUBER_SERENA_COMMAND") ?? (serenaObj["command"] as string | undefined) ?? "serena";
  const serenaContext =
    envStr("SUBER_SERENA_CONTEXT") ?? (serenaObj["context"] as string | undefined) ?? "agent";
  const serenaToolsEnv = envStr("SUBER_SERENA_TOOLS");
  const serenaTools = serenaToolsEnv
    ? serenaToolsEnv.split(",").map((t) => t.trim()).filter(Boolean)
    : ((serenaObj["tools"] as string[] | undefined) ?? SERENA_VISION_TOOLS);

  // ---- progress telemetry + watch window (off by default) ----
  // `progress` in the file may be a scalar (true/false) or an object { enabled, window }.
  const progressFileRaw = fileCfg["progress"];
  const progressObj =
    progressFileRaw && typeof progressFileRaw === "object"
      ? (progressFileRaw as Record<string, unknown>)
      : {};
  const progressFileScalar =
    progressFileRaw && typeof progressFileRaw === "object" ? progressObj["enabled"] : progressFileRaw;
  const progressEnabled =
    envBool("SUBER_PROGRESS") ?? (typeof progressFileScalar === "boolean" ? progressFileScalar : undefined) ?? false;
  // The watch window auto-spawns by default WHEN progress is on; SUBER_PROGRESS_WINDOW=0 keeps the
  // telemetry file but lets the user open `suber watch` themselves.
  const progressWindow =
    envBool("SUBER_PROGRESS_WINDOW") ?? (progressObj["window"] as boolean | undefined) ?? true;

  if (thinkingBudget > 0 && provider !== "anthropic") {
    warnings.push("thinkingBudget>0 is only applied on the anthropic wire format; ignored for openai.");
  }

  // ---- validation ----
  const missing: string[] = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!model && !(models.scout && models.worker && models.synth)) missing.push("model");
  if (missing.length) {
    throw new Error(
      `Missing required config: ${missing.join(", ")}.\n` +
        `Set them in suber.config.json, via a preset, or SUBER_* env vars. See suber.config.example.json.`,
    );
  }

  return {
    provider,
    baseUrl,
    apiKey,
    authStyle,
    anthropicVersion,
    tavilyApiKey,
    model: model || models.scout,
    models,
    maxConcurrency,
    maxIterationsPerAgent,
    maxToolResultChars,
    toolResultWindow,
    maxTokens,
    synthMaxTokens,
    thinkingBudget,
    retryAttempts,
    retryBaseMs,
    requestsPerMinute,
    requestsPerSecond,
    workspaceRoot,
    tools,
    capabilities,
    acknowledgeDangerous: ack,
    serena: { mode: serenaMode, command: serenaCommand, context: serenaContext, tools: serenaTools },
    progress: { enabled: progressEnabled, window: progressWindow },
    warnings,
  };
}

function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function formatBanner(config: FleetConfig): string {
  const dangerous = config.capabilities.write || config.capabilities.bash;
  const tiered =
    config.models.scout !== config.models.worker || config.models.worker !== config.models.synth;
  const lines: string[] = [];
  lines.push("");
  lines.push("  ┌──────────────────────────────────────────────────────────────┐");
  lines.push("  │  Suber Agent Team  -  cheap autonomous sub-agent fleet (MCP)   │");
  lines.push("  └──────────────────────────────────────────────────────────────┘");
  lines.push(`    provider     : ${config.provider}`);
  lines.push(`    base url     : ${config.baseUrl}`);
  lines.push(`    api key      : ${maskKey(config.apiKey)} (${config.authStyle})`);
  if (tiered) {
    lines.push(`    model tiers  : scout=${config.models.scout}`);
    lines.push(`                   worker=${config.models.worker}`);
    lines.push(`                   synth=${config.models.synth}   <- workers run here, NOT your main account`);
  } else {
    lines.push(`    fleet model  : ${config.model}   <- workers run here, NOT your main account`);
  }
  lines.push(`    concurrency  : ${config.maxConcurrency}   max iters/agent: ${config.maxIterationsPerAgent}`);
  lines.push(
    `    tokens       : worker=${config.maxTokens} synth=${config.synthMaxTokens}` +
      (config.thinkingBudget > 0 ? ` thinking=${config.thinkingBudget}` : ""),
  );
  lines.push(
    `    token thrift : tool-result cap=${config.maxToolResultChars}ch · ` +
      (config.toolResultWindow > 0
        ? `keep last ${config.toolResultWindow} verbatim, elide older`
        : "history compaction OFF"),
  );
  lines.push(`    retry        : ${config.retryAttempts}x (base ${config.retryBaseMs}ms) on 429/5xx/network`);
  {
    const rpm = config.requestsPerMinute > 0 ? `${config.requestsPerMinute}/min` : "unlimited/min";
    const rps = config.requestsPerSecond > 0 ? `${config.requestsPerSecond}/s` : "unlimited/s";
    const off = config.requestsPerMinute <= 0 && config.requestsPerSecond <= 0;
    lines.push(
      `    rate limit   : ${rpm}, ${rps} (client-side, shared per base url)` +
        (off ? "   [i] set requestsPerMinute/Second if your provider 429s" : ""),
    );
  }
  lines.push(`    workspace    : ${config.workspaceRoot}`);
  lines.push(
    `    scout tools  : ${config.tools.join(", ")}` + (config.tavilyApiKey ? ", web_search (tavily)" : ""),
  );
  lines.push(
    `    serena vision: ${config.serena.mode}` +
      (config.serena.mode === "off"
        ? "   (semantic LSP tools disabled)"
        : `   (cmd=${config.serena.command}, context=${config.serena.context}) -> ${config.serena.tools.length} LSP tools for workers`),
  );
  lines.push(
    `    progress     : ${config.progress.enabled ? "ON" : "off"}` +
      (config.progress.enabled
        ? `   (live JSONL + ${config.progress.window ? "auto watch window" : "manual `suber watch`"})`
        : "   (no live view; set SUBER_PROGRESS=1 to watch the fleet)"),
  );
  lines.push(
    `    capabilities : write=${config.capabilities.write} bash=${config.capabilities.bash}` +
      (dangerous ? "   [!] DANGEROUS TOOLS ENABLED" : "   (read-only, safe)"),
  );
  if (dangerous) {
    lines.push("");
    lines.push("  [!] WARNING: workers can WRITE FILES and/or RUN SHELL COMMANDS in the workspace.");
    lines.push("      A malicious task or prompt-injection from fetched content could damage your system.");
    lines.push("      You enabled this explicitly (acknowledgeDangerous). You own this decision.");
  }
  for (const w of config.warnings) {
    lines.push(`  [i] ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}
