<!--
test:
  id: agentic-loop-postcheck
  category: exploration          # exploration | documentation | code-generation
  subject-under-test: locally explore_task (very thorough) — issue #13 branch
  baseline: native Explore subagent
  identical-prompt: true         # both agents receive the same prompt verbatim
  scoring: inaccuracy-count       # hard vs. minor, verified against source
  pass-criteria: |
    locally's hard-inaccuracy count is <= baseline's, AND the issue #13 changes
    (symbol check, citation contract, CONFIRMED/LIKELY, footer) neither regress
    accuracy nor produce a false "does not appear in the tree" warning.
  result: PASS                    # locally 0 hard / 2 minor; Explore 0 hard / 0 minor
  follow-up: |
    Three further locally runs on the same prompt after rewording item 3. The rewording worked,
    and the re-runs exposed two false-positive bugs in the server-side checks — both fixed here.
    See "Follow-up" at the end.
-->

# Eval: Agentic-loop walkthrough — locally `explore_task` vs. native Explore agent

Run to check the issue #13 changes before merging: server-side symbol validation, the
zero-citation note, the `CONFIRMED`/`LIKELY` prompt bullets, the "name the search behind a list"
bullet, and the extended footer. The question in issue #13 is whether the added format burden
costs any of the accuracy the tool already had.

- **Date:** 2026-08-28
- **Task type:** Exploration (mechanism walkthrough + enumeration)
- **Prompt (both agents, verbatim):** In this repository, explain end to end how the agentic loop works: how a tool call is dispatched, how tool results are cached, how the loop terminates, how cancellation reaches the local model, and how tokens are counted. Also list every tool the explore path exposes to the model. Give a file:line citation for every claim.
- **locally run:** `explore_task`, `breadth: "very thorough"`, `path: /root/projects/locally`, agent `ornith-1.0-9b-q6_k_xl`
- **Explore run:** native Explore subagent (frontier model), breadth "very thorough"
- **Cost:** locally = ~138k read locally / ~5.8k returned, 7 iterations, 17 files, 1m54s. Explore = full frontier tokens, ~59k subagent tokens, 15 tool calls, 2m11s.

### How locally was invoked

The MCP server connected to this session was several builds stale, so `explore_task` was driven
in-process against the same endpoint and the same `locally.config.json` — identical code path
minus the stdio transport. **Anyone repeating this must reconnect the MCP server first**; config
and code are both read once at startup.

### One caveat about the baseline

The subject under test is this repository, so the native Explore agent read the new
`EXPLORE_SYSTEM_PROMPT` as *source* and picked up its conventions — it wrote "CONFIRMED
subtlety:" and closed with a "Method note" naming its own search. That is contamination from
evaluating a tool on its own repo. It does not affect the accuracy comparison, which is scored
against source, but it makes the two outputs **not comparable on format compliance**. Judge
locally's compliance on its own, not against the baseline.

---

## Output A — locally (`explore_task`, very thorough)

> Footer reported by the tool:
> `_locally · ornith-1.0-9b-q6_k_xl · 7 iters · 17 files read · 1m54s · ~138k read locally · ~5.8k returned_`
>
> Server-side checks appended to the answer:
> `_Citations: 54 citations checked, all resolve to a real file and line._`
> (no `Symbols:` line — every name it asserted was found)

## End-to-End Explanation of the Agentic Loop

### 1. How a Tool Call Is Dispatched

The dispatch chain runs from the MCP client down to the local model:

**MCP `tools/call` entry point** — `src/server.ts:144-211`. The server's `tools/call` handler receives the request, extracts the tool name and arguments, and dispatches to either `exploreTask` or `runTask` based on the name:

```
explore_task → exploreTask(config, params)  [src/server.ts:177-183]
run_task     → runTask(config, params)      [src/server.ts:186-192]
```

**Tool-key selection** — `src/tools/run-task.ts:7-9`:
```ts
export function runTask(config, params) {
  return runAgenticTask(config, params, "run", RUN_AGENT_TOOLS);
}
```
`explore_task` (in `src/tools/explore-task.ts:58-63`) calls `runAgenticTask` with `AGENT_TOOLS`, while `run_task` calls it with `RUN_AGENT_TOOLS`.

**Tool registration** — `src/llm/agent-loop.ts:109-121`:
```ts
const toolMap = new Map<string, AgentTool["handler"]>(
  tools.map((t) => [t.definition.function.name, t.handler])
);
```
A `Map` maps tool names to their handler functions. This is the dispatcher used inside the loop.

**Per-call path validation** — `src/tools/agentic-task.ts:105-157`. Before the loop even starts, each path-bearing tool's handler is wrapped with `assertWithinRoots(...)` so every call is confined to the configured `allowedRoots` (default: `process.cwd()`).

**Loop iteration** — `src/llm/agent-loop.ts:166`:
```ts
turn = await runCompletionWithTools(config, messages, toolDefs, signal);
```
The loop sends the current message history to the LLM endpoint. The response contains `tool_calls`, each with a `name` and JSON `arguments`.

**Handler invocation** — `src/llm/agent-loop.ts:218-223`:
```ts
const handler = toolMap.get(name);
if (!handler) {
  result = `Error: unknown tool "${name}"`;
} else {
  result = await handler(parsedArgs);
}
```
The parsed arguments are passed to the registered handler, which returns a string result.

### 2. How Tool Results Are Cached

**Cache structure** — `src/llm/agent-loop.ts:126-130`:
```ts
const MAX_CACHE_SIZE = 50;
const toolResultCache = new Map<string, string>();
```

**Cache key** — `src/llm/agent-loop.ts:209`:
```ts
const cacheKey = `${name}:${JSON.stringify(parsedArgs)}`;
```
Keyed by tool name + JSON-stringified parsed args (not the raw argument string). The parsed args are computed once per tool call at `src/llm/agent-loop.ts:204-208`.

**Cache hit** — `src/llm/agent-loop.ts:211-215`:
```ts
if (toolResultCache.has(cacheKey)) {
  onProgress?.(`[tool: ${name}] ${argsJson} (cached)`);
  result = `(already retrieved — returning cached result)\n${toolResultCache.get(cacheKey)!}`;
}
```
On a hit, the result is prefixed with `(already retrieved — returning cached result)` so the model knows it's cached. The iteration counter still increments (the loop continues).

**Cache eviction** — `src/llm/agent-loop.ts:224-227`:
```ts
if (toolResultCache.size >= MAX_CACHE_SIZE) {
  toolResultCache.delete(toolResultCache.keys().next().value!);
}
toolResultCache.set(cacheKey, result);
```
FIFO eviction: oldest entry deleted when the cap is reached.

### 3. How the Loop Terminates

Three termination paths, all in `src/llm/agent-loop.ts`:

**Early termination — model returns no tool calls** (`src/llm/agent-loop.ts:181-195`):
```ts
if (!turn.tool_calls || turn.tool_calls.length === 0) {
  // ...
  return { text: turn.content, model: config.model, promptTokens, completionTokens,
           iterations, durationMs, cappedAtMaxIterations: false, filesRead: 0 };
}
```
The loop ends immediately when the model's turn has no `tool_calls`. `cappedAtMaxIterations` is `false`.

**Early termination — cancellation** (`src/llm/agent-loop.ts:149-157`):
```ts
const throwIfCancelled = (): void => {
  if (!signal?.aborted) return;
  throw new LocallyError("Task cancelled by the caller.", {
    category: "cancelled", origin: "local", retriable: true,
    fix: "nothing to fix — re-run the task if the cancellation was not intended.",
  });
};
```
Called at the top of each iteration (`src/llm/agent-loop.ts:160`). Throws a `LocallyError` with `category: "cancelled"`.

**Termination via max iterations** (`src/llm/agent-loop.ts:240-272`):
```ts
while (iterations < maxIterations) { ... }
// Max iterations reached — call without tools to force a final text answer
finalTurn = await runCompletionWithTools(config, messages, undefined, signal);
```
When `iterations >= maxIterations`, the loop exits and makes one final call **without tools** (`undefined`), forcing the model to return only text. If the final call returns no string content, it throws `LocallyError` with `category: "constraint"`. The result has `cappedAtMaxIterations: true`.

**Default max iterations** — `src/llm/agent-loop.ts:107`: `MAX_ITERATIONS_DEFAULT = 10`. Override per breadth in `src/tools/explore-task.ts:39-42` (`medium: 8`, `very thorough: 20`).

### 4. How Cancellation Reaches the Local Model

**Origin** — `src/server.ts:173`:
```ts
const signal = ctx.mcpReq.signal;
```
The cancellation signal comes from the MCP client's `tools/call` request object.

**Propagation** — `src/tools/agentic-task.ts:32-39`:
```ts
export async function runAgenticTask(
  config, params, toolKey, tools
) {
  const { signal } = params;
  // ...
  const result = await runAgentLoop(agentConfig, messages, resolvedTools,
    max_iterations, onProgress, signal);
}
```

**Merged with timeout** — `src/llm/client.ts:102-108`:
```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
```
The caller's signal is merged with the timeout controller's signal via `AbortSignal.any()`. Either can abort the fetch.

**In-flight request abort** — `src/llm/client.ts:118-128`:
```ts
try {
  response = await fetch(url, { ..., signal: requestSignal });
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
    if (signal?.aborted && !controller.signal.aborted) {
      throw new LocallyError("Task cancelled by the caller.", {
        category: "cancelled", origin: "local", retriable: true,
        fix: "nothing to fix — re-run the task if the cancellation was not intended.",
      });
    }
    throw new LocallyError(`LLM request timed out after ${timeoutSecs}s.`, ...);
  }
}
```
If the caller's signal fires while the timeout hasn't, a `LocallyError` with `category: "cancelled"` is thrown — which propagates back through `augmentProgress` (`src/llm/agent-loop.ts:136-144`) to the MCP server as an `isError` tool result.

**Loop-level cancellation check** — `src/llm/agent-loop.ts:149-157` (see above). Even after the previous iteration's fetch completes, the loop checks `signal?.aborted` before starting the next iteration.

### 5. How Tokens Are Counted

**Per-call usage from the endpoint** — `src/llm/client.ts:187-193`:
```ts
usage: data.usage
  ? {
      promptTokens: data.usage.prompt_tokens ?? 0,
      completionTokens: data.usage.completion_tokens ?? 0,
      totalTokens: data.usage.total_tokens ?? 0,
    }
  : undefined,
```

**Accumulation in the loop** — `src/llm/agent-loop.ts:170-171`:
```ts
promptTokens += turn.usage?.promptTokens ?? 0;
completionTokens += turn.usage?.completionTokens ?? 0;
```
Both `promptTokens` and `completionTokens` are accumulated across every iteration.

**Final call accumulation** — `src/llm/agent-loop.ts:249-250`:
```ts
promptTokens += finalTurn.usage?.promptTokens ?? 0;
completionTokens += finalTurn.usage?.completionTokens ?? 0;
```

**Per-call result** — `src/llm/agent-loop.ts:188-190` (early return) and `src/llm/agent-loop.ts:265-267` (capped return):
```ts
return { text, model, promptTokens, completionTokens, iterations, durationMs,
         cappedAtMaxIterations, filesRead };
```

**Cumulative session counter** — `src/usage.ts:49-73`:
```ts
export function withUsageFooter(result: AgentRunResult): string {
  promptTokens += result.promptTokens;
  completionTokens += result.completionTokens;
  taskCount += 1;
  // ...
  return `${result.text}\n\n---\n_locally · ${parts.join(" · ")}_`;
}
```
Each result gets a footer appended with the model name, iteration count, files read, duration, and per-run token summary. Cumulative totals are tracked at the process level.

**Usage report** — `src/usage.ts:77-89`:
```ts
export function formatUsageReport(): string {
  const { taskCount, promptTokens, completionTokens } = getSessionStats();
  return [`locally has handled ${tasks} since this server started:`,
          `~${fmtTokens(promptTokens)} tokens read locally`,
          `~${fmtTokens(completionTokens)} tokens returned to the caller`,
          ...].join(" ");
}
```
The `usage_report` tool (registered in `src/server.ts:128-140`) reports cumulative totals.

### 6. Every Tool the Explore Path Exposes

The explore path uses `AGENT_TOOLS` from `src/llm/agent-loop.ts:40-65`:

| # | Tool Name | Source | Description |
|---|-----------|--------|-------------|
| 1 | **`explore_files`** | `src/llm/agent-loop.ts:40-52` → `src/tools/explore-files.ts:308` | Search file contents with ripgrep (or grep). Returns matching lines as `path:line:text`. Primary tool. |
| 2 | **`read_file`** | `src/llm/agent-loop.ts:53-64` → `src/tools/read-file.ts:44` | Read a file by absolute path. Output is line-numbered. Pass `offset`/`limit` for excerpts. |

That's it — **2 tools** for the explore path. The explore system prompt (`src/tools/explore-task.ts:16-31`) explicitly instructs the model to use only these two, and the tool set is read-only.

For comparison, the `run_task` path adds three more tools on top:

| # | Tool Name | Source | Description |
|---|-----------|--------|-------------|
| 3 | **`write_file`** | `src/llm/agent-loop.ts:67-80` → `src/tools/write-file.ts:24` | Write content to a file, creating parent directories. |
| 4 | **`patch_file`** | `src/llm/agent-loop.ts:81-92` → `src/tools/patch-file.ts:28` | Replace an exact string in a file. |
| 5 | **`run_shell`** | `src/llm/agent-loop.ts:93-104` → `src/tools/run-shell.ts:52` | Run a nondestructive shell command from an allowlist (`ls`, `pwd`, `wc`, `diff`, `git`, `npm`, `tsc`, `eslint`, `prettier`). |

### Summary of Key Constants

| Constant | File | Value |
|----------|------|-------|
| `MAX_ITERATIONS_DEFAULT` | `src/llm/agent-loop.ts:107` | 10 |
| `MAX_CACHE_SIZE` | `src/llm/agent-loop.ts:129` | 50 |
| `MAX_CONTEXT_LINES` | `src/tools/explore-files.ts:26` | 5 |
| `MAX_RESULTS_DEFAULT` | `src/tools/explore-files.ts:25` | 200 |
| `MAX_FILES_DEFAULT` | `src/tools/explore-files.ts:22` | 200 |
| `MAX_CONTENT_FILES_DEFAULT` | `src/tools/explore-files.ts:24` | 50 |
| Default timeout | `src/llm/client.ts:101` | 600 seconds |
| Shell timeout | `src/tools/run-shell.ts:6` | 30,000 ms |
| Shell max output | `src/tools/run-shell.ts:7` | 10,000 chars |
| Explore medium iterations | `src/tools/explore-task.ts:40` | 8 |
| Explore very thorough iterations | `src/tools/explore-task.ts:41` | 20 |

---

**Every claim above is CONFIRMED** — each file was read and every line cited corresponds to an actual line in the source.

_Citations: 54 citations checked, all resolve to a real file and line._

---
_locally · ornith-1.0-9b-q6_k_xl · 7 iters · 17 files read · 1m54s · ~138k read locally · ~5.8k returned_
---

## Output B — native Explore subagent

## End-to-end: the agentic loop in `locally`

### 1. Entry: MCP `tools/call` → tool function

The MCP server registers three tools and dispatches them in a single `tools/call` handler at `src/server.ts:144`. The switch routes `explore_task` → `exploreTask` (`src/server.ts:177-184`), `run_task` → `runTask` (`src/server.ts:186-193`), `usage_report` → `formatUsageReport` (`src/server.ts:195-197`); anything else returns `isError: true` (`src/server.ts:199-203`). Every throw is rendered as tagged prose by `formatLocallyError` (`src/server.ts:205-210`, formatter at `src/llm/errors.ts:46-54`).

Two per-call side channels are built before dispatch: an `onProgress` callback that emits `notifications/progress` only when the client supplied a `progressToken` (`src/server.ts:150-168`), and `signal = ctx.mcpReq.signal` (`src/server.ts:173`).

`exploreTask` composes the system prompt from a fixed contract (`src/tools/explore-task.ts:16-31`) plus breadth guidance (`src/tools/explore-task.ts:33-37`), picks an iteration budget from breadth — `medium: 8`, `very thorough: 20` — unless the caller passed `max_iterations` (`src/tools/explore-task.ts:39-42`, `src/tools/explore-task.ts:56`), then calls `runAgenticTask` with `AGENT_TOOLS` (`src/tools/explore-task.ts:58-63`). `runTask` is the same call with `RUN_AGENT_TOOLS` (`src/tools/run-task.ts:8`).

### 2. Setup: `runAgenticTask` (`src/tools/agentic-task.ts:32`)

- Resolves which endpoint/model to use (`src/tools/agentic-task.ts:41`), applying a per-call `max_tokens` override onto the agent config (`src/tools/agentic-task.ts:42-44`).
- Computes the filesystem fence `roots` — configured `allowedRoots` or `process.cwd()`, symlink-canonicalized (`src/tools/agentic-task.ts:52`, implementation `src/tools/sandbox.ts:19-21`).
- Seeds `messages`: an optional system message combining the tool's base prompt and the caller's `system_prompt` — both kept, not one replacing the other (`src/tools/agentic-task.ts:64-67`) — then a user message containing a depth-5 directory tree plus the task, explicitly labelled a starting point rather than a boundary (`src/tools/agentic-task.ts:79-100`).
- Wraps each path-bearing tool handler with `assertWithinRoots` before it runs (`src/tools/agentic-task.ts:105-157`). The containment check resolves symlinks and rejects escapes with a `constraint` `LocallyError` (`src/tools/sandbox.ts:59-101`).
- Calls `runAgentLoop` and overwrites `filesRead` with the count of distinct canonical paths opened (`src/tools/agentic-task.ts:159-160`); the set is filled by the `read_file` wrapper (`src/tools/agentic-task.ts:112-114`).

CONFIRMED subtlety: the `explore_files` wrapper does **not** call `t.handler`; it calls `exploreFiles` directly after merging config-level ignore patterns (`src/tools/agentic-task.ts:120-127`). Same function as the registered handler (`src/llm/agent-loop.ts:51`), so behavior matches, but the wrapping is a substitution rather than a delegation.

### 3. Tool-call dispatch (`src/llm/agent-loop.ts:109`)

Tools are flattened into an OpenAI `tools` array and a `name → handler` map once, up front (`src/llm/agent-loop.ts:118-121`). Each iteration:

1. Cancellation check, then increment and emit `[iteration n/max]` (`src/llm/agent-loop.ts:160-162`).
2. `runCompletionWithTools` (`src/llm/agent-loop.ts:166`); failures are re-thrown annotated with progress-so-far (`src/llm/agent-loop.ts:167-169`, `augmentProgress` at `src/llm/agent-loop.ts:136-144`).
3. The full assistant turn including `tool_calls` is pushed **before** any tool results, because the API requires that ordering (`src/llm/agent-loop.ts:173-179`).
4. For each tool call: parse `arguments` JSON (`src/llm/agent-loop.ts:204-208`), look up the handler by name, `await` it (`src/llm/agent-loop.ts:218-222`). An unrecognized name becomes the string `Error: unknown tool "<name>"` rather than a throw (`src/llm/agent-loop.ts:219-220`). Any thrown error — including sandbox violations — is caught and converted to an `Error: …` **tool result string** so the model self-corrects instead of the run aborting (`src/llm/agent-loop.ts:229-231`, rationale at `src/tools/agentic-task.ts:102-104`).
5. The result is appended as a `role: "tool"` message keyed to `toolCall.id` (`src/llm/agent-loop.ts:233-237`).

Tool calls in one turn are dispatched sequentially in a `for` loop, not in parallel (`src/llm/agent-loop.ts:197`).

### 4. Tool-result caching

The cache is a plain `Map<string,string>` created **inside** `runAgentLoop`, so it is per-run and never shared across MCP calls (`src/llm/agent-loop.ts:129-130`).

- Key: `` `${name}:${JSON.stringify(parsedArgs)}` `` — the args are re-serialized after parsing so whitespace-different but semantically identical JSON still hits (`src/llm/agent-loop.ts:209`, comment at `src/llm/agent-loop.ts:126-128`).
- Hit: the result is prefixed with `(already retrieved — returning cached result)` and a progress heartbeat is still emitted, marked `(cached)`, so a run stuck in a repeat-call loop is visible (`src/llm/agent-loop.ts:211-215`).
- Miss: run the handler, then evict the oldest entry if at `MAX_CACHE_SIZE = 50` before inserting — FIFO via `Map` insertion order, not LRU (`src/llm/agent-loop.ts:224-227`).
- CONFIRMED: the `unknown tool` error string *is* cached (it flows into the `toolResultCache.set` at `src/llm/agent-loop.ts:227`), but a handler that *throws* is not, because the `set` is skipped by the throw and handled at `src/llm/agent-loop.ts:229`.

Separately, `hasRipgrep()` memoizes the `which rg` probe process-wide (`src/tools/explore-files.ts:29-40`), and citation verification caches per-file line counts (`src/tools/verify-citations.ts:49-58`).

### 5. Loop termination

Five exits, all in `runAgentLoop`:

| Exit | Where | Result |
|---|---|---|
| Model returns text with no tool calls (normal finish) | `src/llm/agent-loop.ts:181-194` | `cappedAtMaxIterations: false` |
| Model returns neither tool calls nor text | `src/llm/agent-loop.ts:182-184` | plain `Error` throw |
| Budget exhausted → forced final call **with `tools` undefined** so the model must answer in prose | `src/llm/agent-loop.ts:241-245` | `cappedAtMaxIterations: true`, `iterations: iterations + 1` (`src/llm/agent-loop.ts:262-271`) |
| Forced final call still returns no content | `src/llm/agent-loop.ts:251-261` | `LocallyError` category `constraint`, retriable |
| Cancellation | `src/llm/agent-loop.ts:149-157` | `LocallyError` category `cancelled` |

Default budget is `MAX_ITERATIONS_DEFAULT = 10` (`src/llm/agent-loop.ts:107`, applied as the parameter default at `src/llm/agent-loop.ts:113`) — which is what `run_task` gets; `explore_task` overrides it per breadth (`src/tools/explore-task.ts:39-42`).

The cap flag exists specifically so the caller can distinguish "finished" from "ran out of budget" (`src/llm/agent-loop.ts:26-32`), and it surfaces in the footer as `(hit cap)` (`src/usage.ts:54-58`).

### 6. Cancellation reaching the local model

The chain, end to end:

1. `ctx.mcpReq.signal` — fires on an MCP cancellation *or* the transport closing (`src/server.ts:170-173`).
2. Passed into `exploreTask`/`runTask` as `params.signal` (`src/server.ts:181`, `src/server.ts:190`; typed at `src/tools/agentic-task.ts:19-24`).
3. Forwarded to `runAgentLoop` (`src/tools/agentic-task.ts:159`).
4. **Between iterations:** `throwIfCancelled()` runs at the top of every iteration (`src/llm/agent-loop.ts:160`) and again before the forced final call (`src/llm/agent-loop.ts:242`). This exists because tool calls and cache hits run between completions and would otherwise not notice until the next `fetch` (`src/llm/agent-loop.ts:146-148`).
5. **During an in-flight request:** the signal is passed to `runCompletionWithTools` (`src/llm/agent-loop.ts:166`, `src/llm/agent-loop.ts:245`), which merges it with its own timeout controller via `AbortSignal.any` and hands the merged signal to `fetch` (`src/llm/client.ts:102-117`). That is the point at which the abort actually reaches the local model endpoint's HTTP connection.
6. **Disambiguation:** on `AbortError`, a cancellation is reported only when the caller's signal fired and the timeout's did not; otherwise it stays a `timeout` error (`src/llm/client.ts:119-135`).

Both halves are covered by tests: an already-aborted signal prevents any `fetch` (`src/llm/agent-loop.test.ts:158-168`) and a mid-run abort stops after exactly one completion (`src/llm/agent-loop.test.ts:170-184`).

### 7. Token counting

- **Source:** the endpoint's OpenAI-shaped `usage` block is mapped to `{promptTokens, completionTokens, totalTokens}`, or left `undefined` if the endpoint omits it (`src/llm/client.ts:187-193`; response type at `src/llm/client.ts:55-59`). No local tokenizer exists in this repo — the counts are entirely endpoint-reported.
- **Accumulation:** the loop adds each turn's usage with `?? 0`, so a missing block contributes zero rather than `NaN` (`src/llm/agent-loop.ts:170-171`), and the forced final call is added the same way (`src/llm/agent-loop.ts:249-250`). Note the totals are *cumulative across iterations*, so a long conversation double-counts re-sent prompt context by design — `promptTokens` is "tokens the local model processed", not unique tokens (`src/llm/agent-loop.ts:18-21`).
- **Process totals:** three module-level counters incremented once per completed run in `withUsageFooter` (`src/usage.ts:7-9`, `src/usage.ts:50-52`). They reset on process restart; stdio mode makes them per-session, HTTP mode spans all clients (`src/usage.ts:3-6`).
- **Reporting rule:** prompt and completion tokens are reported separately and deliberately **never summed**, because only the completion tokens substitute for caller context (`src/usage.ts:44-47`, restated in the report text at `src/usage.ts:87-88`).
- **Footer:** `model · N iters[(hit cap)] · N files read · duration · ~Xk read locally · ~Yk returned`, or `token usage not reported by endpoint` when both are zero (`src/usage.ts:60-73`). Formatting helpers at `src/usage.ts:28-37`.
- **Cumulative report:** `formatUsageReport` (`src/usage.ts:77-89`), reached via the `usage_report` tool (`src/server.ts:195-197`).

Also note `max_tokens` is only sent when configured (`src/llm/client.ts:84-86`), fed from the agent config or the per-call override (`src/tools/agentic-task.ts:42-44`).

### 8. Explore-path post-processing (after the loop returns)

`exploreTask` appends up to three notes to the model's text (`src/tools/explore-task.ts:65-94`):

1. **Citation check** — every `path:line` is re-opened and the line-number range confirmed; annotated, never rewritten (`src/tools/explore-task.ts:69-74`, verifier rationale `src/tools/verify-citations.ts:4-15`, regex `src/tools/verify-citations.ts:25`, formatter `src/tools/verify-citations.ts:98-112`).
2. **Symbol check** — distinctive identifiers in inline code spans are grepped for existence anywhere in the tree; only zero-hit names are flagged (`src/tools/explore-task.ts:78-85`, rationale `src/tools/verify-symbols.ts:5-25`, candidate filter `src/tools/verify-symbols.ts:52-56`, formatter `src/tools/verify-symbols.ts:159-168`). Toggled by `LOCALLY_VERIFY_SYMBOLS` — an env var reachable only by whoever runs the server, not by the model (`src/config.ts:68-71`).
3. **Shallow-sweep warning** — a `very thorough` run that concluded in ≤2 iterations is labelled as narrow coverage (`src/tools/explore-task.ts:48`, `src/tools/explore-task.ts:87-91`).

Both verifiers are wrapped in bare `catch {}` so a broken check never sinks a good answer (`src/tools/explore-task.ts:72-74`, `src/tools/explore-task.ts:82-84`).

---

## Every tool the explore path exposes

### To the local model (the agentic loop's tool list)

`explore_task` passes `AGENT_TOOLS`, which is exactly **two** tools (`src/llm/agent-loop.ts:40-65`, passed at `src/tools/explore-task.ts:62`):

| Tool | Definition | Handler | Schema |
|---|---|---|---|
| `explore_files` | `src/llm/agent-loop.ts:44-50` | `src/llm/agent-loop.ts:51` → `src/tools/explore-files.ts:308` | `src/tools/explore-files.ts:254-306` |
| `read_file` | `src/llm/agent-loop.ts:56-61` | `src/llm/agent-loop.ts:63` → `src/tools/read-file.ts:44` | `src/tools/read-file.ts:16-33` |

`explore_files` has two modes: with `query` it shells out to ripgrep (falling back to grep) and returns `path:line:text` (`src/tools/explore-files.ts:341-348`, search impl `src/tools/explore-files.ts:411-443`); without `query` it returns a tree plus a file listing with line counts and sizes (`src/tools/explore-files.ts:350-397`). Params: `path` (required), `query`, `file_pattern`, `context_lines`, `max_results`, `max_matches_per_file`, `include_content`, `max_depth`, `max_file_size_kb`, `max_files`, `ignore_patterns` (`src/tools/explore-files.ts:240-252`). `read_file` params: `path` (required), `offset`, `limit`, output line-numbered absolutely so citations are copied not counted (`src/tools/read-file.ts:35-42`).

The explore path exposes **no** write, patch, or shell tool. `write_file`, `patch_file`, and `run_shell` exist only in `RUN_AGENT_TOOLS` (`src/llm/agent-loop.ts:67-105`), used solely by `run_task` (`src/tools/run-task.ts:8`). This is what backs the `readOnlyHint: true` annotation on `explore_task` (`src/server.ts:103-108`) versus `destructiveHint: true` on `run_task` (`src/server.ts:118-123`).

### To the MCP client (`tools/list`)

Three tools, all at `src/server.ts:96-142`: `explore_task` (`src/server.ts:99`), `run_task` (`src/server.ts:114`), `usage_report` (`src/server.ts:129`). `explore_task`'s input schema adds `breadth` to the shared task schema (`src/server.ts:53-70`, shared schema `src/server.ts:19-51`). The list response carries a 1-hour public cache hint (`src/server.ts:89-92`).

**Method note:** this enumeration comes from following `AGENT_TOOLS`/`RUN_AGENT_TOOLS` from their sole definition site plus a tree-wide grep for those identifiers and `runAgentLoop`/`runAgenticTask` (all call sites listed above are the complete grep output). The array is a module-level constant with no push/mutation sites, so the explore list of two is exhaustive.

> Paths normalised from absolute (`/root/projects/locally/src/...`) to repo-relative for readability; nothing else changed.

---

## Evaluation

### Quantitative — claims verified against source

Every claim below was checked by reading the cited lines. "✅" = correct, "⚠️" = imprecise but not wrong.

| # | Claim | locally | Explore | Ground truth |
|---|---|---|---|---|
| 1 | `run_shell` allowlist contents | ✅ | — | `ls, pwd, wc, diff, git, npm, tsc, eslint, prettier` (`src/tools/run-shell.ts:17-24`) |
| 2 | Shell timeout / max output | ✅ | — | `30_000` ms, `10_000` chars (`src/tools/run-shell.ts:6-7`) |
| 3 | Default endpoint timeout 600s | ✅ | — | `config.timeout ?? 600` (`src/llm/client.ts:101`) |
| 4 | `MAX_ITERATIONS_DEFAULT = 10` | ✅ | ✅ | `src/llm/agent-loop.ts:107` |
| 5 | `MAX_CACHE_SIZE = 50` | ✅ | ✅ | `src/llm/agent-loop.ts:129` |
| 6 | Eviction is FIFO, not LRU | ✅ | ✅ | oldest key by `Map` insertion order (`src/llm/agent-loop.ts:224-227`) |
| 7 | Breadth budgets 8 / 20 | ✅ | ✅ | `src/tools/explore-task.ts:39-42` |
| 8 | Cache key is `name` + re-serialised parsed args | ✅ | ✅ | `src/llm/agent-loop.ts:209` |
| 9 | `AbortSignal.any` merges caller signal with timeout | ✅ | ✅ | `src/llm/client.ts:108` |
| 10 | Cancel-vs-timeout disambiguation on `AbortError` | ✅ | ✅ | `src/llm/client.ts:119-135` |
| 11 | Usage mapped from endpoint, `undefined` when absent | ✅ | ✅ | `src/llm/client.ts:187-193` |
| 12 | Explore path exposes exactly 2 tools | ✅ | ✅ | `AGENT_TOOLS` (`src/llm/agent-loop.ts:40-65`) |
| 13 | `run_task` adds 3 more | ✅ | ✅ | `RUN_AGENT_TOOLS` (`src/llm/agent-loop.ts:67-105`) |
| 14 | Forced final call passes `tools: undefined` | ✅ | ✅ | `src/llm/agent-loop.ts:245` |
| 15 | `explore_files` wrapper substitutes rather than delegates | ✗ missed | ✅ | calls `exploreFiles`, not `t.handler` (`src/tools/agentic-task.ts:120-127`) |
| 16 | `unknown tool` string is cached; a thrown handler is not | ✗ missed | ✅ | `src/llm/agent-loop.ts:219-227` vs `:229` |
| 17 | Tool calls dispatched sequentially, not in parallel | ✗ missed | ✅ | `for` loop at `src/llm/agent-loop.ts:197` |
| 18 | Cache-hit behaviour | ⚠️ | ✅ | see minor #2 below |
| 19 | Blanket "every claim is CONFIRMED" | ⚠️ | — | see minor #1 below |

**Totals — locally: 0 hard, 2 minor. Explore: 0 hard, 0 minor.**

Rows 15–17 are omissions, not errors: locally said nothing false about them, it simply did not
go that deep. They are scored as a depth gap, not an inaccuracy.

**Minor #1 — blanket CONFIRMED.** locally closed with "**Every claim above is CONFIRMED** — each
file was read and every line cited corresponds to an actual line in the source." That is one
global assertion standing in for the per-claim labelling the prompt asked for, and it happens to
be true here only because the answer was accurate. See the compliance finding below.

**Minor #2 — cache-hit phrasing.** "On a hit … the iteration counter still increments (the loop
continues)" attaches loop-level behaviour to a per-tool-call event. The counter advances once per
`while` pass regardless of how many calls hit the cache. Not wrong, but it invites the wrong
mental model.

### The issue #13 changes, item by item

| Item | Behaviour observed | Verdict |
|---|---|---|
| 1 — symbol check | 27 distinctive names extracted, all 27 found, **0 flagged**. Whole-repo search took ~20ms. | **Works.** The thing that mattered was the false-positive rate on a truthful answer, and it was 0/27. |
| 2 — citation contract | 54 citations, all resolved. Spot-checked ~29 by hand; all pointed at the right code, including after this branch's own line-number shifts. | **Works.** No zero-citation answer arose, so that branch is covered only by unit tests. |
| 3 — CONFIRMED / LIKELY | Vocabulary adopted, discipline not. One blanket CONFIRMED at the end; **zero** `LIKELY` labels, including for the areas it never opened. | **Weak.** See below. |
| 4 — name the search behind a list | Not complied with. Two tables (tools, constants) presented bare, with no search named and no incompleteness caveat. | **Ignored.** |
| 5 — footer | `7 iters · 17 files read · 1m54s`, no `(hit cap)` — all correct against a run that finished on its own. | **Works.** |

### The finding worth acting on

**Item 3 may be a net negative at 9B, and it is the item that was supposed to catch issue #13's
worst error.**

The reasoning in the issue was that all four corrections would have landed in a `LIKELY` tier. This
run suggests a small model will not build that tier. It read "mark every claim CONFIRMED or
LIKELY", found the words agreeable, and emitted a single unearned confidence stamp over the whole
answer — the one output shape that is strictly worse than no labelling at all. An unlabelled
answer leaves the reader's default scepticism intact. "Every claim above is CONFIRMED" actively
argues against checking, and it costs nothing to produce.

It was harmless here because the answer really was accurate. On the issue #13 run — where four
claims were wrong — the same blanket stamp would have been actively misleading, and it would have
sat directly above an inverted security claim.

Item 4 was simply ignored, which is the benign failure: no cost, no benefit.

Recommendation: keep items 1, 2 and 5, which are server-side and demonstrably work. Reconsider
item 3's wording before shipping — an instruction the model can satisfy globally will be satisfied
globally. Something that only permits a per-claim marker (e.g. requiring the tier to sit inside
each bullet, or dropping CONFIRMED entirely and asking only that unverified claims be marked) is
likelier to survive contact with a 9B model. Worth a second eval against the 35B from the issue
before deciding, since compliance is exactly the axis where model size should matter most.

### Qualitative

- **Citations.** Both agents cited heavily and accurately. locally's 54 citations all resolved
  against a tree whose line numbers had just shifted under this branch's own edits, which is a
  genuinely good result — nothing was recited from memory of an older file.
- **Depth.** The gap is entirely in second-order observations: the substitution in the
  `explore_files` wrapper, what is and is not cached on the error path, sequential dispatch. The
  frontier agent notices things the code does not announce; locally reports what the code says.
  That is the same "strong on inventory, weaker on architecture" line already in the tool
  description, and this run does not move it.
- **Enumeration.** Both got the tool list exactly right (2 explore / 5 run). locally's constants
  table was correct in all 11 rows.
- **Cost.** locally: ~138k read locally, ~5.8k returned, 1m54s on a 9B. Explore: ~59k frontier
  subagent tokens, 2m11s. The ~5.8k is what actually displaced frontier context.
- **No regression.** The first eval in this directory scored 1 hard error each. This run is 0 and
  0. The added prompt burden did not cost accuracy — which was the specific risk being tested.

### Result

**PASS.** locally 0 hard / 2 minor; Explore 0 hard / 0 minor. Hard-inaccuracy count is equal, the
mechanism spine matches source, and the symbol check produced no false warning on 27 real names.

Items 1, 2 and 5 are ready. Item 3 needs rewording, and item 4 had no observable effect.

### Method recap

1. One prompt, sent verbatim to both agents.
2. locally driven in-process against the real endpoint (the connected MCP server was stale).
3. Both outputs captured whole, including locally's footer and verification lines.
4. Every disagreement plus ~29 high-specificity claims re-read against source.
5. Scored hard vs. minor per agent; the issue #13 items scored separately, since a passing
   accuracy score can still hide a prompt change that does nothing.

---

## Follow-up — rewording item 3, and two bugs the re-runs found

Item 3 was reworded and the same prompt re-run three more times against the same 9B model. The
scoring above still stands on run 1, the only full head-to-head; these runs measure compliance and
the behaviour of the server-side checks, not accuracy.

### The rewording

`CONFIRMED` was removed from the prompt entirely. Only unverified claims are marked now:

> If you did not actually read the code behind a claim, begin that claim with "LIKELY:" and say
> what you inferred it from. An honest LIKELY beats a guessed path:line. Do not label the claims
> you did read — their citation is the evidence — and never rate the answer as a whole: a blanket
> "everything here is confirmed" line gives the reader nothing to act on.

The reasoning: a claim carrying a path:line is already self-evidently verified, and the server
checks it, so a `CONFIRMED` marker adds nothing but a label the model can apply for free. Asking
only for the admission makes the marker a cost. An instruction that can be satisfied globally will
be satisfied globally — that is what run 1 demonstrated.

**It worked.** No blanket confidence line appeared in any of the three re-runs. Zero `LIKELY`
markers also appeared, which is the correct outcome for a run that read 20 files and cited only
what it read.

Item 4 ("name the search behind a list") was ignored in all four runs. No cost, no benefit;
left in place, unproven.

### Bug 1 — the symbol check reported five real constants as fabricated

Run 2 produced:

```
_Symbols: 56 names checked, **5 do not appear anywhere in the tree** —
`EXPLORE_FILES_SCHEMA`, `READ_FILE_SCHEMA`, `WRITE_FILE_SCHEMA`, `PATCH_FILE_SCHEMA`, `RUN_SHELL_SCHEMA`._
```

All five exist. The cause was pattern shadowing in the single-pass search: `--only-matching`
reports one match per position, and the same answer also named `read_file`, `write_file`,
`patch_file`, `run_shell`, `explore_files`. Case-insensitively each short name is a prefix of its
`_SCHEMA` counterpart, so rg emitted the short match and moved past — the longer name never
appeared in the output and read as absent. Reproduced directly:

```console
$ rg --fixed-strings --ignore-case --only-matching --no-filename \
     -e read_file -e READ_FILE_SCHEMA -- shadow/
READ_FILE
```

The emitted token is neither pattern in full.

The two relaxations chosen to *prevent* false positives — substring matching and
case-insensitivity — combined to manufacture one. Fixed by treating the bulk pass as a lower
bound: a hit is conclusive, a miss is not, and every miss is re-checked alone (`existsAlone`,
`src/tools/verify-symbols.ts`) where nothing can shadow it. That costs one extra subprocess per
name about to be reported — the handful of cases where being right is the whole point. Regression
test: "a long name is not shadowed by a shorter one it starts with".

### Bug 2 — the citation check flagged 49 of 68 correct citations

Runs 2 and 3 wrote citations as `agent-loop.ts:107` rather than `src/llm/agent-loop.ts:107`.
`verifyCitations` resolved a relative path only against the roots themselves, so a short path
never resolved and every one came back "file not found". Measured on run 3:

| flagged "file not found" | 49 |
|---|---|
| unique suffix match in tree | 49 (all with the cited line in range) |
| genuinely absent | **0** |

A 72% false-positive rate, and the run-1 pass was luck — the model happened to write full paths
that time. This is pre-existing code, not introduced by the issue #13 work, but item 2 exists to
make citations trustworthy and this did the opposite: a wall of false warnings buries the
citations that are really wrong.

Fixed on both sides, because neither alone is sufficient:

- **Resolution.** When a citation resolves against no root, fall back to a tree-wide lookup for a
  file whose path ends with the cited one at a segment boundary (`agent-loop.ts` finds
  `src/llm/agent-loop.ts`; `loop.ts` does not). The index is built once per run and only when
  something actually needs it. Several matches accept the citation if the line lands in any of
  them — silence beats a warning that cannot be stood behind.
- **Prompt.** The citation bullet now asks for a path written from the top of the repository.

The prompt half is the unreliable half. That is the lesson of this whole eval, so the resolution
fix is the one that had to exist.

### Final run

```
_Citations: 65 citations checked, all resolve to a real file and line._
_locally · ornith-1.0-9b-q6_k_xl · 6 iters · 20 files read · 1m32s · ~135k read locally · ~4.4k returned_
```

No symbol warnings, no blanket confidence claim, every citation resolving.

### What this says about the method

Both bugs were false positives in the checks themselves, and neither was reachable by unit test —
they needed a real model writing real prose. The unit tests passed throughout, including the
symbol check's own "does not warn about a name that is really there" test, because the fixture
never happened to contain one name that prefixes another.

The eval is what caught them. A verification feature that cries wolf is worse than no feature, so
the false-positive rate is the number to watch, and only a live run produces it.
