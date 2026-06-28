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

Optional `timeout` (seconds, default 600, on `default` or per-agent) bounds each endpoint request. **Config is read once at startup (`index.ts` → `loadConfig`), so reconnect the locally MCP server after editing the config** — a running server keeps the config it launched with.

Tool failures are categorized via `LocallyError` (`src/llm/errors.ts`) and rendered as tagged prose by `formatLocallyError` in `server.ts`'s catch: `timeout`/`config`/`constraint` are local (configurable) faults, `upstream` is the model endpoint's fault. Each carries an actionable `Fix:` line.

## Practices
Try to use locally yourself when working in this repo - but check its work.

For codebase Q&A, "where is X", how-something-works, and naming-convention sweeps, prefer delegating to `explore_task` (set `breadth` to `very thorough` for wide sweeps) instead of spawning a native Explore subagent — then verify the result before relying on it.