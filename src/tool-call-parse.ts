/**
 * Fallback parser for backends that DON'T emit native structured tool calls and
 * instead put tool calls in the text content (common with cheap gateways/proxies,
 * including some Orbit model routes).
 *
 * The worker is PRESCRIBED a strict format via the system prompt (see providers.ts):
 *     <tool_call>{"name":"NAME","arguments":{...}}</tool_call>
 * We parse that first. As a safety net we also recognize the Anthropic
 * <invoke name="NAME"><parameter .../></invoke> format and improvised
 * self-closing tags like <glob pattern="..."/> for known tool names.
 */
export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

function pushUnique(out: ParsedCall[], seen: Set<string>, call: ParsedCall): void {
  if (!call.name) return;
  const key = `${call.name}:${JSON.stringify(call.args)}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(call);
}

/**
 * Lenient JSON parse. Cheap models routinely emit *almost* valid JSON: markdown
 * fences, trailing commas, or an all-single-quoted object. A strict JSON.parse drops
 * those tool calls silently (the worker then stalls or hallucinates). We try strict
 * first, then a few targeted repairs, before giving up.
 */
function parseLenient(raw: string): Record<string, unknown> | null {
  const attempts: string[] = [];
  const trimmed = raw.trim();
  attempts.push(trimmed);
  // Strip a ```json ... ``` (or ``` ... ```) fence the model may have wrapped it in.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (unfenced !== trimmed) attempts.push(unfenced);
  // Remove trailing commas before a closing } or ].
  const noTrailingComma = unfenced.replace(/,(\s*[}\]])/g, "$1");
  if (noTrailingComma !== unfenced) attempts.push(noTrailingComma);
  // Whole object single-quoted (no double quotes at all) -> swap to double quotes.
  if (!noTrailingComma.includes('"') && noTrailingComma.includes("'")) {
    attempts.push(noTrailingComma.replace(/'/g, '"'));
  }
  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch {
      /* try next repair */
    }
  }
  return null;
}

function tryJson(raw: string): ParsedCall | null {
  const obj = parseLenient(raw);
  if (!obj) return null;
  const name = (obj.name ?? obj.tool) as string | undefined;
  if (!name) return null;
  const args = (obj.arguments ?? obj.args ?? obj.parameters ?? {}) as Record<string, unknown>;
  return { name, args: typeof args === "object" && args !== null ? args : {} };
}

/** True if the text contains tool-call markup (possibly malformed). Used to decide
 *  whether a 0-parse result is a real final answer or a botched tool call to nudge. */
export function hasToolCallMarkup(text: string): boolean {
  return /<tool_call>|<invoke\s+name=/.test(text);
}

export function parseTextToolCalls(text: string, knownTools: string[] = []): ParsedCall[] {
  const calls: ParsedCall[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  // Format 1 (prescribed): <tool_call>{ "name": "...", "arguments": {...} }</tool_call>
  const tcRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = tcRe.exec(text)) !== null) {
    const parsed = tryJson(m[1] ?? "");
    if (parsed) pushUnique(calls, seen, parsed);
  }

  // Format 2: <invoke name="X"><parameter name="p">v</parameter>...</invoke>
  const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  while ((m = invokeRe.exec(text)) !== null) {
    const name = (m[1] ?? "").trim();
    const inner = m[2] ?? "";
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(inner)) !== null) {
      const key = (pm[1] ?? "").trim();
      if (key) args[key] = (pm[2] ?? "").trim();
    }
    pushUnique(calls, seen, { name, args });
  }

  // Format 3 (best-effort): improvised tags for known tools, e.g. <glob pattern="..."/>
  if (calls.length === 0 && knownTools.length) {
    for (const tool of knownTools) {
      const tagRe = new RegExp(`<${tool}\\b([^>]*?)/?>`, "g");
      while ((m = tagRe.exec(text)) !== null) {
        const attrs = m[1] ?? "";
        const args: Record<string, unknown> = {};
        const attrRe = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(attrs)) !== null) args[am[1] ?? ""] = am[2] ?? "";
        pushUnique(calls, seen, { name: tool, args });
      }
    }
  }

  return calls;
}

/** Remove residual tool-call markup so the final answer is clean prose. */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<function_calls>[\s\S]*$/g, "")
    .replace(/<invoke[\s\S]*?<\/invoke>/g, "")
    .replace(/<invoke[\s\S]*$/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_call>[\s\S]*$/g, "")
    .replace(/<\/?(?:antml:)?(?:function_calls|invoke|parameter|tool_call)[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
