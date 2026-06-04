# CLAUDE.md

Guidance for Claude Code when working in **suber-agent-team**.

## What this is
A provider-agnostic sub-agent **fleet exposed over MCP**. It offloads many cheap-model
sub-agents (Haiku / GPT-mini / any OpenAI- or Anthropic-compatible endpoint, or Orbit) so
the orchestrator's premium quota stays untouched. Stdio MCP server, **read-only by default**.

## Layout (`src/`)
- [index.ts](src/index.ts) — MCP entry (stdio). **stdout is JSON-RPC only**; all logs go to stderr. Exits cleanly when the parent closes stdin.
- [server.ts](src/server.ts) — the MCP tool surface: `delegate` / `fanout` / `map_reduce` / `research`. Deliberately small so it adds little schema to the orchestrator's context.
- [agent.ts](src/agent.ts) — the fleet: `runFleet` / `runSingle` / `runMapReduce` / `runResearch`, the `SYSTEM_PROMPT` + `LEAD_PROMPT`, and plan parsing.
- [providers.ts](src/providers.ts) — the per-worker tool-use loop for the `anthropic` and `openai` wire formats. Native `tool_use` path + **text-tool fallback** for proxies that ignore the `tools` param. Retry/backoff on 429/5xx/network.
- [tools.ts](src/tools.ts) — the worker tool layer: `read_file` / `glob` / `list_dir` / `grep` / `web_fetch`, plus `web_search` (auto-enabled when a Tavily key is set) and the dangerous `write_file` / `edit_file` / `bash`. `grep` uses ripgrep when available and falls back to an in-JS scan. All FS access is jailed to `workspaceRoot`; bash is denylist-guarded.
- [tool-call-parse.ts](src/tool-call-parse.ts) — fallback parser for backends that emit tool calls as text instead of structured calls.
- [config.ts](src/config.ts) — layered config (defaults < preset < file < env), all `SUBER_*` overridable.
- [rate-limiter.ts](src/rate-limiter.ts) — client-side RPM/RPS self-pacing, shared per base URL.

## Commands
- Build: `npm run build` (tsc)
- Dev: `npm run dev` (bun runs `src/index.ts`)
- Config doctor: `node dist/index.js --check` (validates config + prints the banner, does not start the server)
- MCP inspector: `npm run inspector`

## Model tiers
`scout` (cheapest, breadth) · `worker` (mid reasoning) · `synth` (smartest, decompose + synthesize).
Defaults: `delegate`→worker, `fanout`→scout, `map_reduce`→scout map + synth reduce, `research`→synth lead + scout workers + synth synthesis. An explicit `model`/`tier` always wins.

## Tooling policy (use these BEFORE raw grep/read)
1. **Serena MCP — first choice for code research & navigation.** Use `find_symbol`,
   `get_symbols_overview`, `find_referencing_symbols`, `find_implementations`, and
   `get_diagnostics_for_file` to locate symbols, find callers, and check LSP diagnostics —
   prefer these over ad-hoc grep/read whenever you need *structure* (who calls X, where is X
   defined, does this file have errors). Call `initial_instructions` before starting a coding task.
2. **suber (this server's own tools) — for agent-team research workflows.** When work is broad
   or parallelizable (multi-file audits, cross-repo scans, "find every place that…"), delegate it
   to `research` / `fanout` / `map_reduce` so the cheap fleet does the grunt work instead of the
   main account. Use `workspaceRoot` to point the fleet at a different repo than the open one.
3. **Tavily — for web search.** Use `tavily_search` / `tavily_extract` / `tavily_crawl` when you
   need to find pages by query. (The built-in `web_fetch` only retrieves a URL you already know.)

## Conventions
- **ESM / NodeNext**: import with explicit `.js` extensions even from `.ts` files.
- Comments are dense and explain *why*, not *what* — match that density.
- Read-only by default; `write_file` / `bash` are gated behind `capabilities` + `acknowledgeDangerous`.
- Never write to stdout (it carries the MCP protocol) — human-readable output goes to stderr.
