# locally

If Claude is your assistant, locally is your assistant's assistant.

Frontier models are expensive. locally runs on your own hardware for free — so when Claude needs to explore a codebase, draft some code, or answer a low-stakes question, it can hand that off to a smaller local model instead of burning tokens doing it itself.
---
locally is an MCP server that connects to any OpenAI-compatible endpoint — llama.cpp, LM Studio, vLLM, or even (if you really want) a different cloud provider. Two tools cover the main delegation patterns: **exploration** (understanding a codebase) and **generation** (writing and editing files). Each can be routed to a different model if desired.

## Quickstart

Assuming you already have an OpenAI-compatible endpoint serving a model — e.g. `deepreinforce-ai/Ornith-1.0-9B` (a coding finetune of Qwen 3.5 9B) running under Ollama, llama.cpp, LM Studio, or vLLM — you can be delegating to it in two steps. No install and no config file needed; everything goes in your MCP client's settings.

**1. Point your MCP client at your model.** Add this to your Claude Code or Claude Desktop MCP config — `npx` fetches and runs the server, and the two env vars tell it where your model lives:

```json
{
  "mcpServers": {
    "locally": {
      "command": "npx",
      "args": ["-y", "locally-mcp"],
      "env": {
        "LOCALLY_BASE_URL": "http://localhost:11434/v1",
        "LOCALLY_MODEL": "deepreinforce-ai/Ornith-1.0-9B"
      }
    }
  }
}
```

`LOCALLY_API_KEY` is optional for local endpoints that don't require auth. `LOCALLY_BASE_URL` defaults to the Ollama path (`http://localhost:11434/v1`), so you can omit it if that's where your endpoint lives. Prefer to run from source? Clone the repo, `npm install && npm run build`, and use `"command": "node", "args": ["/path/to/locally/dist/index.js"]` instead.

**2. Verify.** Reconnect the server (`/mcp` in Claude Code) and try a call — point `explore_task` at a repo and check the result. Each result ends with a provenance footer showing the model used and tokens generated locally, so you can confirm the work actually ran on your endpoint.

That's the whole happy path. Want multiple models, route explore vs. run to different models, or sandbox file access? See [Configuration](#configuration).

## Tools

### `explore_task`

A read-only fan-out search over a codebase — the local-model equivalent of an Explore subagent. It greps with ripgrep and reads targeted excerpts, returning a conclusion with `file:line` citations rather than file dumps. Read-only — the model can call `explore_files` and `read_file` but cannot write. Use for analysis, Q&A, and understanding.

It is strongest at inventory work — list, enumerate, locate, "where is X", naming-convention sweeps — and weaker at open-ended "explain how this is wired" questions, so verify those before relying on them.

Set `breadth` to tune how widely it searches: `"medium"` (default) checks the most likely locations; `"very thorough"` sweeps multiple locations and naming conventions across the tree. Breadth also raises the default iteration budget (`medium` → 8, `very thorough` → 20); an explicit `max_iterations` overrides it. When `path` is omitted the working directory is mapped, so a path is optional. A `"very thorough"` run that concludes in two iterations or fewer is flagged in the result as a shallow sweep.

**Citations are checked before they come back.** Every `path:line` in the answer is re-resolved against the filesystem and confirmed to be a real file with that line in range; the result ends with a `Citations:` line naming any that did not resolve. The check does not confirm the *symbol* named at that line — that needs a parser per language — so it catches invented files and out-of-range numbers, not a right line cited for the wrong reason. An answer carrying no citations at all is flagged too, since a result with nothing anchored to a file has not done the thing you reached for this tool to do.

A citation written short — `agent-loop.ts:107` rather than `src/llm/agent-loop.ts:107` — is resolved by looking for a file whose path ends with the cited one, rather than being reported as missing. A short path is a formatting slip, not a fabrication, and calling it "file not found" buries the citations that really are wrong.

**Asserted names are checked too.** Small models are accurate about structure they read and confabulate the rest, and the confabulations tend to be *names* — a table, an env var, a constant that sounds right for the codebase but is in none of it. Every distinctive identifier the answer names in backticks is searched for across `allowedRoots`, and the ones that appear nowhere are listed in a `Symbols:` line.

The test is asymmetric, and only one half of it means anything. **No hits anywhere means the model invented the name** — there is no innocent reading of that. **Hits mean nothing is proven**: not that the name is a table, not that it is an env var, not that the claim around it is true. So this catches fabrications, not mistakes. A claim that inverts the meaning of a name that really exists goes through untouched.

Matching is deliberately generous — substring, case-insensitive, and only for names long enough and distinctive enough that their absence is informative. Every one of those choices trades recall for the guarantee that matters more: it will not warn you about a name that is really there. Set `LOCALLY_VERIFY_SYMBOLS=0` to turn it off.

**Read vs inferred.** A claim the model did not actually read the code for is asked to begin with `LIKELY:`. Only unverified claims are marked — a cited claim needs no label, because the citation is the evidence and the server has already checked it. That asymmetry is deliberate: an earlier version asked for a `CONFIRMED` marker too, and a 9B model used it to stamp one blanket "every claim above is CONFIRMED" over a whole answer, which is worse than no marking at all. A tier that only ever admits doubt cannot be applied for free.

The model is also asked to name the search behind any list it produces, so a partial sweep does not read as an exhaustive one. Unlike the two checks above, both of these are requests to the model rather than things the server enforces — a smaller model will not always comply.

### `run_task`

Generate code, draft content, or implement changes. The model runs an agentic loop with full read/write access: it can call `explore_files`, `read_file`, `write_file`, `patch_file`, and `run_shell` (see below) before producing output. Use for writing, editing, and implementing.

### `usage_report`

Report how much work has been offloaded to locally since the server started: the number of tasks handled, the approximate tokens **read locally** (input) and the tokens **returned to the caller** (output). Takes no arguments.

The two figures are reported separately and never summed. Only the returned tokens substitute for context the caller would otherwise have spent; the tokens read locally are real work, but the caller would not have read all of them itself, so counting them as tokens avoided would overstate the saving.

Note that each `explore_task` and `run_task` result also ends with a one-line provenance footer; `usage_report` gives the running cumulative total across all invocations. Counters reset when the server process restarts.

```
_locally · ornith-1.0-35b · 6 iters · 12 files read · 3m20s · ~279k read locally · ~4.5k returned_
```

The iteration count reads `6 iters (hit cap)` when the run exhausted `max_iterations` and had to be forced to a final answer. That distinction matters: a run that stopped because it ran out of budget is less complete than one that stopped because it was finished, and the two are otherwise indistinguishable.

Long runs are otherwise silent. When the MCP client sends a `progressToken` with the call, locally relays each loop iteration and tool call as an MCP progress notification, so you can see what it is doing rather than guessing whether it is stuck.

Token counts depend on the endpoint returning a `usage` block (`prompt_tokens` / `completion_tokens`) in its responses. Most OpenAI-compatible servers do, but some omit it — entirely or just `prompt_tokens` — under certain configs or when streaming. When usage isn't reported the footer reads "token usage not reported by endpoint" and the affected counts contribute `0` to the cumulative total; the invocation/task count is always accurate.

### Shared parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | The prompt or task |
| `path` | string | cwd | Directory to pre-map as a **starting point**, not a boundary. The model receives a directory tree and is told it may search and read anywhere within `allowedRoots`. Defaults to the working directory when omitted. |
| `system_prompt` | string | — | Optional system context |
| `agent` | string | — | Named agent from config. Falls back to the tool-specific default in `config.tools`, then the global `default`. |
| `max_tokens` | number | config `maxTokens` | Override max completion tokens for this call (overrides the agent's `maxTokens`). |
| `max_iterations` | number | `10` / breadth | Maximum agentic loop iterations before forcing a final answer. `run_task` defaults to 10; `explore_task` defaults to its breadth budget (8 or 20). |
| `breadth` | string | `medium` | `explore_task` only — `"medium"` or `"very thorough"`. Tunes search width and the default iteration budget. |

### `run_shell` allowlist

`run_task`'s agentic loop includes a `run_shell` tool the model can use to verify its own output (compile, lint, test, inspect git state). Only the following commands are permitted:

| Command | Notes |
|---------|-------|
| `ls` `pwd` `wc` `diff` | Standard read-only POSIX |
| `git` | Subcommands: `status` `diff` `log` `show` `blame` `branch` `tag` |
| `npm` | Subcommands: `test` `run` |
| `tsc` `eslint` `prettier` | Linting and type checking |

Reading and searching are deliberately **not** here: `cat`/`head`/`tail`/`stat` and `find`/`grep`/`rg`
would sidestep the `allowedRoots` fence, so they are omitted and the confined `read_file` /
`explore_files` tools cover that ground instead.

### Workflow example

A common pattern: explore first, then implement from the findings:

```
1. explore_task(task="summarize the auth flow", path="/app/src") → findings
2. run_task(task="refactor auth.ts based on these findings: <findings>", path="/app/src")
```

Route `explore_task` to a fast/cheap model and `run_task` to a stronger coder model via the `tools` config section (see below).

## Configuration

Copy `locally.config.example.json` to `locally.config.json` (picked up from the working directory automatically) or place it at `~/.locally/config.json`.

You can also point to a config file explicitly with the `LOCALLY_CONFIG` env var.

### Where config lives: client settings vs config file

There are two places config can come from, and they're meant for different things:

- **Your MCP client's settings** (the `env`/`args` of the server entry) can only carry a flat set of env vars — perfect for the simple, single-endpoint setup shown in the [Quickstart](#quickstart). No file required.
- **`locally.config.json`** is the home for anything *structured*: multiple named agents, per-tool routing, and sandbox roots. These can't be expressed as flat env vars.

| Config | Client `env`/args | Config file |
|--------|-------------------|-------------|
| `baseUrl` / `model` / `apiKey` | ✅ env | ✅ |
| transport `mode` / `port` / `host` | ✅ env / arg | ✅ |
| `timeout`, `maxTokens` | ❌ (file / per-call only) | ✅ |
| `agents`, `tools` routing | ❌ (nested) | ✅ |
| `allowedRoots`, `ignorePatterns` | ❌ (array) | ✅ |
| `allowedHosts`, `allowedOrigins` (HTTP) | ❌ (array) | ✅ |

The clean way to combine them is `LOCALLY_CONFIG`: put that one env var in your client settings to name *which* config file to load, and keep the rich content in the file (see the [example under Usage](#local-mcp-stdio)).

> **HTTP transport is different.** In `http` mode the server is a standalone process your client merely connects to by URL — it never launches it — so client settings can't configure it. Use a config file or set env vars where the server process runs.

```json
{
  "transport": {
    "mode": "stdio",
    "port": 3000,
    "host": "127.0.0.1",
    "allowedHosts": ["127.0.0.1", "localhost"],
    "allowedOrigins": ["127.0.0.1", "localhost"]
  },
  "default": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen3:8b",
    "apiKey": "",
    "maxTokens": 4096,
    "timeout": 600
  },
  "agents": {
    "coder": {
      "model": "qwen3:14b"
    },
    "summarizer": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKey": "sk-..."
    }
  },
  "tools": {
    "explore": { "agent": "summarizer" },
    "run": { "agent": "coder" }
  },
  "ignorePatterns": ["*.log", "tmp"]
}
```

Agent configs are **merged on top of `default`** — only specify what differs. The `apiKey` can be left empty for local endpoints that don't require one.

The optional `timeout` field (seconds, default `600`) bounds each request to the model endpoint. Raise it for slow local models or large `very thorough` sweeps; a request that exceeds it returns a `timeout` error. `timeout` can be set on `default` or per-agent.

The optional `maxTokens` field caps the completion length, sent to the endpoint as `max_tokens`. Like the other fields it can be set on `default` or per-agent (and is merged the same way). The per-call [`max_tokens` parameter](#shared-parameters) overrides it for a single call. Omit it to let the endpoint use its own default.

The optional top-level `ignorePatterns` array lists extra directory names or glob patterns to exclude from the directory tree and file exploration. It is merged on top of the built-in ignore list (`node_modules`, `.git`, `dist`, `build`, `.next`, `.nuxt`, `__pycache__`, `.cache`, `.turbo`, `coverage`, `.nyc_output`).

> **Config is read once at server startup.** After editing `locally.config.json`, **reconnect the locally MCP server** (e.g. `/mcp` in Claude Code) for changes to take effect — a running server keeps the config it loaded at launch.

### Error reporting

Tool failures come back as `isError` results tagged with a category so the calling agent can tell a configurable limit from an endpoint failure:

| Category | Origin | Meaning | What to do |
|----------|--------|---------|------------|
| `timeout` | local | Request exceeded the configured `timeout`. | Raise `timeout` and reconnect, or send a smaller task / lower `max_iterations`. |
| `config` | local | Misconfiguration — no model set, or auth (401/403) failed. | Fix model/`apiKey` in config or env, then reconnect. |
| `constraint` | local | Hit `max_iterations` without a final answer. | Raise `max_iterations`, or narrow the task. |
| `upstream` | upstream | The model endpoint failed — unreachable, 4xx/5xx, or a malformed response. | Not locally's fault; verify the endpoint/model is up. Retriable for 5xx/429. |
| `cancelled` | local | The caller stopped the task, or the client disconnected. | Nothing to fix — re-run if the cancellation wasn't intended. |

The error text leads with `[locally error: <category> — <origin>]` and ends with a concrete `Fix:` line.

The optional `tools` section sets per-tool default agents. `explore_task` falls back to `tools.explore.agent` and `run_task` falls back to `tools.run.agent` when no `agent` is specified in the call. Both fall back to `default` if the `tools` section is absent.

### Environment variable fallback

These env vars are read as a **per-field fallback** — used both when no config file is found *and* when a file exists but omits that field:

| Variable | Default |
|----------|---------|
| `LOCALLY_BASE_URL` | `http://localhost:11434/v1` |
| `LOCALLY_MODEL` | *(must be set)* |
| `LOCALLY_API_KEY` | `""` |
| `LOCALLY_TRANSPORT` | `stdio` |
| `LOCALLY_PORT` | `3000` |
| `LOCALLY_HOST` | `127.0.0.1` |
| `LOCALLY_VERIFY_SYMBOLS` | `1` — set `0` (or `false`/`off`/`no`) to skip the `explore_task` symbol check |

`timeout` and `maxTokens` are the exception: they have no env var and can only be set in the config file (or, for `maxTokens`, per call via the [`max_tokens` parameter](#shared-parameters)).

## Installation

No install is required — `npx -y locally-mcp` (as in the [Quickstart](#quickstart)) fetches and runs the latest published version. To run from source instead — for development or to pin a specific build — clone and build:

```bash
git clone https://github.com/samteezy/locally
cd locally
npm install
npm run build
```

## Usage

### Local MCP (stdio)

Add to your Claude Code or Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "locally": {
      "command": "npx",
      "args": ["-y", "locally-mcp"]
    }
  }
}
```

Or point it at a config file with `LOCALLY_CONFIG`:

```json
{
  "mcpServers": {
    "locally": {
      "command": "npx",
      "args": ["-y", "locally-mcp"],
      "env": {
        "LOCALLY_CONFIG": "/path/to/locally.config.json"
      }
    }
  }
}
```

Running from source instead? Swap `command`/`args` for `"command": "node", "args": ["/path/to/locally/dist/index.js"]`.

### Remote MCP (HTTP)

Run the server in HTTP mode:

```bash
# Via config file
# Set "transport": { "mode": "http", "port": 3000 } in locally.config.json

# Or via env var
LOCALLY_TRANSPORT=http npx -y locally-mcp

# Or via CLI flag
npx -y locally-mcp --transport http
```

The server exposes:
- `POST /mcp` — MCP Streamable HTTP endpoint
- `GET /health` — liveness check

`/mcp` is fenced against DNS rebinding: the `Host` and `Origin` headers must name the bind host
or localhost, or the request gets a `403`. Reaching the server by any other name — a reverse
proxy, a container hostname — means listing it under `transport.allowedHosts` /
`transport.allowedOrigins`:

```json
{ "transport": { "mode": "http", "allowedHosts": ["mcp.internal"], "allowedOrigins": ["mcp.internal"] } }
```

Register as a remote MCP in Claude Code:

```bash
claude mcp add --transport http locally http://localhost:3000/mcp
```

### Getting Claude Code to use locally

Installing the server only makes locally's tools *available* — by default Claude Code still does low-stakes work itself with its built-in tools. To actually keep that work off the frontier model you need to steer Claude toward locally. The quickest nudge is a `CLAUDE.md` instruction telling Claude to delegate codebase exploration to `explore_task` and routine drafting/edits to `run_task`.

See **[docs/claude-code.md](docs/claude-code.md)** for the full guide: the CLAUDE.md approach, a ready-to-use delegation subagent, and (with caveats) hard enforcement via permissions and hooks.

## Development

```bash
# stdio mode (watch)
npm run dev

# HTTP mode (watch)
npm run dev:http

# Type check
npm run typecheck

# Run tests (Vitest)
npm test

# Tests in watch mode
npm run test:watch

# Tests with a coverage report
npm run coverage

# Build
npm run build
```

Tests use [Vitest](https://vitest.dev). Test files are colocated with the code they cover as `*.test.ts` under `src/`. Vitest is a dev-only dependency — it doesn't affect the published bundle, which still ships just `dist/index.js`.

## MCP protocol support

locally speaks both the **2025-era** revisions (2024-10-07 through 2025-11-25) and
**2026-07-28**, on stdio and HTTP, from a single build. The era is negotiated per connection —
2025 clients open with `initialize`, 2026-07-28 clients probe with `server/discover` — so
existing hosts keep working unchanged and nothing needs configuring either way.

On a 2026-07-28 connection you additionally get:

- **Cacheable listings.** `tools/list` and `server/discover` advertise a one-hour public TTL
  instead of the conservative no-cache default, so reconnects stop re-fetching a tool list that
  cannot change.
- **Real cancellation.** Stopping a `tools/call` aborts the in-flight request to your model
  endpoint and halts the agentic loop. Previously a `very thorough` sweep ran to completion — up
  to 20 iterations of 600s each — with nobody left to receive the answer.
- **Tool annotations.** `explore_task` is advertised read-only and `run_task` destructive, so a
  host can decide which needs a confirmation prompt.

The deprecated features in that revision — Roots, Sampling, Logging, HTTP+SSE, and the
experimental tasks side-channel — are not used and will not be adopted. Diagnostics go to stderr.

If you drive `/mcp` by hand rather than through an MCP client, note that a 2026-07-28 request POST
must carry the `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers, agreeing with the
body; mismatches are rejected with `400`. Requests without a 2026 `_meta` envelope are served as
2025-era traffic and need none of that.

## Supported endpoints

Any OpenAI-compatible API works.
