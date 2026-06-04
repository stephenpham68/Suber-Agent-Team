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

function tryJson(raw: string): ParsedCall | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const name = (obj.name ?? obj.tool) as string | undefined;
    if (!name) return null;
    const args = (obj.arguments ?? obj.args ?? obj.parameters ?? {}) as Record<string, unknown>;
    return { name, args: typeof args === "object" && args !== null ? args : {} };
  } catch {
    return null;
  }
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
