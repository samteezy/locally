<!--
test:
  id: codebase-tour-ste
  category: exploration          # exploration | documentation | code-generation
  subject-under-test: locally explore_task (very thorough), v0.6.1 STE-rewritten prompts
  baseline: native Explore subagent
  identical-prompt: true         # both agents receive the same prompt verbatim
  scoring: inaccuracy-count       # hard vs. minor, verified against source
  pass-criteria: |
    locally's hard-inaccuracy count is <= baseline's, AND locally's architecture
    spine (transport -> server -> tool -> loop -> client) matches source.
  result: FAIL                    # locally 2 hard / 2 minor; Explore 0 hard / 2 minor
  note: |
    Re-run of the 2026-06-28 codebase-tour prompt after the 0.6.1 Simplified Technical
    English rewrite of every prompt, description and report line. NOT a controlled
    comparison with that run - see "What this run cannot tell you".
-->

# Eval: In-depth codebase tour after the STE prompt rewrite — locally `explore_task` vs. native Explore agent

- **Date:** 2026-08-29
- **Task type:** Exploration / documentation (codebase Q&A)
- **Prompt (both agents):** Give an in-depth tour of the codebase covering (1) architecture & request flow, (2) each tool + how the agentic loop dispatches/caches tool calls, (3) config loading & agent resolution incl. env fallbacks/timeouts, (4) the OpenAI client, (5) error categorization (`LocallyError`) + usage reporting — with `file:line` citations.
- **locally run:** `explore_task`, `breadth: "very thorough"`, `path: src/`, agent `summarizer` → `ornith-1.0-9b-q6_k_xl`
- **Explore run:** native Explore subagent (frontier model), breadth "very thorough"
- **Cost:** locally = ~416k read locally / ~13k returned, 7 iterations, 44 files read, 4m49s. Explore = ~120k frontier tokens, 25 tool uses, 3m12s.
- **Why this run:** v0.6.1 rewrote the `explore_task` contract, every tool and parameter description, the verification footers and the error text in Simplified Technical English (ASD-STE100). The question was whether the rewrite changed answer accuracy.

---

## Output A — locally (`explore_task`, very thorough)

> Footer reported by the tool: `_locally · ornith-1.0-9b-q6_k_xl · 7 iters · 44 files read · 4m49s · ~416k read locally · ~13k returned_`

I've now read all 44 source and test files. Here is the complete tour.

---

### 1. Architecture & Request Flow

**Entry point** (`src/index.ts:1-41`): `main()` loads config, resolves transport mode (`--transport` flag → `LOCALLY_TRANSPORT` env → `config.transport.mode` → `"stdio"`), validates the `allowedRoots` fence, and starts either `startStdio` or `startHttp`. Fatal errors print the message plus a `Fix:` line if it's a `LocallyError` (`src/index.ts:31-41`).

**Config loading** (`src/config.ts:103-135`): `resolveConfigPath()` checks `LOCALLY_CONFIG` env → `cwd/locally.config.json` → `~/.locally/config.json`. `loadConfig()` parses JSON; parse failures print a warning but do not abort. Defaults fill in `default.baseUrl: "http://localhost:11434/v1"`, empty `model`, empty `apiKey`.

**Transport selection** (`src/config.ts:185-198`): `--transport` flag → `LOCALLY_TRANSPORT` env → `config.transport.mode` → `"stdio"`.

**Stdio transport** (`src/transport/stdio.ts:1-14`): `serveStdio` from the MCP SDK. One factory per connection. Era decision (2025 vs 2026-07-28) made by the opening handshake; `legacy` defaults to `'serve'`, so 2025-era hosts keep working.

**HTTP transport** (`src/transport/http.ts:39-128`): Node `http` server on `port` (default 3000) / `host` (default `127.0.0.1`). Routes `/health` → JSON status, `/mcp` → MCP handler. DNS-rebinding guards (`hostHeaderValidation`, `originValidation` from `@modelcontextprotocol/node`). Auth token checked before body read. Body capped at 1MB.

**Server factory** (`src/server.ts:84-228`): `createServer(config)` builds an MCP `Server` with `tools` capability, `SERVER_INSTRUCTIONS` (the system prompt the model sees), and three tools: `explore_task`, `run_task`, `usage_report`. Each tool has a schema, annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`), and an `inputSchema`. `cacheHints` are set for `tools/list` and `server/discover` (1-hour TTL, public scope).

**Request dispatch** (`src/server.ts:158-225`): `tools/call` handler switches on `name`. Each tool call may carry `ctx.mcpReq._meta?.progressToken` for progress notifications, and `ctx.mcpReq.signal` for cancellation. Errors (unknown tool, thrown values) return `{ isError: true }` with formatted text.

**Tool invocation** (`src/tools/run-task.ts:7-9`, `src/tools/explore-task.ts:159-262`): Both call `runAgenticTask()` from `src/tools/agentic-task.ts:47-254`, which builds the conversation, seeds a directory tree (`buildTree` from `explore-files.ts`), wraps tools with the sandbox fence, and delegates to `runAgentLoop()` in `src/llm/agent-loop.ts:180-390`.

---

### 2. Tools & Agentic Loop Dispatch

#### 2.1 Tool definitions

**`AGENT_TOOLS`** (explore-only, `src/llm/agent-loop.ts:82-122`): `Grep`, `Glob`, `Read`. Each has a `ToolDefinition`, a handler imported from `../tools/`, and a `ToolFence` declaring `pathKey`, `mustExist`, `defaultsToTaskRoot`, `evidence`, `mergesIgnorePatterns`.

**`RUN_AGENT_TOOLS`** (run-only, `src/llm/agent-loop.ts:124-165`): All three of `AGENT_TOOLS` plus `write_file`, `patch_file`, `run_shell`.

**Per-tool handlers** (`src/tools/`):
- `Grep` → `grepFiles()` (`src/tools/explore-files.ts:617-700`): ripgrep first, grep fallback. Two-pass: honour `.gitignore` by default, widen with `--no-ignore` only if first pass is empty. Caps at 200 lines.
- `Glob` → `globFiles()` (`src/tools/explore-files.ts:513-563`): Same two-pass widening. Lists path · lines · size.
- `Read` → `readFile()` (`src/tools/read-file.ts:44-69`): Reads file, prefixes each line with absolute 1-based line number. Caps at 2000 lines.
- `Write` → `writeFile()` (`src/tools/write-file.ts:24-29`): Creates parent dirs, writes UTF-8.
- `Patch` → `patchFile()` (`src/tools/patch-file.ts:28-43`): `indexOf` exact substring, replaces, writes.
- `Run shell` → `runShell()` (`src/tools/run-shell.ts:52-106`): Whitelist of commands (`ls`, `pwd`, `wc`, `diff`, `git`, `npm`, `tsc`, `eslint`, `prettier`). Git subcommands restricted to `status`, `diff`, `log`, `show`, `blame`, `branch`, `tag`. Timeout 30s, 10K output cap. Git runs with `core.fsmonitor=` and `core.pager=cat`.

#### 2.2 Agentic loop (`src/llm/agent-loop.ts:180-390`)

**Loop structure**: `while (iterations < maxIterations)` runs one `runCompletionWithTools()` call, pushes the assistant turn (with `tool_calls`), awaits all tool calls in parallel (`Promise.all`), pushes each result as a `role: "tool"` message. When no tool calls are returned, the model's text is the final answer. If `maxIterations` is hit, a tool-less final call forces a text answer.

**Tool dispatch** (`src/llm/agent-loop.ts:212-259`): The `dispatch()` function:
1. Parses `argsJson` as JSON.
2. Builds cache key: `${name}:${JSON.stringify(parsedArgs)}`.
3. **Cache hit** → returns `(already retrieved — returning cached result)\n${cached}`.
4. **In-flight check** → if another call with the same key is pending, waits for it (no race, no duplicate execution).
5. Calls the handler, stores result in cache (LRU eviction at `MAX_CACHE_SIZE = 50`).
6. Errors return `Error: <message>`.

**Progress tracking** (`src/llm/agent-loop.ts:265-286`):
- `augmentProgress()` wraps `LocallyError` failures with iteration/token context.
- `throwIfCancelled()` checks the merged `AbortSignal` at the top of each iteration.
- `runCompletionWithTools()` (`src/llm/client.ts:66-213`) merges the caller's signal with a server-side timeout controller via `AbortSignal.any()`.

**Result object** (`src/llm/agent-loop.ts:37-75`): `AgentRunResult` carries `text`, `model`, `promptTokens`, `completionTokens`, `iterations`, `durationMs`, `cappedAtMaxIterations`, `filesRead`, `filesReadPaths`, `filesMatchedPaths`, `filesListedPaths`, `nudged`.

#### 2.3 `runAgenticTask` wrapper (`src/tools/agentic-task.ts:47-254`)

Resolves agent config, builds the message history, seeds a directory tree (`buildTree` from `explore-files.ts`), wraps each tool with the sandbox fence (validates `pathKey` against `assertWithinRoots`, merges `config.ignorePatterns` where declared), and calls `runAgentLoop`. Tracks `filesRead` (canonical paths from `read_file`), `filesMatched` (paths from grep/glob output), and `filesListed` (paths from Glob listing rows).

#### 2.4 System prompt composition (`src/tools/agentic-task.ts:127-129`)

`[agentConfig.systemPrompt ?? baseSystemPrompt, system_prompt].filter(Boolean).join("\n\n")`. An agent's own `systemPrompt` **replaces** the tool's contract wholesale (commented in `config.ts:16-19`). A caller's `system_prompt` is appended after.

---

### 3. Config Loading & Agent Resolution

**Config shape** (`src/config.ts:56-71`): `LocallyConfig` has `transport`, `default` (agent), `agents` (named overrides), `tools.explore`/`tools.run` (per-tool agent routing), `ignorePatterns`, `allowedRoots`.

**`loadConfig()`** (`src/config.ts:103-122`): Reads `locally.config.json` from `LOCALLY_CONFIG` → `cwd/locally.config.json` → `~/.locally/config.json`. Defaults fill in `default.baseUrl`, `default.model`, `default.apiKey`.

**`resolveAgentConfig(config, agentName?)`** (`src/config.ts:137-175`):
- **Priority**: `config.agents[agentName]` → `config.default` → `process.env.LOCALLY_BASE_URL` / `LOCALLY_MODEL` / `LOCALLY_API_KEY` → hardcoded defaults (`http://localhost:11434/v1`, `""`, `""`).
- `baseUrl`/`model`/`apiKey` use `??` so empty string is kept (not falsy-coerced).
- Sampling (`temperature`, `topP`), `maxIterations`, `systemPrompt`, `extraBody` are inherited from `default` but **agent overrides replace wholesale** (not merged), per the comments in `config.ts:170-172`.
- Throws with `Agent "X" not found in config. Available agents: ...` for unknown names.

**`resolveToolAgent(config, toolKey, paramAgent?)`** (`src/config.ts:177-183`): `paramAgent ?? config.tools[toolKey].agent`.

**`resolveTransportMode()`** (`src/config.ts:185-198`): `--transport` flag → `LOCALLY_TRANSPORT` env → `config.transport.mode` → `"stdio"`.

**`symbolCheckEnabled()`** (`src/config.ts:98-101`): Reads `LOCALLY_VERIFY_SYMBOLS` env on every call (not from config). Truthy for anything except `"0"`, `"false"`, `"off"`, `"no"` (case-insensitive, trimmed). Unrecognised values → check stays on (fail open).

**`effectiveRoots()`** (`src/tools/sandbox.ts:19-21`): `config.allowedRoots` if set and non-empty → `resolveRoots()` → canonical absolute paths via `realpathSync`. Missing roots are skipped; if none resolve, throws `LocallyError` (`category: "config"`, `fix: "set allowedRoots..."`).

**`assertWithinRoots()`** (`src/tools/sandbox.ts:59-102`): Resolves target, follows symlinks via `realpathSync`. For writes (`mustExist: false`), canonicalizes the parent directory instead. Checks `relative(root, canonical)` — empty or no `..` prefix and not absolute. Throws `LocallyError` (`category: "constraint"`) if outside.

---

### 4. OpenAI Client (`src/llm/client.ts`)

**`runCompletionWithTools()`** (`src/llm/client.ts:66-213`):
- Validates `config.model` — throws `LocallyError` (`category: "config"`, `retriable: false`) if empty.
- Builds URL: `${baseUrl.replace(/\/$/, "")}/chat/completions`.
- Request body: `model`, `messages`, optional `max_tokens`/`temperature`/`top_p`, `tools` (if provided) with `tool_choice: "auto"`, then `extraBody` merged last (so operator config can override endpoint-specific knobs).
- Headers: `Content-Type: application/json`, optional `Authorization: Bearer <apiKey>`.
- Timeout: `config.timeout ?? 600` seconds, via `AbortController`.
- Signal merging: `AbortSignal.any([controller.signal, signal])`.
- Error handling:
  - `AbortError` with caller's signal fired → `LocallyError("Task cancelled by the caller.", category: "cancelled", retriable: true)`.
  - `AbortError` otherwise → timeout → `LocallyError("LLM request timed out after Xs.", category: "timeout", retriable: true)`.
  - Network failure → `LocallyError("Failed to reach LLM endpoint at X: ...", category: "upstream", retriable: true)`.
  - `401`/`403` → `LocallyError("LLM endpoint authentication failed (HTTP X).", category: "config", retriable: false)`.
  - `5xx`/`429` → `LocallyError` with `retriable: true`.
  - Other `4xx` → `retriable: false`.
  - Unexpected response shape → `LocallyError` (`category: "upstream", retriable: false`).

**`runCompletion()`** (`src/llm/client.ts:215-221`): Calls `runCompletionWithTools` without tools, asserts `content` is a string.

---

### 5. Error Categorization & Usage Reporting

#### 5.1 `LocallyError` (`src/llm/errors.ts:15-54`)

**Categories** (`src/llm/errors.ts:15`): `"timeout" | "config" | "upstream" | "constraint" | "cancelled"`.

**Origin**: `"local"` (locally's config/limits) or `"upstream"` (the endpoint).

**`LocallyErrorOptions`** (`src/llm/errors.ts:17-23`): `category`, `origin`, `retriable: boolean`, `fix: string` (one concrete next step).

**`formatLocallyError()`** (`src/llm/errors.ts:46-54`): Renders as `[locally error: <category> — <origin>${retriable ? " · retriable" : ""}]\n<message>\nFix: <fix>`. Non-`LocallyError` throws render as `[locally error: internal — local]\n<message>\nFix: this is an unexpected error...`.

**Where errors originate**:
- `client.ts:73-79` — no model configured → `config`, `retriable: false`.
- `client.ts:137-153` — abort errors → `cancelled` (caller's signal) or `timeout`.
- `client.ts:155-163` — network failure → `upstream`, `retriable: true`.
- `client.ts:168-187` — HTTP errors → `config` (auth) or `upstream` (5xx/429).
- `client.ts:193-200` — bad response → `upstream`, `retriable: false`.
- `agent-loop.ts:280-286` — cancellation at loop top → `cancelled`.
- `agent-loop.ts:366-375` — exceeded max_iterations with no final content → `constraint`, `retriable: true`.
- `sandbox.ts:38-47` — no allowedRoots resolve → `config`, `retriable: false`.
- `sandbox.ts:89-99` — path outside roots → `constraint`, `retriable: false`.
- `auth.ts:57-66` — non-loopback bind without token → `config`, `retriable: false`.

#### 5.2 Usage reporting (`src/usage.ts`)

**Process-level counters** (`src/usage.ts:7-10`): `promptTokens`, `completionTokens`, `taskCount`. Survive across tool calls within a process. In stdio mode, per-session; in HTTP mode, since server start.

**`withUsageFooter(result)`** (`src/usage.ts:49-74`): Appends a footer to the result text: `<model> · <iterations> iters${cap} · <filesRead> files read · <duration> · ~<promptTokens> read locally · ~<completionTokens> returned`. Notes: prompt and completion tokens are reported **separately** (never summed), per issue #10. `cappedAtMaxIterations` is flagged as "(hit cap)".

**`formatUsageReport()`** (`src/usage.ts:77-90`): Returns cumulative summary for the `usage_report` tool. Explicitly attributes saving to completion tokens only: `~X is what actually stayed off the frontier model`.

**`resetUsage()`** (`src/usage.ts:18-22`): Exposed for tests; resets all counters.

---

### Verification Layer (`src/tools/verify-*.ts`)

Four post-run checks that run on `explore_task` results (skipped by env `LOCALLY_VERIFY_SYMBOLS=0`):

1. **`verifyCitations()`** (`src/tools/verify-citations.ts:257-311`): Extracts citations from four forms (block, inline `path:line`, table rows, prose "lines X-Y"). Resolves each via `FileResolver`. Reports "file not found" or "line out of range". Caps at 200 citations.

2. **`verifySymbols()`** (`src/tools/verify-symbols.ts:266-330`): Extracts distinctive identifiers from code spans (≥4 chars, underscore or case change). Three-pass search: bulk ripgrep → per-symbol unfiltered check → Node `listAllFiles` backstop. Only reports names that all three passes fail to find. Bias toward false pass.

3. **`verifyPaths()`** (`src/tools/verify-paths.ts:107-153`): Extracts file paths from code spans and table cells. Filters out library names (`node.js`, `vue.js`, etc.). Resolves via `FileResolver`.

4. **`verifyPlacement()`** (`src/tools/verify-placement.ts:224-307`): Pairs symbol names with their cited `path:line`. Loads the file, scans for the symbol within a structural window (±30 lines, ±200 lines hard cap). The load-bearing rule: if the symbol is absent from the cited file entirely, the check is silent. Reports when the nearest occurrence differs from the cited line.

**`FileResolver`** (`src/tools/resolve-path.ts:41-148`): Shared resolver across all four checks. Tries absolute path → resolve against task path → resolve against each root → basename search via `findFilesNamed()`. Caches line counts and file text.

---

**Citations**

- `src/index.ts:1-41` — entry point, config/transport resolution
- `src/config.ts:1-198` — config shapes, loadConfig, resolveAgentConfig, resolveToolAgent, resolveTransportMode, symbolCheckEnabled
- `src/server.ts:1-228` — MCP server factory, tool registration, tools/call dispatch
- `src/transport/stdio.ts:1-14` — stdio transport
- `src/transport/http.ts:1-128` — HTTP transport, /health, /mcp routing, auth
- `src/transport/auth.ts:1-88` — auth token resolution, loopback check, bearer check
- `src/llm/client.ts:1-221` — OpenAI chat-completions client, error categorization
- `src/llm/errors.ts:1-54` — LocallyError class, categories, formatLocallyError
- `src/llm/agent-loop.ts:1-390` — agent loop, tool dispatch, caching, parallel execution, AgentRunResult
- `src/tools/agentic-task.ts:1-254` — runAgenticTask wrapper, system prompt composition, sandbox wrapping, coverage tracking
- `src/tools/sandbox.ts:1-102` — effectiveRoots, resolveRoots, assertWithinRoots
- `src/tools/explore-files.ts:1-700` — Grep, Glob, buildTree, ignore policies, ripgrep/grep fallbacks
- `src/tools/read-file.ts:1-69` — readFile with line numbering
- `src/tools/write-file.ts:1-29` — writeFile
- `src/tools/patch-file.ts:1-43` — patchFile
- `src/tools/run-shell.ts:1-106` — shell allowlist, subcommand restrictions
- `src/tools/verify-citations.ts:1-311` — citation extraction (4 forms), FileResolver-based verification
- `src/tools/verify-symbols.ts:1-330` — three-pass symbol verification
- `src/tools/verify-paths.ts:1-153` — path extraction and existence check
- `src/tools/verify-placement.ts:1-307` — symbol/line pair verification with structural window
- `src/tools/resolve-path.ts:1-148` — FileResolver class
- `src/tools/answer-text.ts:1-49` — code spans, table rows, fence stripping
- `src/tools/git-ignore.ts:1-127` — git ignore policy, viewDenies
- `src/usage.ts:1-90` — process-level usage counters, withUsageFooter, formatUsageReport
- `src/tools/explore-task.ts:1-262` — explore_task with sweep floor, post-run verification
- `src/tools/run-task.ts:1-9` — run_task thin wrapper
- `src/tools/explore-task.ts:38-71` — EXPLORE_SYSTEM_PROMPT (the model's system prompt)

_Citations: 83 citations checked. Each one points to a real file and line._

_Files: 4 file paths checked. **2 do not exist anywhere in the tree**: `cwd/locally.config.json`, `~/.locally/config.json`. Treat the claims that describe them as invented._

_Placement: 13 of 33 symbol/line pairs checked. **1 names a symbol that its cited file keeps elsewhere**: `listAllFiles` is cited at `src/tools/verify-symbols.ts:266-330`, but the nearest occurrence in that file is line 230. The file is right and the line is not. Check the line again before you trust the claim._

_Coverage: this answer names 27 files that exist. The run opened, searched, or listed 26 of them. Described but never looked at: `locally.config.json`._

---
_locally · ornith-1.0-9b-q6_k_xl · 7 iters · 44 files read · 4m49s · ~416k read locally · ~13k returned_

---

## Output B — native Explore subagent

> Reported cost: ~120k frontier tokens, 25 tool uses, 3m12s.

# locally — codebase tour

`locally-mcp` v0.6.1: an MCP server that delegates codebase work to a small model behind an OpenAI-compatible endpoint. ~7,650 lines of TypeScript under `/root/projects/locally/src`, zero runtime deps beyond the two MCP SDK packages (`package.json:29-32`). Tests are colocated `*.test.ts`; build is tsup ESM → `dist/index.js` with a shebang banner (`tsup.config.ts:5-12`).

---

### 1. Architecture & request flow

**Layering** (each layer only knows the one below):

```
index.ts → transport/{stdio,http}.ts → server.ts (MCP handlers)
        → tools/{explore-task,run-task}.ts → tools/agentic-task.ts (fence + evidence)
        → llm/agent-loop.ts (dispatch + cache) → llm/client.ts (fetch)
```

**Startup** — `/root/projects/locally/src/index.ts:7-29`: `loadConfig()`, then `resolveTransportMode()`, then it prints the active filesystem fence to stderr (`index.ts:14-16`) and loudly announces if the symbol check is off (`index.ts:20-22`). Resolving roots at startup is deliberate fail-fast on a bad `allowedRoots`. A fatal `LocallyError` prints its `fix` line before `exit(1)` (`index.ts:31-41`).

**stdio transport** — `/root/projects/locally/src/transport/stdio.ts:10-13`: `serveStdio(() => createServer(config))`. The SDK's opening exchange picks 2025-era (`initialize`) vs 2026-07-28 (`server/discover`) and pins one server instance per connection.

**HTTP transport** — `/root/projects/locally/src/transport/http.ts:39-128`. Order matters and is commented as such:
1. `resolveAuthToken` + `assertBindSafety(host, token)` *before* `listen` (`http.ts:46-47`).
2. `/health` is unauthenticated (`http.ts:66-70`).
3. On `/mcp`: Host + Origin validation (DNS-rebinding defence) at `http.ts:78`, then bearer check at `http.ts:83-90`, then a 1 MB-capped body read (`http.ts:8`, `readBody` at `http.ts:10-37`, 413 at `http.ts:99-104`), then `mcp(req, res, body)`.
4. Startup logs whether auth is on (`http.ts:125-127`).

Auth rules are pure functions in `/root/projects/locally/src/transport/auth.ts`: `resolveAuthToken` treats blank as unset (`auth.ts:25-28`); `isLoopbackHost` covers all of `127.0.0.0/8` and explicitly *excludes* `0.0.0.0`/`::` (`auth.ts:39-43`); `assertBindSafety` throws a `config` `LocallyError` with no override flag (`auth.ts:54-66`); `checkBearer` compares SHA-256 digests under `timingSafeEqual` so a length mismatch cannot throw and leak the secret's length (`auth.ts:76-88`).

**MCP server factory** — `/root/projects/locally/src/server.ts:84-227`. Identity `{ name: "locally", version: SERVER_VERSION }` where `SERVER_VERSION = "0.6.1"` (`server.ts:82`) is asserted against `package.json` by `server.test.ts`. `cacheHints` mark `tools/list` and `server/discover` as `ttlMs: 3_600_000, cacheScope: "public"` (`server.ts:94-97`).

**`tools/call` request flow** — `server.ts:158-225`:
- Progress: if the client sent `_meta.progressToken`, build an `onProgress` callback that emits `notifications/progress` with a monotonic counter; both sync throws and rejected sends are swallowed so a dropped heartbeat can't kill the task (`server.ts:164-182`).
- Cancellation: `ctx.mcpReq.signal` threaded straight through (`server.ts:187`).
- Dispatch switch: `explore_task` → `exploreTask`, `run_task` → `runTask`, `usage_report` → `formatUsageReport()`; unknown tool returns `isError: true` text (`server.ts:190-218`).
- Both task results are wrapped with `withUsageFooter(result)` (`server.ts:197, 206`).
- One catch renders any throw via `formatLocallyError` with `isError: true` (`server.ts:219-224`).

---

### 2. Tools

#### MCP-facing tools (3)
Declared in the `tools/list` handler at `server.ts:101-156`, with honest annotations: `explore_task` is `readOnlyHint: true` (`server.ts:108-113`), `run_task` is `destructiveHint: true` (`server.ts:128-133`), `usage_report` is read-only + idempotent (`server.ts:145-150`). Schemas: `TASK_INPUT_SCHEMA` (`server.ts:24-56`) and `EXPLORE_INPUT_SCHEMA`, which adds `breadth: "medium" | "very thorough"` (`server.ts:58-75`).

#### Model-facing tools (6)
Defined as `AgentTool` records — definition + handler + **fence** — in `/root/projects/locally/src/llm/agent-loop.ts`:

| Tool | Definition | Handler | Fence (`pathKey`, `mustExist`, evidence) |
|---|---|---|---|
| `Grep` | `agent-loop.ts:84-95` | `grepFiles` | `path`, must exist, defaults to task root, `searchHits`, merges ignores |
| `Glob` | `agent-loop.ts:96-108` | `globFiles` | `path`, must exist, defaults to task root, `listing`, merges ignores |
| `Read` | `agent-loop.ts:109-121` | `readFile` | `path`, must exist, `read` |
| `write_file` | `agent-loop.ts:126-138` | `writeFile` | `path`, may not exist |
| `patch_file` | `agent-loop.ts:139-151` | `patchFile` | `path`, may not exist |
| `run_shell` | `agent-loop.ts:152-164` | `runShell` | `cwd`, must exist, defaults to task root |

`AGENT_TOOLS` (read-only three) is what `explore_task` gets; `RUN_AGENT_TOOLS = [...AGENT_TOOLS, write, patch, shell]` is what `run_task` gets (`agent-loop.ts:82`, `agent-loop.ts:124-165`). Tool names are `Grep`/`Glob`/`Read` on purpose — the industry-standard names a model has seen most in training (`agent-loop.ts:77-81`).

**`Grep`** — `/root/projects/locally/src/tools/explore-files.ts:617-700`. ripgrep when on PATH, `grep -rn -I` otherwise (`explore-files.ts:635-637`). Two passes: the first honours git's ignore rules but forces `--hidden`; the second runs only if the first matched nothing at all, drops ignores (`UNFILTERED_RG_ARGS = ["--hidden","--no-ignore"]`, `explore-files.ts:109`) and is capped at `WIDENED_CAP = 20` (`explore-files.ts:684-692`). Ignore globs are appended *last* because ripgrep is last-match-wins (`explore-files.ts:643-646`). `--` guards a pattern starting with `-` (`explore-files.ts:652-653`). Exit code 1 is normalized to `""` so the widening pass can even see an empty first pass (`explore-files.ts:660-670`). On the grep backend, output is post-filtered against the git view (`filterGrepOutput`, `explore-files.ts:590-606`), using `grepLinePath` to handle grep's `path-11-text` context form (`explore-files.ts:573-580`). Every result carries a `filterLabel` header saying which filter ran (`explore-files.ts:474-486`, emitted at `explore-files.ts:699`).

**`Glob`** — `explore-files.ts:513-563`. `listFilesWithRg` (`explore-files.ts:223-244`) or the Node `walkFiles` fallback (`explore-files.ts:292-333`), same empty→widen logic (`explore-files.ts:530-537`), rows rendered as `path · N lines · size` (`explore-files.ts:557-560`) — that exact shape is what `agentic-task.ts`'s listing regex parses back.

**`Read`** — `/root/projects/locally/src/tools/read-file.ts:44-69`. Absolute 1-based line numbering even under `offset` (`read-file.ts:40-42`), default cap `MAX_LINES_DEFAULT = 2000` (`read-file.ts:8`), and a "… N more lines" continuation footer (`read-file.ts:64-66`).

**`write_file`** — `/root/projects/locally/src/tools/write-file.ts:24-29`, `mkdir -p` then write. **`patch_file`** — `/root/projects/locally/src/tools/patch-file.ts:28-43`, first-occurrence exact string replace, throws if not found.

**`run_shell`** — `/root/projects/locally/src/tools/run-shell.ts:52-106`. Allowlist `ls, pwd, wc, diff, git, npm, tsc, eslint, prettier` (`run-shell.ts:17-24`), with sub-allowlists for git (`run-shell.ts:9`) and npm (`run-shell.ts:10`). `cat/head/find/grep/rg/echo` are deliberately excluded — `find -exec` is arbitrary execution (`run-shell.ts:12-16`). Git runs hardened: `-c core.fsmonitor= -c core.pager=cat`, `GIT_CONFIG_NOSYSTEM=1` (`run-shell.ts:79-82`). 30 s timeout, 10 k char output cap (`run-shell.ts:6-7`).

#### The agentic loop
`runAgentLoop` — `/root/projects/locally/src/llm/agent-loop.ts:180-390`.

- Setup: tool definitions array + `Map<name, handler>` (`agent-loop.ts:190-193`).
- **Cache**: `toolResultCache: Map<string, string>` keyed `` `${name}:${JSON.stringify(parsedArgs)}` `` — args are parsed once and re-stringified so whitespace-different-but-identical JSON hits (`agent-loop.ts:198-222`). Bound `MAX_CACHE_SIZE = 50` with FIFO eviction of the oldest inserted key (`agent-loop.ts:251-253`).
- **In-flight dedup**: a second `Map<string, Promise<string>>` collapses two identical calls in the *same parallel batch* into one execution (`agent-loop.ts:210`, `agent-loop.ts:232-236`, `agent-loop.ts:242-249`).
- A cache hit is still reported to `onProgress` as `(cached)` — a run looping on one call is exactly what a heartbeat should reveal (`agent-loop.ts:224-236`) — and the model sees the prefix `(already retrieved — returning cached result)`.
- Handler errors are caught and returned to the model as `Error: …` tool output rather than aborting the run (`agent-loop.ts:256-258`).
- **Parallel dispatch**: `Promise.all(turn.tool_calls.map(dispatch))`, results pushed back as `role: "tool"` messages *in call order* because the API requires each to follow its call (`agent-loop.ts:340-352`). The full assistant turn including `tool_calls` is pushed first (`agent-loop.ts:302-308`).
- **Cancellation**: `throwIfCancelled()` at the top of each iteration and before the forced final call, since tool calls and cache hits run between fetches (`agent-loop.ts:275-289, 356`).
- **Progress annotation on failure**: `augmentProgress` rewraps a `LocallyError` with "failed after N iteration(s), M tokens generated locally so far", preserving category/origin/retriable/fix (`agent-loop.ts:265-273`).
- **Draft-answer hook**: when the model returns text with no tool calls, `onDraftAnswer` may return a nudge string that gets pushed as a user turn to keep the loop running — only if iterations remain, since at the cap the model can't act on it (`agent-loop.ts:178`, `agent-loop.ts:310-322`).
- **Cap**: `MAX_ITERATIONS_DEFAULT = 10` (`agent-loop.ts:167`); on exhaustion, one final completion **without tools** to force text (`agent-loop.ts:355-362`), returning `cappedAtMaxIterations: true` and `iterations + 1` (`agent-loop.ts:376-389`). No text there is a `constraint` error (`agent-loop.ts:365-375`).
- The loop deliberately knows nothing about paths: it returns `filesRead: 0` / empty path arrays, which the caller overwrites (`agent-loop.ts:324-337`, `agent-loop.ts:56-75`).

#### The fence + evidence layer
`runAgenticTask` — `/root/projects/locally/src/tools/agentic-task.ts:47-254` — is where every tool gets wrapped:

- Agent config resolved (or reused if the caller passed `resolvedAgent`), `max_tokens` override applied (`agentic-task.ts:56-59`).
- Roots computed once via `effectiveRoots(config)`; the per-task `path` is explicitly *not* the fence (`agentic-task.ts:64-67`).
- System prompt composition: `agentConfig.systemPrompt ?? baseSystemPrompt`, then the caller's `system_prompt`, joined — an agent's own prompt **replaces** the tool contract rather than stacking (`agentic-task.ts:121-132`).
- Directory map: `buildTree(treeRoot, 5, ignoreDirs, gitIgnoreView(treeRoot))` injected into the **user** turn (some servers strip system messages), wrapped in "this map is where to start, not a boundary" text (`agentic-task.ts:134-166`).
- **Uniform wrapping driven by `ToolFence`** (`agentic-task.ts:168-219`): fill in the task root when the model omits the path (`agentic-task.ts:183-192`), `assertWithinRoots(requested, roots, { mustExist })` and substitute the canonical path (`agentic-task.ts:194-195`), merge config `ignorePatterns` into `ignore_patterns` (`agentic-task.ts:197-199`), then record evidence by fence kind (`agentic-task.ts:203-214`). The `ToolFence` type exists precisely because this used to be a `switch` on tool names whose `default:` returned the tool *unwrapped* — renaming a tool would have silently dropped it out of the sandbox (`agent-loop.ts:10-29`).
- Evidence sets: `filesRead` (canonical paths from `Read`), `filesMatched` (parsed out of `path:line:` rows, `recordSearchHits` at `agentic-task.ts:95-104`), `filesListed` (parsed from Glob's `name · N lines · size` rows, `agentic-task.ts:110-119`). Both scans are bounded by `MAX_SCANNED_HITS = 400` (`agentic-task.ts:10`). A memoized `canonicalise` avoids repeat `realpath` calls (`agentic-task.ts:81-93`).
- Sweep floor → `onDraftAnswer`, firing at most once per run (`agentic-task.ts:221-235`).
- The loop's zeroed counters are replaced with the real ones on return (`agentic-task.ts:246-253`).

`assertWithinRoots` — `/root/projects/locally/src/tools/sandbox.ts:59-102`: `realpath` before the containment test so a symlink pointing out is rejected; for writes it canonicalizes the parent and re-attaches the basename, since `realpath` throws on a not-yet-existing file. Containment is a `relative()` test, not a string prefix (`sandbox.ts:84-87`). Failure is a `constraint` `LocallyError` (`sandbox.ts:89-99`). `effectiveRoots` defaults to `[process.cwd()]` (`sandbox.ts:19-21`); `resolveRoots` fails closed if *no* root resolves (`sandbox.ts:37-48`).

#### `explore_task` and its post-processing
`exploreTask` — `/root/projects/locally/src/tools/explore-task.ts:159-262`.

- `EXPLORE_SYSTEM_PROMPT` (`explore-task.ts:38-71`) is the contract: search-first, `LIKELY:` prefix for unread claims, "findings, not an assessment", and a trailing `<citations>` block.
- Breadth: prompt guidance (`explore-task.ts:73-77`) plus iteration budget `medium: 8, very thorough: 20` (`explore-task.ts:79-82`). Precedence: explicit `max_iterations` → agent `maxIterations` → breadth default (`explore-task.ts:170-171`).
- `THOROUGH_FLOOR = { minIterations: 6, minFilesRead: 5 }` (`explore-task.ts:92`), applied only when the budget exceeds it (`explore-task.ts:175-176`); `sweepNudge` text at `explore-task.ts:97-105`.
- Post-run: one shared `FileResolver` for all checks (`explore-task.ts:191`), `renderCitationBlock` turns the tagged block into plain markdown (`explore-task.ts:195`), then four checks each in its own `try/catch` — *verification never sinks a good answer* (`explore-task.ts:203-251`). Checks 2-4 are gated on `symbolCheckEnabled()` (`explore-task.ts:214`). Skip sets prevent the same mistake being reported twice (`explore-task.ts:224`, `explore-task.ts:237`).
- Shallow-sweep note appended when a "very thorough" run finished under the floor (`explore-task.ts:107-112`, `explore-task.ts:253-258`).
- `coverageNote` (`explore-task.ts:126-157`): files the answer *names* that the run never read/matched/listed. Citing a line requires read-or-search evidence; merely naming a file is satisfied by a listing (`explore-task.ts:147-151`).

Checkers: `verify-citations.ts` (block + inline union, table/prose fallbacks — `verify-citations.ts:205-218`; range check `verify-citations.ts:232-250`), `verify-paths.ts` (extension allowlist `verify-paths.ts:26-32`, `NOT_FILES` guard for `Node.js` etc. `verify-paths.ts:38-41`), `verify-symbols.ts` (three widening passes, nothing called missing until all three fail — bulk `searchRoot` `verify-symbols.ts:122-150`, per-name unfiltered `existsAlone` `verify-symbols.ts:187-203`, in-process `scanTree` backstop `verify-symbols.ts:218-259`, orchestrated at `verify-symbols.ts:266-306`), `verify-placement.ts` (symbol-near-cited-line; the load-bearing "absent from its cited file ⇒ silent" rule at `verify-placement.ts:263-265`, structural window at `verify-placement.ts:197-218`). All four stay silent on a clean run except the citation line.

Shared plumbing: `answer-text.ts` (fence/code-span/table parsing, `answer-text.ts:18-48`), `resolve-path.ts` `FileResolver` (absolute → task path → roots → by-name search; caches lines, text ≤2 MB, and canonical spellings — `resolve-path.ts:41-147`), `git-ignore.ts` (one `git ls-files --others --ignored --exclude-standard --directory` spawn; a **deny** set that fails open, `git-ignore.ts:66-105`; ancestor walk at `git-ignore.ts:119-127`).

---

### 3. Config loading & agent resolution

**File discovery** — `resolveConfigPath` (`/root/projects/locally/src/config.ts:124-135`): `LOCALLY_CONFIG` → `./locally.config.json` → `~/.locally/config.json` → none.

**`loadConfig`** (`config.ts:103-122`): a parse failure is a **warning on stderr, not a throw** (`config.ts:110-112`) — you fall through to the env-only default. With no file at all, the default block is built from `LOCALLY_BASE_URL` (fallback `http://localhost:11434/v1`), `LOCALLY_MODEL` (fallback `""`), `LOCALLY_API_KEY` (`config.ts:115-121`). Config is read **once at startup** (`index.ts:8`) — editing it requires reconnecting the server, which is why several `fix` strings say so.

**`resolveAgentConfig`** (`config.ts:137-175`) — two-level merge:
1. Base from `config.default`, with per-field env fallback for exactly three fields: `baseUrl`/`model`/`apiKey` (`config.ts:139-141`). `maxTokens` and `timeout` have **no** env fallback (`config.ts:142`, `config.ts:153`).
2. No agent name → the default block plus inherited `systemPrompt`/`temperature`/`topP`/`extraBody`/`maxIterations` (`config.ts:144-154`).
3. An unknown agent name **throws** a plain `Error` listing available agents (`config.ts:157-159`) — note: a plain `Error`, so it renders through `formatLocallyError`'s "internal" branch.
4. Otherwise field-by-field `override.X ?? base.X`, except `extraBody`, which is replaced wholesale rather than merged (`config.ts:161-174`).

**`resolveToolAgent`** (`config.ts:177-183`): per-call `agent` param → `config.tools[explore|run].agent` → `undefined` (the global default).

**`resolveTransportMode`** (`config.ts:185-198`): `--transport <mode>` argv flag → `LOCALLY_TRANSPORT` env → `config.transport.mode` → `"stdio"`.

**`symbolCheckEnabled`** (`config.ts:98-101`): env-only by design — `LOCALLY_VERIFY_SYMBOLS` in `{0,false,off,no}` disables it. The comment at `config.ts:86-97` explains why it isn't a config key (`LocallyConfig` is the parsed file verbatim, so no env could reach it) and why it isn't a call parameter (an answer must not switch off its own fact-checking).

**Other env fallbacks**: `LOCALLY_PORT` / `LOCALLY_HOST` (`http.ts:40-41`), `LOCALLY_AUTH_TOKEN` (`auth.ts:26`).

**Timeouts**, all separate and none env-configurable: LLM request `timeout` seconds, default **600** (`client.ts:119`); shell 30 s (`run-shell.ts:6`); git ignore probe 5 s (`git-ignore.ts:36`); HTTP body cap 1 MB (`http.ts:8`); search `maxBuffer` 10 MB (`explore-files.ts:663`).

---

### 4. The OpenAI client

`/root/projects/locally/src/llm/client.ts` — plain `fetch`, no SDK. Types: `LlmConfig`, `ToolDefinition`, `ToolCall`, `Message`, `Usage`, `AssistantTurn` (`client.ts:3-50`).

`runCompletionWithTools(config, messages, tools?, signal?)` (`client.ts:66-213`):
- Empty model → `config` `LocallyError` before any network call (`client.ts:72-79`).
- URL is `baseUrl` with trailing slash stripped + `/chat/completions` (`client.ts:81`).
- Body assembled conditionally: `max_tokens`, `temperature`, `top_p` are sent only when set, so "the endpoint decides" stays the default (`client.ts:88-98`); `tools` + `tool_choice: "auto"` only when tools exist (`client.ts:100-103`); **`extraBody` is `Object.assign`ed last** so the operator can override anything, including `max_tokens` under a different spelling (`client.ts:105-109`).
- `Authorization: Bearer` only when an apiKey is set (`client.ts:115-117`).
- **Signal merging**: a `setTimeout`-driven `AbortController` merged with the caller's signal via `AbortSignal.any` (`client.ts:119-126`). In the catch, cancellation vs timeout is disambiguated by *which* controller fired: caller aborted and timer did not ⇒ `cancelled`; anything else ⇒ `timeout` (`client.ts:137-153`). `clearTimeout` in `finally` (`client.ts:164-166`).
- Network failure ⇒ `upstream`/`upstream`/retriable, naming the URL (`client.ts:155-163`).
- 401/403 ⇒ `config` (not upstream), non-retriable, pointing at `apiKey`/`LOCALLY_API_KEY` (`client.ts:169-176`). Other non-OK: `transient = status >= 500 || status === 429` drives both `retriable` and the `fix` text (`client.ts:177-187`).
- Non-OpenAI-shaped response ⇒ `upstream`, non-retriable (`client.ts:193-200`).
- Usage mapped snake_case → camelCase with `?? 0` defaults, `undefined` when the endpoint reports none (`client.ts:205-211`).

`runCompletion` (`client.ts:215-221`) is a text-only convenience wrapper — currently exported but not called anywhere in `src/` outside tests.

---

### 5. Error categorization & usage reporting

**`LocallyError`** — `/root/projects/locally/src/llm/errors.ts:25-33`, carrying four fields beyond the message: `category`, `origin`, `retriable`, `fix`.

`LocallyErrorCategory = "timeout" | "config" | "upstream" | "constraint" | "cancelled"` (`errors.ts:15`). The doc block at `errors.ts:1-14` states the contract: the category exists so the caller can decide what to do **without parsing prose**. `origin` is `"local"` (locally's config/limits) or `"upstream"` (the endpoint); `fix` is exactly one concrete next step.

Where each is thrown:
- `timeout` — request exceeded `timeout` seconds (`client.ts:148-153`).
- `cancelled` — caller aborted, in the client (`client.ts:141-146`) and between loop iterations (`agent-loop.ts:280-285`).
- `config` — no model (`client.ts:73-78`), 401/403 (`client.ts:170-175`), unresolvable `allowedRoots` (`sandbox.ts:38-46`), non-loopback bind without a token (`auth.ts:57-65`).
- `upstream` — endpoint unreachable (`client.ts:155-162`), non-OK status (`client.ts:180-187`), unexpected response shape (`client.ts:194-199`).
- `constraint` — path outside `allowedRoots` (`sandbox.ts:90-98`), iteration cap with no final content (`agent-loop.ts:366-374`).

**`formatLocallyError`** — `errors.ts:46-52`. Renders `[locally error: {category} — {origin}[ · retriable]]\n{message}\nFix: {fix}`; anything not a `LocallyError` becomes `[locally error: internal — local]` with a generic fix. Called from the single `tools/call` catch (`server.ts:221`) and, for startup failures, `index.ts:37-39` prints the `fix` separately.

**Usage** — `/root/projects/locally/src/usage.ts`. Three module-level counters (`usage.ts:5-7`), process-lifetime, reset only by `resetUsage()` for tests (`usage.ts:18-22`). In stdio that's per-session; in HTTP it spans all clients, hence the "since server start" wording (`usage.ts:3-4`).

`withUsageFooter(result)` (`usage.ts:49-74`) increments the counters, then appends one line:

```
_locally · {model} · {N} iters[ (hit cap)] · {N} files read · {duration} · ~{X} read locally · ~{Y} returned_
```

The `(hit cap)` marker is explicitly the signal the caller most needs (`usage.ts:54-56`); `filesRead` comes from `agentic-task.ts`'s evidence set; token counts are formatted by `fmtTokens` (`usage.ts:28-31`) and duration by `fmtDuration` (`usage.ts:33-36`); with no endpoint-reported usage the line reads "token usage not reported by endpoint" (`usage.ts:60-63`).

The central accounting decision is at `usage.ts:39-48`: **prompt and completion tokens are reported separately and never summed** — only completion tokens substitute for context the caller would otherwise have spent, so adding prompt tokens would overstate the saving. `formatUsageReport` (`usage.ts:77-90`) repeats that distinction in prose for the `usage_report` tool, and returns a plain "has not handled any tasks" line at zero (`usage.ts:79-81`).

---

### Cross-cutting notes worth knowing

- **A config-file parse error is non-fatal** (`config.ts:110-112`) — you get env-only defaults and a stderr warning, so a typo can look like "my agents disappeared" rather than a crash.
- **An unknown agent name throws a plain `Error`, not a `LocallyError`** (`config.ts:158`), so it surfaces to the caller under the `internal — local` tag rather than as `config`.
- **The tool-result cache is per-run**, created inside `runAgentLoop` (`agent-loop.ts:202`); nothing persists across `tools/call` invocations.
- **Cache eviction is insertion-order FIFO, not LRU** (`agent-loop.ts:251-253`) — a repeatedly-hit early entry can still be evicted.
- **`explore_task` output is post-processed and can grow**: `renderCitationBlock` rewrites the model's text, and up to five note lines may be appended (`explore-task.ts:260-261`) before the usage footer is added in `server.ts:197`.
- **Coverage exclusions are named file-by-file** (`vitest.config.ts:12-18`) so `transport/auth.ts` still counts while the two wiring files don't.

---

## Evaluation

Every contested claim below was checked against source with `grep`/`sed` at the cited line.

### Quantitative — inaccuracy table

| # | Claim | Ground truth | locally | Explore |
|---|---|---|---|---|
| 1 | Tool-result cache eviction policy | Insertion-order **FIFO**: `toolResultCache.delete(toolResultCache.keys().next().value!)` deletes the first-inserted key, and `Map.set` on an existing key does not reorder (`src/llm/agent-loop.ts:251-253`) | ❌ "LRU eviction at `MAX_CACHE_SIZE = 50`" | ✅ "FIFO eviction of the oldest inserted key", and calls it out again in cross-cutting notes |
| 2 | What `LOCALLY_VERIFY_SYMBOLS=0` disables | **Three** checks, not four. `verifyCitations` runs ungated at `explore-task.ts:203-208`; only symbols/paths/placement sit inside `if (symbolCheckEnabled())` at `explore-task.ts:214` | ❌ "Four post-run checks that run on `explore_task` results (skipped by env `LOCALLY_VERIFY_SYMBOLS=0`)" | ✅ "Checks 2-4 are gated on `symbolCheckEnabled()` (`explore-task.ts:214`)" |
| 3 | Names of the three write-side model tools | `write_file`, `patch_file`, `run_shell` (`agent-loop.ts:130`, `:143`, `:156`) | ⚠️ table says `Write` / `Patch` / `Run shell` (handlers and files correct) | ✅ exact names in its table |
| 4 | Scope of the "replaced wholesale, not merged" rule | The comment covers **`extraBody` only** (`config.ts:169-172`); the rest are scalars where "replace" is trivial | ⚠️ generalizes it to `temperature`, `topP`, `maxIterations`, `systemPrompt` and `extraBody` | ✅ "except `extraBody`, which is replaced wholesale rather than merged" |
| 5 | Note lines `explore_task` can append | **Six**: citation, symbol, path, placement, coverage, shallow-sweep (`explore-task.ts:207, 217, 228, 240, 248, 257`) | — (not claimed) | ⚠️ "up to five note lines may be appended" |
| 6 | `runCompletion` callers | Zero callers anywhere in `src/`, tests included (only the definition at `client.ts:215`) | ✅ "Calls `runCompletionWithTools` without tools" (no usage claim) | ⚠️ "not called anywhere in `src/` outside tests" — literally true, but implies test callers that do not exist |
| 7 | `MAX_CITATIONS` cap | 200 (`verify-citations.ts:89`) | ✅ "Caps at 200 citations" | — (not claimed) |
| 8 | Placement window constants | `WINDOW_FLOOR = 30`, `MAX_WINDOW_REACH = 200` (`verify-placement.ts:60,63`) | ✅ "±30 lines, ±200 lines hard cap" | ✅ "structural window at `verify-placement.ts:197-218`" |
| 9 | Symbol extraction rule | `MIN_SYMBOL_LENGTH = 4`, `INTERNAL_CASE_CHANGE_RE` (`verify-symbols.ts:39-43`) | ✅ "≥4 chars, underscore or case change" | ✅ three widening passes, correct order |
| 10 | `resolveAgentConfig` env fallback scope | `baseUrl`/`model`/`apiKey` only; `maxTokens`/`timeout` have none (`config.ts:139-142`, `:153`) | ✅ priority chain correct | ✅ and explicitly notes the two with no fallback |
| 11 | `??` vs `\|\|` in agent resolution | `??` throughout (`config.ts:139-141`) | ✅ "use `??` so empty string is kept (not falsy-coerced)" | — (not claimed) |
| 12 | Unknown agent name error type | Plain `Error`, not `LocallyError` (`config.ts:158`) | ⚠️ reports the throw and message, does not note the type | ✅ notes it renders under the `internal — local` tag |
| 13 | LLM timeout default | 600 s (`client.ts:119`) | ✅ | ✅ |
| 14 | Shell / git-ignore / maxBuffer limits | 30 s (`run-shell.ts:6`), 5 s (`git-ignore.ts:36`), 10 MB (`explore-files.ts:663`) | ✅ shell only | ✅ all three |
| 15 | grep fallback flags | `["-rn", "-I", "--color=never"]` (`explore-files.ts:637`) | ✅ "ripgrep first, grep fallback" | ✅ exact flags |
| 16 | `WIDENED_CAP` | 20 (`explore-files.ts:467`) | ✅ describes the widening, no number | ✅ names the constant and value |
| 17 | Repo size | 7,650 lines under `src/` | — | ✅ "~7,650 lines" |
| 18 | Architecture spine | index → transport → server → tool → agentic-task → loop → client | ✅ | ✅ |

**Totals**

| | Hard | Minor |
|---|---|---|
| **locally** | **2** (#1, #2) | **2** (#3, #4) — plus #12 as an omission, not an error |
| **Explore** | **0** | **2** (#5, #6) |

**Result: FAIL.** The pass criterion is locally's hard count ≤ the baseline's. It is 2 vs 0. The second criterion passes: the architecture spine matches source exactly.

### Qualitative

**Citations.** locally produced 83 citations and **all 83 resolved** to a real file and line — its best citation result in any stored run. The placement check caught one genuine mis-citation (`listAllFiles` cited into `verify-symbols.ts:266-330`; the nearest occurrence is line 230 — right file, wrong range). Explore's citations are denser and more precise still, frequently citing exact line spans for a single behaviour rather than a whole file.

**Depth.** locally read 44 files across 7 iterations and covered the verification layer, the sandbox, and the auth module — territory that did not exist at the June run. Explore covered the same ground and added the two things locally omitted entirely: the `ToolFence`-replaced-a-`switch` rationale, and the ordering constraints inside the HTTP request path.

**The shared blind spot moved.** In the 2026-06-28 run, **both** agents called the cache eviction "LRU". Explore has since learned to look: it now says FIFO and repeats the correction in its closing notes. locally still says LRU. The blind spot did not disappear — it stopped being shared, which makes it a locally-specific error rather than a hard problem.

**Verifier noise.** The path checker flagged `cwd/locally.config.json` and `~/.locally/config.json` as files that do not exist. They are not file claims — they are the lookup order `resolveConfigPath` walks, written as pseudo-paths. Two false positives out of four paths checked is a poor ratio, and it is the checker's fault, not the model's. Worth an issue: a path fragment containing `~/` or a bare `cwd/` prefix is a description of a search path, not an assertion that a file exists.

**Contract compliance after the STE rewrite.** The rewritten contract held on the things it asks for: the answer is findings-only (no quality judgments, no severity ratings, no recommendations, no unasked-for summary section), it ends with a well-formed `<citations>` block, and no claim carries an unearned confidence marker. It did not use `LIKELY:` at all — consistent with a run that cited everything it claimed.

### What this run cannot tell you

This is **not** a controlled measurement of the prompt rewrite. Three variables moved between the 2026-06-28 baseline and this run:

1. **The codebase roughly doubled** — auth, sandbox, four verifiers, the split `Grep`/`Glob` tools and the v2 dual-era SDK are all new. More surface means more chances to be wrong.
2. **The model quantization changed**: `ornith-1.0-9b-q8_0` → `ornith-1.0-9b-q6_k_xl`.
3. **The tool surface changed**: one `explore_files` tool became `Grep` + `Glob`, and `Read` gained line numbering.

So "locally went from 1 hard error to 2" is not evidence that the STE rewrite hurt, and 83/83 resolving citations is not evidence that it helped. To isolate the prompt, the run would have to be repeated against the same commit with only `EXPLORE_SYSTEM_PROMPT` swapped — worth doing as a dedicated A/B before drawing any conclusion about the rewrite.

### Takeaway

locally remains strong at inventory and location work and produced its cleanest citation record yet, but both of its hard errors are the same species: a **mechanism described from its shape rather than from its code**. "Bounded map with eviction" reads as LRU; "four checks in a row" reads as four checks behind one switch. Both are what the code looks like from a distance, and both are wrong at the line the answer cites. This is exactly the failure the `LIKELY:` marker exists for, and the model used it zero times.

Practical consequence for `CLAUDE.md`'s standing advice: keep sending inventory and location questions to `explore_task`, and keep verifying any claim about *policy* — eviction order, gating, precedence — against source yourself. The citation checker cannot catch these, because both wrong claims cite a real line that really exists.

### Method recap (repeatable)

1. Same prompt string, verbatim, to both agents. No rewording.
2. locally: `explore_task`, `breadth: "very thorough"`, `path: src/`. Baseline: native Explore subagent, breadth "very thorough".
3. Collect every point where the two disagree, plus a sample of high-specificity claims (constants, defaults, precedence chains, error types).
4. Check each one against source at the cited line. Unverified scoring is worthless.
5. Score hard vs. minor per agent. Report PASS/FAIL against the stated criteria, and state plainly which variables were not held constant.
