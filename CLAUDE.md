# locally

MCP server for delegating tasks from frontier models to smaller local models via OpenAI-compatible endpoints.

## Build & dev

```bash
npm run build       # compile to dist/
npm run typecheck   # type check without emitting
npm run dev         # stdio mode, watch
npm run dev:http    # HTTP mode, watch
```

## Architecture

- `src/index.ts` — entry point, selects transport
- `src/config.ts` — config loading and agent resolution
- `src/server.ts` — MCP server factory, tool registration
- `src/tools/explore-task.ts` — `explore_task` tool: builds dir tree, runs agentic loop for Q&A/analysis
- `src/tools/run-task.ts` — `run_task` tool: builds dir tree, runs agentic loop for writing/generation
- `src/tools/explore-files.ts` — directory walker available to the agentic loop (ripgrep → grep fallback)
- `src/tools/read-file.ts` — file reader available to the agentic loop (path + optional line range)
- `src/llm/agent-loop.ts` — agentic loop: tool-call dispatch, result caching, max-iterations guard
- `src/llm/client.ts` — fetch-based OpenAI client, no external deps
- `src/transport/stdio.ts` / `http.ts` — stdio and Streamable HTTP transports

## Conventions

- ESM throughout (`"type": "module"`), Node ≥ 24
- All local imports use `.js` extensions (NodeNext module resolution)
- No runtime deps beyond `@modelcontextprotocol/sdk` — use Node built-ins
- `createServer()` in `server.ts` is a factory (called per HTTP request for stateless transport)

## Config

Copy `locally.config.example.json` → `locally.config.json` to configure endpoints and agents. Falls back to `LOCALLY_BASE_URL`, `LOCALLY_MODEL`, `LOCALLY_API_KEY` env vars.
