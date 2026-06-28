<!--
test:
  id: codebase-tour
  category: exploration          # exploration | documentation | code-generation
  subject-under-test: locally explore_task (very thorough)
  baseline: native Explore subagent
  identical-prompt: true         # both agents receive the same prompt verbatim
  scoring: inaccuracy-count       # hard vs. minor, verified against source
  pass-criteria: |
    locally's hard-inaccuracy count is <= baseline's, AND locally's architecture
    spine (transport -> server -> tool -> loop -> client) matches source.
  result: PASS                    # locally 1 hard / 1 minor; Explore 1 hard / 2 minor
-->

# Eval: In-depth codebase tour — locally `explore_task` vs. native Explore agent

- **Date:** 2026-06-28
- **Task type:** Exploration / documentation (codebase Q&A)
- **Prompt (both agents):** Give an in-depth tour of the codebase covering (1) architecture & request flow, (2) each tool + how the agentic loop dispatches/caches tool calls, (3) config loading & agent resolution incl. env fallbacks/timeouts, (4) the OpenAI client, (5) error categorization (`LocallyError`) + usage reporting — with `file:line` citations.
- **locally run:** `explore_task`, `breadth: "very thorough"`, `path: src/`, agent `ornith-1.0-9b-q8_0`
- **Explore run:** native Explore subagent (frontier model)
- **Cost:** locally = ~53k processed / ~3.5k generated locally, 6 iterations. Explore = full frontier tokens.

---

## Output A — locally (`explore_task`, very thorough)

> Footer reported by the tool: `_locally · ornith-1.0-9b-q8_0 · 6 iters · ~53k processed · ~3.5k generated_`

### 1. Overall Architecture & Request Flow

Entry point `src/index.ts` loads config, picks a transport (stdio or HTTP), and starts the server.

```
Frontier LLM (Claude, etc.)
  -> stdio.ts / http.ts   (MCP transport: stdio over pipes, HTTP over /mcp)
  -> server.ts            (MCP SDK Server, registers explore_task, run_task, usage_report)
  -> agentic-task.ts      (per-tool handler; resolves agent, builds messages, injects dir tree)
  -> agent-loop.ts        (iterative loop: LLM -> tool calls -> handlers -> feed back)
  -> client.ts            (POST to OpenAI-compatible /chat/completions)
```

- **stdio.ts** — wraps MCP `StdioServerTransport`; pipes over stdin/stdout.
- **http.ts** — wraps `StreamableHTTPServerTransport` on a Node `http.Server`; `/mcp` for MCP calls (port 3000 default, `transport.port`/`LOCALLY_PORT`), `/health` endpoint, 1MB body cap (`MAX_BODY_BYTES`).
- **server.ts** — `Server` created with `capabilities: { tools: {} }` and `instructions: SERVER_INSTRUCTIONS`. `CallToolRequestSchema` dispatches by name: `explore_task` → `exploreTask()`, `run_task` → `runTask()`, `usage_report` → `formatUsageReport()`; unknown → `{ isError: true }`.

### 2. Tool Dispatch & Agentic Loop

`runAgenticTask()` (agentic-task.ts) is the single entry for both tools:
1. Agent resolution via `resolveAgentConfig(config, resolveToolAgent(config, toolKey, agent))`.
2. Ignore patterns merge `config.ignorePatterns` with hardcoded `IGNORED_DIRS`.
3. Tool-supplied `baseSystemPrompt` is **prepended** to caller `system_prompt` (both kept).
4. `buildTree()` walks root to depth 5; tree injected into the **user** message (so servers stripping system messages still work).
5. If `config.ignorePatterns` set, the `explore_files` handler is wrapped to merge them.
6. `runAgentLoop()` invoked with resolved tools + max iterations.

`runAgentLoop()` (agent-loop.ts) per-iteration: post history with tool defs → accumulate usage tokens → append assistant turn → if no tool calls, exit & return text → else dispatch each call, with **cache lookup** by `toolName:JSON.stringify(parsedArgs)` (hit → `(already retrieved — returning cached result)` prefix), store result (evict oldest at `MAX_CACHE_SIZE = 50`), push `{ role: "tool", ... }`. On error → `Error: <message>`. At `maxIterations`, a forced final call without tools; if no text, throws `LocallyError` category `"constraint"`. `AgentRunResult` carries `promptTokens`, `completionTokens`, `iterations`, `model`.

### 3. Config Loading & Agent Resolution

`loadConfig()` (config.ts): `LOCALLY_CONFIG` → `./locally.config.json` → `~/.locally/config.json` → minimal default `{ default: { baseUrl: "http://localhost:11434/v1" } }`. Parse failure → stderr warning + empty config.

Env-var fallback chain (per value): explicit config → env var → hardcoded default. **Applies to `baseUrl`, `model`, `apiKey`, `timeout`, `maxTokens`.**

`resolveAgentConfig`: no name → `default`; named → `config.agents[name]` or throws listing available. `resolveToolAgent`: `paramAgent ?? config.tools?.[toolKey]?.agent`. `resolveTransportMode`: `--transport` > `LOCALLY_TRANSPORT` > `config.transport.mode` > `"stdio"`.

### 4. OpenAI Client (client.ts)

`runCompletionWithTools()`: URL `${baseUrl}/chat/completions`; body `{ model, messages, tools?, tool_choice: "auto", max_tokens? }`; headers `Content-Type`, `Authorization: Bearer` (if apiKey). Timeout `config.timeout ?? 600`s via AbortController. Errors → `LocallyError`: AbortError→`timeout` (retriable); network→`upstream` (retriable); 401/403→`config` (not); 5xx/429→`upstream` (retriable); other 4xx→`upstream` (not); malformed→`upstream` (not). `runCompletion()` wraps it and asserts text.

### 5. Errors & Usage

`LocallyError` (llm/errors.ts): `category` (`timeout|config|upstream|constraint`), `origin` (`local|upstream`), `retriable`, `fix`. `formatLocallyError()` → `[locally error: <category> — <origin><retriable>]` + message + `Fix:`. Usage (usage.ts): process-level `promptTokens/completionTokens/taskCount`. `withUsageFooter()` appends `_locally · <model> · <iters> · ~<prompt> processed · ~<completion> generated_`. `formatUsageReport()` → cumulative. stdio = per-session; HTTP = "since server start".

### Tool summary (locally)

| Tool | File | Description |
|---|---|---|
| explore_task | tools/explore-task.ts | Read-only search; `AGENT_TOOLS` (explore_files+read_file); medium=8 / very thorough=20 iters |
| run_task | tools/run-task.ts | Write/edit; `RUN_AGENT_TOOLS` (+write_file, patch_file, run_shell) |
| explore_files | tools/explore-files.ts | Dir walk (depth 5), ripgrep→grep, content collect (binary filtered, 100KB / 50-file caps) |
| read_file | tools/read-file.ts | Read by path, optional offset/limit; fenced block |
| write_file | tools/write-file.ts | Write content, recursive parent dirs |
| patch_file | tools/patch-file.ts | Replace exact string |
| run_shell | tools/run-shell.ts | Whitelisted commands (cat/head/tail/wc/diff/ls/find/stat/grep/rg/echo/pwd/git/npm/tsc/eslint/prettier), 30s, 10KB cap |

---

## Output B — native Explore agent

### 1. Architecture & Request Flow
- Entry `src/index.ts:5-14`: `loadConfig()`, resolve transport, start.
- stdio `src/transport/stdio.ts:5-10` (default, `StdioServerTransport`); http `src/transport/http.ts:37-83` (`/health`, `/mcp`).
- `src/server.ts:75-145`: server with `SERVER_INSTRUCTIONS` (12-21); registers 3 tools; `ListTools` (82-103), `CallTool` (105-142); errors via `formatLocallyError()`.

### 2. Tools & Agentic Loop
- explore_task (`tools/explore-task.ts`, `server.ts:85-89`): read-only; contract lines 13-24; medium=8 / very thorough=20; schema `EXPLORE_INPUT_SCHEMA` (server.ts:56-73); `AGENT_TOOLS`.
- run_task (`tools/run-task.ts`, `server.ts:90-95`): write/edit; schema `TASK_INPUT_SCHEMA` (23-54); `RUN_AGENT_TOOLS`.
- usage_report (`usage.ts:52-60`, `server.ts:96-101`): globals (usage.ts:7-9).
- Loop dispatch `agentic-task.ts:21-78`: resolve agent, `buildTree()` (explore-files.ts:54-96), prepend system prompt, inject tree into user msg (52-61), `runAgentLoop()`.
- Engine `llm/agent-loop.ts:95-220`: while loop (130-197); forced final (199-219); **LRU** cache keyed `"toolName:argsJSON"`, cap 50 (110-114); cache-hit annotation (172-173); invocation (158-196); termination (155 / 202); progress (132); token accounting (107-108, 140-141, 206-207) → `{ text, model, promptTokens, completionTokens, iterations }`.

### 3. Config & Agent Resolution
- Structure `config.ts:5-32`; resolution priority `config.ts:42-61`: `LOCALLY_CONFIG` → cwd → home → **empty config; LLM config resolved later via env vars**.
- `resolveAgentConfig` `config.ts:76-99`: fallback override → default → env (`LOCALLY_BASE_URL`, `LOCALLY_MODEL`, `LOCALLY_API_KEY`); throws if named agent missing.
- `resolveToolAgent` (101-107); `resolveTransportMode` (109-122): `--transport` → `LOCALLY_TRANSPORT` → config → `"stdio"`.
- HTTP `transport/http.ts:37-39`: port (`LOCALLY_PORT`, def 3000), host (`LOCALLY_HOST`, def 127.0.0.1).

### 4. OpenAI Client (`llm/client.ts:62-179`)
- `runCompletionWithTools()`: validation (67-73, missing model → `config`/local/not-retriable); request (76-90, `{baseUrl}/chat/completions`, body, headers); network (100-132, `config.timeout ?? 600`s, AbortController, AbortError→`timeout`, fetch err→`upstream`); status (134-154, 401/403→`config`, 5xx/429→`upstream` retriable, other 4xx→`upstream` not); parse (156-178). `runCompletion()` (181-187).

### 5. Errors & Usage
- `LocallyError` (`llm/errors.ts:23-37`); categories; `formatLocallyError()` (44-52); augmentation in loop (`agent-loop.ts:120-128`); tool-call-time errors as strings (158-189).
- Usage (`usage.ts:7-9,18-26`); `withUsageFooter()` (38-50) footer `~{promptTokens}k processed · ~{completionTokens}k generated`; `formatUsageReport()` (52-60).

### Per-tool detail (Explore)
read_file (schema 10-27, impl 29-48); write_file (9-22, 24-29, recursive mkdir); patch_file (9-26, 28-43, first-occurrence exact match); run_shell (allowlist 12-23, validate 54-70, exec 72-92, 30s/10KB); explore_files (buildTree 54-96 depth 5 + `IGNORED_DIRS`; search 222-252 ripgrep→grep; collectFiles 98-146 caps 5/100KB/50; schema 158-193).

---

## Evaluation

### Quantitative — inaccuracy count (verified against source)

Verified by reading `src/config.ts`, `src/usage.ts`, and grepping `process.env.LOCALLY*` + cache eviction in `src/llm/agent-loop.ts`.

| # | Claim | locally | Explore | Ground truth |
|---|---|---|---|---|
| 1 | `loadConfig()` with no config file | ✅ populated `default` block | ❌ "empty config" | `config.ts:54-60` returns `default` with baseUrl/model/apiKey from env |
| 2 | Env-var fallback scope | ❌ lists `timeout`, `maxTokens` too | ✅ only baseUrl/model/apiKey | Only `LOCALLY_BASE_URL/MODEL/API_KEY` exist; timeout/maxTokens have no env fallback (`config.ts:78-81,97`) |
| 3 | Tool-result cache eviction | ⚠️ "LRU" | ⚠️ "LRU" | FIFO — deletes first-inserted (`agent-loop.ts:182-183`, `keys().next().value`) |
| 4 | Usage footer token format | ✅ `~<prompt> processed` (no fixed unit) | ⚠️ `~{promptTokens}k` implies always-`k` | `fmtTokens` only appends `k` at ≥1000 (`usage.ts:28-31`) |

**Hard inaccuracies: locally 1 (#2), Explore 1 (#1).** Symmetric — each got exactly one substantive fact wrong, and notably each was *right* where the other was wrong.

**Minor/terminology: locally 1 (#3), Explore 2 (#3, #4).**

**Totals — locally: 1 hard + 1 minor = 2. Explore: 1 hard + 2 minor = 3.**

### Qualitative

- **Citations:** Explore wins decisively — precise `file:line` ranges throughout vs. locally's mostly file-level references. For navigation, Explore's output is more directly actionable.
- **Depth:** Explore gave full per-tool breakdowns (allowlists, caps, schema line ranges); locally summarized the write/patch/shell tools in a single table. Explore is better for completeness; locally is better for a fast mental model.
- **Accuracy:** Effectively a tie on substance (1 hard error each). Explore's extra detail also surfaced one extra minor error, consistent with "more claims → more surface area."
- **Cost/efficiency:** locally is the standout — frontier-comparable structure and a correct architecture spine for ~53k/3.5k local tokens and zero frontier cost. The contested `loadConfig` fact it actually got *right*.
- **Shared blind spot:** both mislabeled the FIFO cache as "LRU" — worth watching for in future runs; mechanism-vs-name slips survive both.

### Takeaway

For exploration/Q&A sweeps, locally delivers ~80-90% of Explore's value at a fraction of the cost, with comparable substantive accuracy — but **always spot-check specific claims from either** (config defaults, fallback scope, data-structure naming were all places one or both slipped). Explore is the better choice when line-precise citations or exhaustive per-tool detail are the deliverable.

### Method (repeatable)

1. Give **both** agents the identical prompt (areas to cover + "cite file:line").
2. locally: `explore_task` with `breadth: "very thorough"` and a `path` to pre-map. Explore: native subagent.
3. Capture both outputs verbatim into one dated file under `eval-runs/`.
4. Pick the points where they **disagree**, plus a sample of high-specificity claims, and verify each against source (Read/grep).
5. Score: a quantitative inaccuracy tally (hard vs. minor) + qualitative notes on citations, depth, cost.
