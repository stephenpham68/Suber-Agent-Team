<!--
Paste the block below into your project (or global) CLAUDE.md so the AI knows the
Suber Agent Team fleet exists and reaches for it instead of burning main-account quota.
Works the same way for .cursorrules / system prompts in other MCP hosts.
-->

## Suber Agent Team (cheap sub-agent fleet)
A `suber` MCP server is connected. It runs a fleet of cheap-model workers that do
context-heavy grunt work OFF your main account's quota.

- When a task needs to research / scan / audit MANY things in parallel, or read many
  files to answer a question, call `mcp__suber__fanout` (many tasks in parallel),
  `mcp__suber__delegate` (one task), or `mcp__suber__map_reduce` (map over items then
  synthesize) INSTEAD of spawning main-model subagents or reading everything yourself.
- Suber workers are read-only scouts (read_file / glob / grep / web_fetch) and return
  concise results. Hand them the grunt work; keep final reasoning + synthesis on yourself.
- Good fits: parallel code search, multi-file summarization, bulk / first-pass research,
  large audits. This preserves your premium quota and keeps your main context clean.
