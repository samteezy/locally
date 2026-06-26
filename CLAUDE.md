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
- `src/tools/explore-files.ts` — directory walker (ripgrep → grep fallback)
- `src/tools/run-task.ts` — delegates to OpenAI-compatible endpoint
- `src/transport/stdio.ts` / `http.ts` — stdio and Streamable HTTP transports
- `src/llm/client.ts` — fetch-based OpenAI client, no external deps

## Conventions

- ESM throughout (`"type": "module"`), Node ≥ 24
- All local imports use `.js` extensions (NodeNext module resolution)
- No runtime deps beyond `@modelcontextprotocol/sdk` — use Node built-ins
- `createServer()` in `server.ts` is a factory (called per HTTP request for stateless transport)

## Config

Copy `locally.config.example.json` → `locally.config.json` to configure endpoints and agents. Falls back to `LOCALLY_BASE_URL`, `LOCALLY_MODEL`, `LOCALLY_API_KEY` env vars.
