# Suber Agent Team

> A provider-agnostic **sub-agent fleet over MCP**. Offload hundreds of autonomous
> cheap-model workers (Haiku, GPT-mini, any OpenAI/Anthropic-compatible API, or
> [Orbit](https://orbit-provider.com)) so your premium **Opus / main-account quota stays untouched.**

`subagent` + `-er` -> **Suber**. Your main model stays the brain; Suber gives it a cheap army.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## The problem

When your main session (e.g. Claude Code on Opus) fans out 50-100 subagents for research,
**those subagents default to your main model** and bill against **your premium account's
session/weekly quota**. A single big fan-out can drain your whole daily budget.

## The wedge

There are great multi-model MCP servers already (Zen / PAL, 11k+ stars). But they optimize
for a **smarter team** - route to *better/different* (often expensive) models for quality.

**Suber optimizes for the opposite: a cheaper army.** One cheap model x N autonomous workers,
for scale and **cost/quota arbitrage**. The crucial difference:

| | Multi-model consult (Zen/PAL) | **Suber Agent Team** |
|---|---|---|
| Goal | Better answers via diverse models | Same grunt-work, cheaper, off your main quota |
| Who reads the 25 files? | **Your main model** (burns your quota), then asks another model for an opinion | **The cheap worker** reads/greps/fetches itself; your main model never touches them |
| Optimizes | Quality | Cost + scale + quota preservation |
| Net result | Spends more for better insight | Spends almost nothing of your main account |

Your main model only ever sees a concise synthesized result. The context-heavy, iterative
tool work happens on the cheap provider.

---

## How it works

```
[ Main = Opus, your premium account ]      <- quota preserved
        |  calls ONE MCP tool: fanout([task1..taskN])   (tiny cost)
        v
+----------------------------------------------------+
|  Suber MCP server (this repo, separate process)    |
|   worker #1  ---+                                  |
|   worker #2     +-- bounded-concurrency parallel   |
|   ...           |   each is an autonomous          |
|   worker #N  ---+   tool-use loop                  |
|        |  read_file / glob / grep / web_fetch       |
+--------|-------------------------------------------+
         v  cheap model via YOUR configured base URL
   Orbit /anthropic (Haiku)  |  Orbit /v1 (OpenAI fmt)  |  any compatible API
   -> all worker tokens billed HERE, not your main account
```

Each worker is a real agent: it calls tools, gathers evidence, loops, and returns a
concise factual answer. Suber's tools (`delegate` / `fanout` / `map_reduce`) just drive that fleet.

---

## Install

Requires Node 18+ (or run the standalone binary - no runtime needed).

### Option A - npx (no install)

Add to your MCP client config (e.g. Claude Code `.mcp.json`):

```jsonc
{
  "mcpServers": {
    "suber": {
      "command": "npx",
      "args": ["-y", "suber-agent-team"],
      "env": {
        "SUBER_PRESET": "orbit-anthropic",
        "SUBER_API_KEY": "sk-orbit-YOUR_KEY"
      }
    }
  }
}
```

### Option B - standalone binary (no Node)

```bash
bun run build:exe      # produces bin-dist/suber-agent-team-<platform>[.exe]
```

```jsonc
{
  "mcpServers": {
    "suber": {
      "command": "C:/path/to/suber-agent-team-windows-x64.exe",
      "env": { "SUBER_PRESET": "orbit-anthropic", "SUBER_API_KEY": "sk-orbit-YOUR_KEY" }
    }
  }
}
```

### From source

```bash
bun install
bun run build      # tsc -> dist/
bun run dev        # run from source
```

---

## Configure

Everything can be set via a `suber.config.json` file (copy `suber.config.example.json`) or
`SUBER_*` env vars (env wins). Minimum needed: a base URL, an API key, and a model.

| Field | Env | Notes |
|-------|-----|-------|
| `provider` | `SUBER_PROVIDER` | `anthropic` (Messages API) or `openai` (Chat Completions) |
| `baseUrl` | `SUBER_BASE_URL` | Root URL of any compatible gateway |
| `apiKey` | `SUBER_API_KEY` | Falls back to `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `authStyle` | `SUBER_AUTH_STYLE` | `bearer` or `x-api-key` (auto: `x-api-key` for api.anthropic.com, else `bearer`) |
| `model` | `SUBER_MODEL` | The **cheap** model the fleet runs on |
| `maxConcurrency` | `SUBER_MAX_CONCURRENCY` | Parallel workers (default 8) |
| `maxIterationsPerAgent` | `SUBER_MAX_ITERATIONS` | Tool-loop cap per worker (default 6) |
| `maxTokens` | `SUBER_MAX_TOKENS` | Per worker response (default 4096) |
| `workspaceRoot` | `SUBER_WORKSPACE_ROOT` | Files workers may read/grep (default: launch dir) |
| `tools` | `SUBER_TOOLS` | Scout tools (default `read_file,glob,grep,web_fetch`) |
| `preset` | `SUBER_PRESET` | `orbit-anthropic` or `orbit-openai` baked in |

### Orbit presets (one line to go)

```jsonc
{ "preset": "orbit-anthropic", "apiKey": "sk-orbit-YOUR_KEY" }   // -> /anthropic, claude-haiku-4-5
{ "preset": "orbit-openai",    "apiKey": "sk-orbit-YOUR_KEY" }   // -> /v1, OpenAI wire format
```

Presets only fill defaults; anything you set overrides them. Works with any provider, not just Orbit.

---

## Tools (the MCP surface)

Deliberately small (3 tools) to minimize schema overhead in your main context.

- **`delegate(task, context?, model?)`** - one task -> one worker -> concise result.
- **`fanout(tasks[], context?, model?)`** - many tasks in parallel (bounded by `maxConcurrency`).
- **`map_reduce(items[], mapPrompt, reducePrompt, model?)`** - map a prompt over items in parallel,
  then one worker reduces all outputs into a single synthesis.

Every response ends with a footer telling you how many tokens were offloaded to your fleet
provider instead of your main account.

---

## Security model

Workers are **read-only scouts by default** (`read_file`, `glob`, `grep`, `web_fetch`), and all
filesystem access is **jailed to `workspaceRoot`**.

Write and shell access are **OFF unless you explicitly opt in**:

```jsonc
{
  "capabilities": { "write": true, "bash": true },
  "acknowledgeDangerous": true   // required, or write/bash are forced off with a warning
}
```

When enabled, the startup banner prints a loud warning, `bash` runs behind a denylist
(blocks `rm -rf`, `sudo`, fork bombs, `git push`, piped `curl|sh`, etc.) with a 60s timeout
and capped output. **You, the admin, own this decision.** A malicious task or prompt-injection
from fetched content could do damage with these on - keep them off unless you need them.

---

## Robustness: works even without native tool use

Many cheap gateways/proxies do **not** emit native structured tool calls - they put tool calls
in the text. Suber prescribes a strict text protocol (`<tool_call>{...}</tool_call>`) in the
worker system prompt and parses it, while still preferring native `tool_use` when the backend
supports it. So the fleet works across a wide range of endpoints.

> Verified live against Orbit's `/anthropic` Haiku route: workers autonomously ran `glob` and
> `read_file`, returned correct answers, with all tokens billed to Orbit (0 on the main account).
> The footer reports `text-tool fallback` when this path is used.

---

## Status & roadmap

v0.1 - working: stdio MCP server, Anthropic + OpenAI wire formats, parallel fleet, scout tools,
gated write/bash, Orbit presets, single-binary build, native + text-tool protocols.

Planned: cost-aware model auto-selection, optional code-execution interface (write a fan-out
script instead of N tool calls), more presets, worker result caching, optional worktree isolation.

## License

MIT - see [LICENSE](./LICENSE).
