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

export type Provider = "anthropic" | "openai";
export type AuthStyle = "bearer" | "x-api-key";

export interface Capabilities {
  write: boolean;
  bash: boolean;
}

export interface FleetConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  authStyle: AuthStyle;
  anthropicVersion: string;
  /** The CHEAP model the worker fleet runs on. Your main session model is untouched. */
  model: string;
  maxConcurrency: number;
  maxIterationsPerAgent: number;
  maxTokens: number;
  workspaceRoot: string;
  /** Read-only scout tools exposed to every worker. */
  tools: string[];
  capabilities: Capabilities;
  acknowledgeDangerous: boolean;
  /** Non-fatal notes surfaced in the startup banner. */
  warnings: string[];
}

const PRESETS: Record<string, Partial<FleetConfig>> = {
  "orbit-anthropic": orbitAnthropic as unknown as Partial<FleetConfig>,
  "orbit-openai": orbitOpenai as unknown as Partial<FleetConfig>,
};

const SCOUT_TOOLS = ["read_file", "glob", "grep", "web_fetch"];

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

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
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
  const candidates = [
    path.resolve(process.cwd(), "suber.config.local.json"),
    path.resolve(process.cwd(), "suber.config.json"),
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

  const model =
    envStr("SUBER_MODEL") ??
    (fileCfg["model"] as string | undefined) ??
    preset?.model ??
    "";

  const maxConcurrency =
    envNum("SUBER_MAX_CONCURRENCY") ?? (fileCfg["maxConcurrency"] as number | undefined) ?? 8;
  const maxIterationsPerAgent =
    envNum("SUBER_MAX_ITERATIONS") ?? (fileCfg["maxIterationsPerAgent"] as number | undefined) ?? 6;
  const maxTokens = envNum("SUBER_MAX_TOKENS") ?? (fileCfg["maxTokens"] as number | undefined) ?? 4096;

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

  // ---- validation ----
  const missing: string[] = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!model) missing.push("model");
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
    model,
    maxConcurrency,
    maxIterationsPerAgent,
    maxTokens,
    workspaceRoot,
    tools,
    capabilities,
    acknowledgeDangerous: ack,
    warnings,
  };
}

function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function formatBanner(config: FleetConfig): string {
  const dangerous = config.capabilities.write || config.capabilities.bash;
  const lines: string[] = [];
  lines.push("");
  lines.push("  ┌──────────────────────────────────────────────────────────────┐");
  lines.push("  │  Suber Agent Team  -  cheap autonomous sub-agent fleet (MCP)   │");
  lines.push("  └──────────────────────────────────────────────────────────────┘");
  lines.push(`    provider     : ${config.provider}`);
  lines.push(`    base url     : ${config.baseUrl}`);
  lines.push(`    api key      : ${maskKey(config.apiKey)} (${config.authStyle})`);
  lines.push(`    fleet model  : ${config.model}   <- workers run here, NOT your main account`);
  lines.push(`    concurrency  : ${config.maxConcurrency}   max iters/agent: ${config.maxIterationsPerAgent}`);
  lines.push(`    workspace    : ${config.workspaceRoot}`);
  lines.push(`    scout tools  : ${config.tools.join(", ")}`);
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
