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
- `src/llm/embeddings.ts` — fetch-based `/embeddings` client (mirrors `client.ts`), for the knowledge base
- `src/transport/stdio.ts` / `http.ts` — stdio and Streamable HTTP transports
- `src/knowledge/` — optional knowledge base (HTTP/remote mode): `store.ts` (node:sqlite + sqlite-vec vector store), `chunk.ts` (structure-aware md/txt chunker + path-context helper), `indexer.ts` (initial scan + `fs.watch` incremental re-index), `index.ts` (process-level singleton: `initKnowledge`/`getKnowledgeStore`/`searchKnowledge`), `ui.ts` (inlined browse/search page)
- `src/tools/knowledge-search.ts` — `knowledge_search` MCP tool (registered only when the knowledge base is initialized)

## Conventions

- ESM throughout (`"type": "module"`), Node ≥ 24
- All local imports use `.js` extensions (NodeNext module resolution)
- Runtime deps kept minimal: `@modelcontextprotocol/sdk`, plus `sqlite-vec` (vector search, used only by the optional knowledge base) — otherwise use Node built-ins. The vector store uses the `node:sqlite` builtin; it's loaded via a runtime `require` in `store.ts` because esbuild rewrites a static `node:sqlite` import to an unresolvable bare `sqlite` (see `tsup.config.ts` externals)
- `createServer()` in `server.ts` is a factory (called per HTTP request for stateless transport)

## Config

Copy `locally.config.example.json` → `locally.config.json` to configure endpoints and agents. Falls back to `LOCALLY_BASE_URL`, `LOCALLY_MODEL`, `LOCALLY_API_KEY` env vars.

Optional `timeout` (seconds, default 600, on `default` or per-agent) bounds each endpoint request. **Config is read once at startup (`index.ts` → `loadConfig`), so reconnect the locally MCP server after editing the config** — a running server keeps the config it launched with.

Optional `allowedRoots` (array of absolute dirs) confines every file/shell tool — `read_file`, `write_file`, `patch_file`, `explore_files`, and `run_shell`'s `cwd` — to those directories. Symlinks are resolved before the check (`src/tools/sandbox.ts`), so a link out of a root is rejected. Defaults to `[process.cwd()]` (the launch directory) when unset, so the model is sandboxed by default. A blocked path returns a `constraint` error and the model retries within bounds. The effective fence is logged to stderr at startup (`index.ts` → `effectiveRoots`), so you can see whether the default `process.cwd()` landed where you expect; a fully-unresolvable `allowedRoots` fails fast at startup. The shell allowlist (`src/tools/run-shell.ts`) is intentionally narrow — no `cat`/`find`/`grep` etc.; reading and searching go through the confined `read_file`/`explore_files` tools instead.

Tool failures are categorized via `LocallyError` (`src/llm/errors.ts`) and rendered as tagged prose by `formatLocallyError` in `server.ts`'s catch: `timeout`/`config`/`constraint` are local (configurable) faults, `upstream` is the model endpoint's fault. Each carries an actionable `Fix:` line.

Optional `knowledge` block enables the knowledge base (HTTP/remote mode only — the watcher is a process-level singleton that can't live in the per-request MCP factory). It watches `knowledge.watch` folders (confined to `allowedRoots`), chunks + embeds `.md`/`.txt` via `knowledge.embeddings` (an OpenAI-compatible `/embeddings` endpoint, resolved by `resolveEmbeddingsConfig` with `LOCALLY_EMBEDDINGS_*` / default-agent fallbacks), and stores vectors in a `node:sqlite` + `sqlite-vec` DB at `knowledge.storePath` (default `~/.locally/knowledge.db`). Exposed as: a `knowledge_search` MCP tool on `/mcp`, JSON routes (`/knowledge/search`, `/knowledge/chunks`, `/knowledge/stats`), and a browse/search UI at `/knowledge`. **No auth** — bind to `127.0.0.1` (default) or front it with a reverse proxy. The indexer factors each file's folder path into the embedded text (`buildEmbedInput`: `Source: <humanized path>` + heading + content) so retrieval is location-aware. A misconfigured knowledge block logs and disables the feature without taking down the MCP server. Disabled/unset → fully inert (no routes, no tool, no DB).

## Practices
Try to use locally yourself when working in this repo - but check its work.

For codebase Q&A, "where is X", how-something-works, and naming-convention sweeps, prefer delegating to `explore_task` (set `breadth` to `very thorough` for wide sweeps) instead of spawning a native Explore subagent — then verify the result before relying on it.

When adding or updating functionality, before committing, check that the README is still accurate and doesn't need updating.

## Evals

We periodically benchmark locally against the native frontier-model agents (Explore for exploration, the main loop for run/generation tasks) to track how much quality we trade for the cost savings. Stored runs live in `eval-runs/` as dated Markdown files, each with the test definition, both verbatim outputs, and an evaluation section (qualitative notes + a quantitative inaccuracy count verified against source).

Run one with the `/run-eval` skill (`.claude/skills/run-eval/`). The method: give both agents the **identical** prompt, capture both outputs into one dated `eval-runs/` file, verify the points where they disagree (plus a sample of high-specificity claims) against source, then score hard vs. minor inaccuracies for each. First run: `eval-runs/2026-06-28-codebase-tour-locally-vs-explore.md` (exploration; ended 1 hard error each, locally ~15x cheaper). We expect to cover exploration, documentation, and code generation over time.