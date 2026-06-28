# locally

If Claude is your assistant, locally is your assistant's assistant.

Frontier models are expensive. locally runs on your own hardware for free — so when Claude needs to explore a codebase, draft some code, or answer a low-stakes question, it can hand that off to a smaller local model instead of burning tokens doing it itself.
---
locally is an MCP server that connects to any OpenAI-compatible endpoint — llama.cpp, LM Studio, vLLM, or even (if you really want) a different cloud provider. Two tools cover the main delegation patterns: **exploration** (understanding a codebase) and **generation** (writing and editing files). Each can be routed to a different model if desired.

## Quickstart

Assuming you already have an OpenAI-compatible endpoint serving a model — e.g. `deepreinforce-ai/Ornith-1.0-9B` (a coding finetune of Qwen 3.5 9B) running under Ollama, llama.cpp, LM Studio, or vLLM — you can be delegating to it in three steps. No config file needed; everything goes in your MCP client's settings.

**1. Get the server.** Clone and build:

```bash
git clone https://github.com/samteezy/locally
cd locally && npm install && npm run build
```

(Once published to npm you'll be able to skip this and use `npx locally-mcp` directly — see step 2.)

**2. Point your MCP client at your model.** Add this to your Claude Code or Claude Desktop MCP config, pointing `command`/`args` at the build from step 1 and setting two env vars:

```json
{
  "mcpServers": {
    "locally": {
      "command": "node",
      "args": ["/path/to/locally/dist/index.js"],
      "env": {
        "LOCALLY_BASE_URL": "http://localhost:11434/v1",
        "LOCALLY_MODEL": "deepreinforce-ai/Ornith-1.0-9B"
      }
    }
  }
}
```

`LOCALLY_API_KEY` is optional for local endpoints that don't require auth. `LOCALLY_BASE_URL` defaults to the Ollama path (`http://localhost:11434/v1`), so you can omit it if that's where your endpoint lives. Once `locally-mcp` is on npm, replace `command`/`args` with `"command": "npx", "args": ["locally-mcp"]`.

**3. Verify.** Reconnect the server (`/mcp` in Claude Code) and try a call — point `explore_task` at a repo and check the result. Each result ends with a provenance footer showing the model used and tokens generated locally, so you can confirm the work actually ran on your endpoint.

That's the whole happy path. Want multiple models, route explore vs. run to different models, or sandbox file access? See [Configuration](#configuration).

## Tools

### `explore_task`

A read-only fan-out search over a codebase — the local-model equivalent of an Explore subagent. It sweeps many files, directories, and naming conventions and returns a conclusion with `file:line` citations rather than file dumps; it reads excerpts to locate code, not to review or audit it. Read-only — the model can call `explore_files` and `read_file` but cannot write. Use for analysis, Q&A, and understanding.

Set `breadth` to tune how widely it searches: `"medium"` (default) checks the most likely locations; `"very thorough"` sweeps multiple locations and naming conventions across the tree. Breadth also raises the default iteration budget (`medium` → 8, `very thorough` → 20); an explicit `max_iterations` overrides it. When `path` is omitted the working directory is mapped, so a path is optional.

### `run_task`

Generate code, draft content, or implement changes. The model runs an agentic loop with full read/write access: it can call `explore_files`, `read_file`, `write_file`, and `run_shell` (see below) before producing output. Use for writing, editing, and implementing.

### `usage_report`

Report how much work has been offloaded to locally since the server started: the number of tasks handled and the approximate tokens processed (input) and generated (output) locally. Takes no arguments. Use it to see how much has been kept off the frontier model.

Note that each `explore_task` and `run_task` result also ends with a one-line provenance footer (model used, iterations, and tokens processed/generated); `usage_report` gives the running cumulative total across all invocations. Counters reset when the server process restarts.

Token counts depend on the endpoint returning a `usage` block (`prompt_tokens` / `completion_tokens`) in its responses. Most OpenAI-compatible servers do, but some omit it — entirely or just `prompt_tokens` — under certain configs or when streaming. When usage isn't reported the footer reads "token usage not reported by endpoint" and the affected counts contribute `0` to the cumulative total; the invocation/task count is always accurate.

### Shared parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | The prompt or task |
| `path` | string | cwd | Root directory to pre-map. The model receives a directory tree and can explore deeper via tool calls. Defaults to the working directory when omitted. |
| `system_prompt` | string | — | Optional system context |
| `agent` | string | — | Named agent from config. Falls back to the tool-specific default in `config.tools`, then the global `default`. |
| `max_tokens` | number | config `maxTokens` | Override max completion tokens for this call (overrides the agent's `maxTokens`). |
| `max_iterations` | number | `10` | Maximum agentic loop iterations before forcing a final answer |
| `breadth` | string | `medium` | `explore_task` only — `"medium"` or `"very thorough"`. Tunes search width and the default iteration budget. |

### `run_shell` allowlist

`run_task`'s agentic loop includes a `run_shell` tool the model can use to verify its own output (compile, lint, test, inspect git state). Only the following commands are permitted:

| Command | Notes |
|---------|-------|
| `cat` `head` `tail` `wc` `diff` `ls` `find` `stat` `echo` `pwd` | Standard read-only POSIX |
| `grep` `rg` | Text search |
| `git` | Subcommands: `status` `diff` `log` `show` `blame` `branch` `tag` |
| `npm` | Subcommands: `test` `run` |
| `tsc` `eslint` `prettier` | Linting and type checking |

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

The clean way to combine them is `LOCALLY_CONFIG`: put that one env var in your client settings to name *which* config file to load, and keep the rich content in the file (see the [example under Usage](#local-mcp-stdio)).

> **HTTP transport is different.** In `http` mode the server is a standalone process your client merely connects to by URL — it never launches it — so client settings can't configure it. Use a config file or set env vars where the server process runs.

```json
{
  "transport": {
    "mode": "stdio",
    "port": 3000,
    "host": "127.0.0.1"
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

`timeout` and `maxTokens` are the exception: they have no env var and can only be set in the config file (or, for `maxTokens`, per call via the [`max_tokens` parameter](#shared-parameters)).

## Installation

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
      "command": "node",
      "args": ["/path/to/locally/dist/index.js"]
    }
  }
}
```

Or with a config file:

```json
{
  "mcpServers": {
    "locally": {
      "command": "node",
      "args": ["/path/to/locally/dist/index.js"],
      "env": {
        "LOCALLY_CONFIG": "/path/to/locally.config.json"
      }
    }
  }
}
```

### Remote MCP (HTTP)

Run the server in HTTP mode:

```bash
# Via config file
# Set "transport": { "mode": "http", "port": 3000 } in locally.config.json

# Or via env var
LOCALLY_TRANSPORT=http node dist/index.js

# Or via CLI flag
node dist/index.js --transport http
```

The server exposes:
- `POST /mcp` — MCP Streamable HTTP endpoint
- `GET /health` — liveness check

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

# Build
npm run build
```

## Supported endpoints

Any OpenAI-compatible API works.
