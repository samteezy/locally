# locally

An MCP server that lets frontier models (Claude, GPT-4, etc.) delegate cost-sensitive or repetitive tasks to smaller local models via any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, or any cloud provider.

## Tools

### `explore_files`

Walks a directory and returns an LLM-friendly view of its contents. Uses [ripgrep](https://github.com/BurntSushi/ripgrep) when available, falls back to `grep`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | Directory to explore |
| `query` | string | — | Search for content (uses rg/grep). Returns matching lines instead of full file contents. |
| `file_pattern` | string | — | Filter files, e.g. `"*.ts"` or `"*.md"` |
| `max_depth` | number | `5` | Max directory depth |
| `max_file_size_kb` | number | `100` | Skip files larger than this |

### `run_task`

Sends a task to a model via an OpenAI-compatible endpoint and returns the response.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | The prompt or task |
| `system_prompt` | string | — | Optional system context |
| `agent` | string | — | Named agent from config. Uses `default` when omitted. |
| `max_tokens` | number | — | Override max tokens for this call |

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
  }
}
```

Agent configs are **merged on top of `default`** — only specify what differs. The `apiKey` can be left empty for local endpoints that don't require one.

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

Any OpenAI-compatible API works:

- [Ollama](https://ollama.com) — `http://localhost:11434/v1`
- [LM Studio](https://lmstudio.ai) — `http://localhost:1234/v1`
- [vLLM](https://docs.vllm.ai) — `http://localhost:8000/v1`
- OpenAI, Anthropic (via proxy), or any other cloud provider
