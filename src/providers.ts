/**
 * Provider clients. Each implements a FULL tool-use loop on the cheap model so the
 * worker autonomously gathers evidence. Supports two wire formats:
 *   - "anthropic": Anthropic Messages API  ({baseUrl}/v1/messages)
 *   - "openai":    OpenAI Chat Completions ({baseUrl}/chat/completions)
 *
 * Robustness:
 *   - If the backend does NOT return native structured tool calls (common with cheap
 *     gateways/proxies), we fall back to parsing tool calls from the text content.
 *   - Transient failures (429 / 5xx / network) are retried with exponential backoff,
 *     honoring Retry-After. Orbit-style pools 429 under load; one retry cuts failures.
 */
import type { FleetConfig } from "./config.js";
import type { AgentTool } from "./tools.js";
import { parseTextToolCalls, stripToolMarkup, type ParsedCall } from "./tool-call-parse.js";

export interface RunAgentInput {
  system: string;
  prompt: string;
  tools: AgentTool[];
  model: string;
  /** Per-call response cap. Falls back to config.maxTokens. */
  maxTokens?: number;
  /** Per-call extended-thinking budget (anthropic only). 0/undefined = off. */
  thinkingBudget?: number;
}

export interface RunAgentResult {
  text: string;
  iterations: number;
  toolCalls: number;
  /** True if the backend used the text-tool fallback (no native tool_use). */
  textToolFallback: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderClient {
  runAgent(input: RunAgentInput): Promise<RunAgentResult>;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function executeTool(
  tools: AgentTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.run(input ?? {});
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

const TEXT_TOOL_HINT =
  "\n\nUse these results. If you need another tool, call it the same way as before. " +
  "When finished, reply with ONLY the final answer and no tool-call syntax.";

/** Describe a tool's parameters compactly from its JSON Schema. */
function describeParams(schema: Record<string, unknown>): string {
  const props = (schema.properties as Record<string, { type?: string }>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const parts = Object.entries(props).map(
    ([k, v]) => `"${k}"${required.has(k) ? "" : "?"}: ${v?.type ?? "string"}`,
  );
  return `{ ${parts.join(", ")} }`;
}

/**
 * Prescribe a strict text tool-call protocol in the system prompt. This makes the
 * fleet work even on backends that ignore the native `tools` parameter and would
 * otherwise improvise inconsistent tool-call syntax.
 */
function buildToolProtocol(tools: AgentTool[]): string {
  if (!tools.length) return "";
  const list = tools
    .map((t) => `- ${t.name} ${describeParams(t.parameters)} -- ${t.description}`)
    .join("\n");
  return (
    "\n\nYOU HAVE THESE TOOLS:\n" +
    list +
    "\n\nHOW TO CALL A TOOL:\n" +
    "When you need a tool, respond with ONLY a single line in EXACTLY this format and nothing else:\n" +
    '<tool_call>{"name":"<tool_name>","arguments":{ ...exact parameter names above... }}</tool_call>\n' +
    "Use the EXACT parameter names listed above. You may emit several <tool_call> lines at once to run " +
    "tools in parallel, then stop and wait for the results.\n" +
    "When you have enough information, reply with the final answer and DO NOT include any <tool_call>."
  );
}

abstract class BaseClient {
  protected readonly base: string;
  constructor(protected readonly config: FleetConfig) {
    this.base = config.baseUrl.replace(/\/+$/, "");
  }

  /** POST with transient-error retry (429/5xx/network), exponential backoff + Retry-After. */
  protected async post(pathPart: string, body: unknown, headers: Record<string, string>): Promise<any> {
    const attempts = Math.max(0, this.config.retryAttempts);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.base + pathPart, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        // network error / timeout
        if (attempt >= attempts) throw new Error(`${this.config.provider} request failed: ${(e as Error).message}`);
        await sleep(this.backoff(attempt));
        continue;
      }

      if (res.ok) return res.json();

      const txt = await res.text().catch(() => "");
      const err = new Error(`${this.config.provider} ${res.status} ${res.statusText}: ${txt.slice(0, 600)}`);
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= attempts) throw err;

      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt);
      await sleep(wait);
    }
  }

  /** Exponential backoff with jitter, capped at 12s. */
  private backoff(attempt: number): number {
    const base = this.config.retryBaseMs * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * this.config.retryBaseMs);
    return Math.min(base + jitter, 12_000);
  }

  protected formatTextResults(results: { name: string; output: string }[]): string {
    return (
      "Tool results:\n" +
      results.map((r) => `<result name="${r.name}">\n${r.output}\n</result>`).join("\n") +
      TEXT_TOOL_HINT
    );
  }
}

export class AnthropicClient extends BaseClient implements ProviderClient {
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "anthropic-version": this.config.anthropicVersion };
    if (this.config.authStyle === "x-api-key") h["x-api-key"] = this.config.apiKey;
    else h["authorization"] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async runAgent({ system, prompt, tools, model, maxTokens, thinkingBudget }: RunAgentInput): Promise<RunAgentResult> {
    const apiTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    const sys = system + buildToolProtocol(tools);
    const knownTools = tools.map((t) => t.name);
    const messages: any[] = [{ role: "user", content: prompt }];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    let iterations = 0;
    let textToolFallback = false;

    const think = (thinkingBudget ?? 0) > 0;
    // With extended thinking, max_tokens must exceed the thinking budget.
    const cap = maxTokens ?? this.config.maxTokens;
    const finalMaxTokens = think ? Math.max(cap, (thinkingBudget ?? 0) + 2048) : cap;

    while (iterations < this.config.maxIterationsPerAgent) {
      iterations++;
      const res = await this.post(
        "/v1/messages",
        {
          model,
          max_tokens: finalMaxTokens,
          system: sys,
          messages,
          ...(think ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } } : {}),
          ...(apiTools.length ? { tools: apiTools } : {}),
        },
        this.headers(),
      );
      usage.inputTokens += res.usage?.input_tokens ?? 0;
      usage.outputTokens += res.usage?.output_tokens ?? 0;
      const content: any[] = res.content ?? [];
      const nativeUses = content.filter((c) => c.type === "tool_use");
      const textOut = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      // --- native tool_use path (tools run in parallel) ---
      if (res.stop_reason === "tool_use" || nativeUses.length) {
        messages.push({ role: "assistant", content });
        const toolResults = await Promise.all(
          nativeUses.map(async (block) => {
            toolCalls++;
            const output = await executeTool(tools, block.name, block.input ?? {});
            return { type: "tool_result", tool_use_id: block.id, content: output };
          }),
        );
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // --- text-tool fallback path ---
      if (apiTools.length) {
        const parsed = parseTextToolCalls(textOut, knownTools);
        if (parsed.length) {
          textToolFallback = true;
          messages.push({ role: "assistant", content: textOut });
          const results = await this.runParsed(tools, parsed);
          toolCalls += parsed.length;
          messages.push({ role: "user", content: this.formatTextResults(results) });
          continue;
        }
      }

      // --- final answer ---
      return { text: stripToolMarkup(textOut), iterations, toolCalls, textToolFallback, usage };
    }

    return {
      text: "[suber] worker reached max iterations without a final answer.",
      iterations,
      toolCalls,
      textToolFallback,
      usage,
    };
  }

  private async runParsed(tools: AgentTool[], parsed: ParsedCall[]) {
    // Run all parsed calls in parallel, preserving order.
    return Promise.all(
      parsed.map(async (call) => ({ name: call.name, output: await executeTool(tools, call.name, call.args) })),
    );
  }
}

export class OpenAIClient extends BaseClient implements ProviderClient {
  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.apiKey}` };
  }

  async runAgent({ system, prompt, tools, model, maxTokens }: RunAgentInput): Promise<RunAgentResult> {
    const apiTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const sys = system + buildToolProtocol(tools);
    const knownTools = tools.map((t) => t.name);
    const messages: any[] = [
      { role: "system", content: sys },
      { role: "user", content: prompt },
    ];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    let iterations = 0;
    let textToolFallback = false;
    const cap = maxTokens ?? this.config.maxTokens;

    while (iterations < this.config.maxIterationsPerAgent) {
      iterations++;
      const res = await this.post(
        "/chat/completions",
        {
          model,
          max_tokens: cap,
          messages,
          ...(apiTools.length ? { tools: apiTools, tool_choice: "auto" } : {}),
        },
        this.headers(),
      );
      usage.inputTokens += res.usage?.prompt_tokens ?? 0;
      usage.outputTokens += res.usage?.completion_tokens ?? 0;
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new Error("openai: empty choices in response");

      const calls: any[] = msg.tool_calls ?? [];

      // --- native tool_calls path ---
      if (calls.length) {
        messages.push(msg);
        const results = await Promise.all(
          calls.map(async (tc) => {
            toolCalls++;
            let args: Record<string, unknown> = {};
            try {
              args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
              args = {};
            }
            const output = await executeTool(tools, tc.function?.name, args);
            return { role: "tool", tool_call_id: tc.id, content: output };
          }),
        );
        for (const r of results) messages.push(r);
        continue;
      }

      const textOut = String(msg.content ?? "");

      // --- text-tool fallback path ---
      if (apiTools.length) {
        const parsed = parseTextToolCalls(textOut, knownTools);
        if (parsed.length) {
          textToolFallback = true;
          messages.push({ role: "assistant", content: textOut });
          const results = await Promise.all(
            parsed.map(async (call) => ({ name: call.name, output: await executeTool(tools, call.name, call.args) })),
          );
          toolCalls += parsed.length;
          messages.push({ role: "user", content: this.formatTextResults(results) });
          continue;
        }
      }

      // --- final answer ---
      return { text: stripToolMarkup(textOut).trim(), iterations, toolCalls, textToolFallback, usage };
    }

    return {
      text: "[suber] worker reached max iterations without a final answer.",
      iterations,
      toolCalls,
      textToolFallback,
      usage,
    };
  }
}

export function createProvider(config: FleetConfig): ProviderClient {
  return config.provider === "openai" ? new OpenAIClient(config) : new AnthropicClient(config);
}
