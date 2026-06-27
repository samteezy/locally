# locally

If Claude is your assistant, locally is your assistant's assistant.

Frontier models are expensive. locally runs on your own hardware for free — so when Claude needs to explore a codebase, draft some code, or answer a low-stakes question, it can hand that off to a smaller local model instead of burning tokens doing it itself.
---
locally is an MCP server that connects to any OpenAI-compatible endpoint — llama.cpp, LM Studio, vLLM, or even (if you really want) a different cloud provider. Two tools cover the main delegation patterns: **exploration** (understanding a codebase) and **generation** (writing and editing files). Each can be routed to a different model if desired.

## Tools

### `explore_task`

Explore a codebase or file tree to answer questions, understand structure, trace logic, or summarize what exists. Read-only — the model can call `explore_files` and `read_file` but cannot write. Use for analysis, Q&A, and understanding.

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
| `path` | string | — | Root directory to pre-map. The model receives a directory tree and can explore deeper via tool calls. |
| `system_prompt` | string | — | Optional system context |
| `agent` | string | — | Named agent from config. Falls back to the tool-specific default in `config.tools`, then the global `default`. |
| `max_tokens` | number | — | Override max tokens for this call |
| `max_iterations` | number | `10` | Maximum agentic loop iterations before forcing a final answer |

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
    "apiKey": ""
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
  }
}
```

Agent configs are **merged on top of `default`** — only specify what differs. The `apiKey` can be left empty for local endpoints that don't require one.

The optional `tools` section sets per-tool default agents. `explore_task` falls back to `tools.explore.agent` and `run_task` falls back to `tools.run.agent` when no `agent` is specified in the call. Both fall back to `default` if the `tools` section is absent.

### Environment variable fallback

If no config file is found, these env vars are used:

| Variable | Default |
|----------|---------|
| `LOCALLY_BASE_URL` | `http://localhost:11434/v1` |
| `LOCALLY_MODEL` | *(must be set)* |
| `LOCALLY_API_KEY` | `""` |
| `LOCALLY_TRANSPORT` | `stdio` |
| `LOCALLY_PORT` | `3000` |
| `LOCALLY_HOST` | `127.0.0.1` |

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
