# locally

MCP server for delegating tasks from frontier models to smaller local models via OpenAI-compatible endpoints.

## Build & dev

```bash
npm run build       # compile to dist/
npm run typecheck   # type check without emitting
npm run dev         # stdio mode, watch
npm run dev:http    # HTTP mode, watch
npm test            # run the Vitest suite once
npm run test:watch  # Vitest in watch mode
npm run coverage    # Vitest with a v8 coverage report (text + coverage/ HTML)
```

## Architecture

- `src/index.ts` — entry point, selects transport
- `src/config.ts` — config loading and agent resolution
- `src/server.ts` — MCP server factory, tool registration
- `src/tools/explore-task.ts` — `explore_task` tool: search-first system prompt, the `<citations>` block the answer is asked to end with, breadth budget and sweep floor, the three answer checks, coverage note, shallow-sweep tell. The contract's scope clause is issue #23: findings, not an assessment — no quality judgment, severity rating or recommendation, and a task that asks for one gets the what/where half plus a line naming what was left out. Reporting a mechanism it actually read is still in scope; the failure being fenced off is the verdict it has not earned (`eval-runs/2026-06-28-security-analysis-locally-vs-explore.md`).
- `src/tools/run-task.ts` — `run_task` tool: builds dir tree, runs agentic loop for writing/generation
- `src/tools/explore-files.ts` — the loop's two search tools. `grepFiles` (`Grep`) greps file contents (ripgrep → grep fallback) and returns `path:line:text`; `globFiles` (`Glob`) lists files matching a name pattern (path, line count, size). They were one `explore_files` tool whose behaviour flipped on whether `query` was set — eleven optional parameters and two unrelated result shapes behind one name, with the mode switch invisible in the schema. The whole-file dump (`include_content`) went with the split: it existed only to let a model swallow a directory, which the contract already forbids. Neither re-sends the directory tree; the task prompt carries one, and re-sending it per call is what made a single broad call cheaper than several focused ones. Also home to `UNFILTERED_RG_ARGS` (`--hidden --no-ignore`) and `listAllFiles`. `Grep`/`Glob` now pass `--hidden` always — `.github/`, `.claude/`, dotfiles are source, not build output — and reach for `--no-ignore` only as a second pass when the first matched nothing at all, labelling the result when they do (issue #22). `listAllFiles` stays unfiltered for the checkers: skipping build output is a feature in a search tool and a lie in a checker. `findFilesNamed` treats an *empty* ripgrep result as filtered rather than final and widens before answering, for the same reason.
- `src/tools/git-ignore.ts` — the ignore policy for every surface the model sees, as one `git ls-files --others --ignored --exclude-standard --directory` spawn. It is a set of what to **hide**, and that direction is the design: an allow-list built from `--cached --others` looks equivalent but reports a submodule as a single gitlink, so every file inside one would vanish from the map and from `Glob` while `Read` opened it — the exact bug #22 exists to fix. A deny set fails open, so anything git has not heard of (a file `run_task` just wrote, an empty directory) stays visible. `--directory` is load-bearing: it collapses a wholly-ignored tree to one entry, 6 rather than 4150 on this repo. Returns `null` outside a repository, which every caller must read as "hide nothing".
- `src/tools/read-file.ts` — `Read`: file reader available to the agentic loop (path + optional line range). Output is line-numbered so the model cites numbers it saw rather than counting them.
- `src/tools/answer-text.ts` — the shapes a model writes an answer in (fenced blocks, inline code spans, table rows), shared by all three checks below. They were each finding them differently, and the citation checker's inline-only reading was why an answer whose citations were all in table cells came back reported as citing nothing.
- `src/tools/resolve-path.ts` — `FileResolver`: turns a path the model wrote into the file it meant. Shared by all three filesystem checks (`exploreTask` builds one and passes it down), so each cited file is read once; `lines()` hands back the text that read already cost, which is what makes the placement check affordable. Tries the task's own `path`, then each root, then a targeted by-name search (`findFilesNamed`). Replaced a whole-tree index capped at 20,000 paths, which in a monorepo could drop an entire subtree and report every citation into it as missing (issue #16). Returns canonical paths, so they compare equal against the paths `Read` recorded.
- `src/tools/verify-citations.ts` — re-resolves every location in an `explore_task` answer against the filesystem; annotates, never rewrites. Reads the answer's own `<citations>` block, which makes the common case exact rather than inferred, and renders it back out as ordinary markdown so the caller never sees a tag (`<final_answer>` is accepted as the same tag — it is what FastContext-trained models emit, and one alternation is the whole cost of running one). The block does not stand alone: inline `path:line` matches from the prose are checked with it, because an inline citation is as exact as a block entry and reporting only the block's five entries over an answer making a hundred location claims is how issue #17 read "5 citations checked" as a clean bill of health. The two looser forms — `| File | Line |` table rows and prose ranges — stay block-absent-only, since those are the inference the block exists to replace. Every report line states its own coverage ("12 of 140 checked") rather than letting a cap read as a count. The footer distinguishes "nothing could be parsed" from "the file does not exist" from "the line is past the end": they are different messages to the caller and used to read the same.
- `src/tools/verify-paths.ts` — existence-checks the file paths an answer names in backticks or table cells. The sibling of `verify-symbols.ts`, and it exists because that one's identifier test rejects anything with a dot or slash, so a filename had never been checked by anything. Catches the failure where a correct list of tables generates a wrong list of one-file-per-table. Same asymmetry, same off switch.
- `src/tools/verify-symbols.ts` — greps the tree for the distinctive identifiers an `explore_task` answer names in backticks, and flags the ones that appear nowhere. Asymmetric on purpose: no hits proves the name was invented, hits prove nothing at all. Matching is substring and case-insensitive, and only backticked, non-generic tokens outside fenced blocks are checked — every one of those choices favours a false pass over a false warning, which is what makes it worth reversing `verify-citations.ts`'s standing decision not to match symbols. Three passes, each wider than the last, and nothing is called missing until all three fail: the fast bulk grep, then a per-name search at `UNFILTERED_RG_ARGS`, then an in-process read of the tree. The widening is issue #17: the checker's world was strictly smaller than the model's, and it called seven real names invented. Since #22 the invariant is stated the other way round — the model's tools see git's view, while `Read` and the checkers see everything — but the reason the passes exist is unchanged. The third pass depends on no external tool at all, because the reported repository is private and the exact trigger cannot be replayed. Off with `LOCALLY_VERIFY_SYMBOLS=0`.
- `src/tools/verify-placement.ts` — the one check that relates a name to a location. Pairs a distinctive identifier with a `path:line` the answer asserted alongside it (a `<citations>` block entry's note, or one answer line carrying exactly one citation and one backticked name) and confirms the identifier occurs near that line. The load-bearing rule is that a symbol *absent* from its cited file is always silent: that absorbs call sites, re-exports, barrel files and every cross-file claim, leaving only the "right file, wrong line" residue that `verify-citations.ts` (line exists) and `verify-symbols.ts` (name exists) each pass individually and neither catches together. The window is structural — the paragraph, plus a comment header, plus an indented body — with a floor of 30 lines chosen from the widest gap any correct citation in `eval-runs/` shows (20). Measured at 0 fires on 36 real pairs, 19 of 24 caught on a +70-line shift of the same corpus. Same off switch.
- `src/llm/agent-loop.ts` — agentic loop: parallel tool-call dispatch (a turn's calls are independent by construction, so they run concurrently and their results are pushed in call order), result caching with in-batch deduplication, the `ToolFence` contract each tool declares, a max-iterations guard, and the `onDraftAnswer` hook that lets a caller reject a final answer and keep the loop running (the only thing that makes `breadth` shape the run rather than flavour the prompt)
- `src/llm/client.ts` — fetch-based OpenAI client, no external deps
- `src/transport/auth.ts` — the `/mcp` access rules (`resolveAuthToken`, `isLoopbackHost`, `assertBindSafety`, `checkBearer`), split out from the transport so they are unit-testable; `vitest.config.ts` names the two wiring files in its coverage exclusion rather than all of `src/transport/**` for that reason (issue #4).
- `src/transport/stdio.ts` / `http.ts` — stdio and Streamable HTTP transports. Both go through the
  v2 dual-era serving entries (`serveStdio` / `createMcpHandler`), so one build serves both the
  2025-era and 2026-07-28 protocol revisions — see **Protocol revisions** below.

## Conventions

- ESM throughout (`"type": "module"`), Node ≥ 24
- All local imports use `.js` extensions (NodeNext module resolution)
- No runtime deps beyond the MCP SDK — use Node built-ins. The SDK is v2, which is split across
  packages: `@modelcontextprotocol/server` (the `Server` class and both serving entries) and
  `@modelcontextprotocol/node` (the `toNodeHandler` adapter and the `node:http` Host/Origin
  guards). `@modelcontextprotocol/node` pulls `@hono/node-server` transitively — a deliberate
  exception, taken so the Node↔fetch conversion is the SDK's to maintain rather than ours.
  (Vitest is a dev-only dep; this rule governs runtime/production deps and the shipped `dist/`
  bundle, not test tooling.)
- `createServer()` in `server.ts` is a factory. Both serving entries require this: `createMcpHandler`
  calls it per HTTP request, `serveStdio` calls it once per connection to pin an instance.

## Testing

Tests run on [Vitest](https://vitest.dev) (`vitest.config.ts` at the repo root, node environment). Conventions:

- Test files are colocated with the code they cover as `*.test.ts` under `src/` (e.g. `src/llm/client.test.ts`).
- Use explicit imports — `import { test, expect, vi } from "vitest"` — no globals, matching the project's no-magic style. Test files are type-checked by `npm run typecheck` (they live under `src/`).
- Pure functions (`config.ts`, `llm/errors.ts`) are tested directly; the LLM client and agent loop are driven by stubbing global `fetch` with `vi.stubGlobal`. Assert on `LocallyError`'s `category`/`retriable`, not on rendered prose.
- `src/server.test.ts` covers the MCP layer by driving `createMcpHandler` through its own fetch function — the documented no-sockets path. It asserts the *wire* shape both eras produce (tool order, annotations, cache fields, `resultType`, the `serverInfo` stamp), so a protocol regression fails there rather than in a client.
- Coverage via `npm run coverage` (v8 provider). The CLI entry, transports, and config files are excluded as non-unit-testable edges; the `coverage/` report dir is gitignored. There's no CI gate yet, so coverage is informational.

## Config

Copy `locally.config.example.json` → `locally.config.json` to configure endpoints and agents. Falls back to `LOCALLY_BASE_URL`, `LOCALLY_MODEL`, `LOCALLY_API_KEY` env vars.

Optional per-agent `temperature`, `topP`, `extraBody`, `systemPrompt` and `maxIterations` (on `default` or per-agent) are what let locally serve a model with its own harness — its sampling, its prompt, its turn budget — without shipping anything model-specific. `temperature`/`topP` are sent only when set, so the default stays "the endpoint decides"; `extraBody` is merged into the request body last, because there is no portable spelling for turning reasoning off (`reasoning_effort` on Ollama, `chat_template_kwargs` on llama.cpp and vLLM) and sniffing the endpoint is worse than letting the operator say. `systemPrompt` *replaces* the tool's contract rather than stacking on it.

Optional `timeout` (seconds, default 600, on `default` or per-agent) bounds each endpoint request. **Config is read once at startup (`index.ts` → `loadConfig`), so reconnect the locally MCP server after editing the config** — a running server keeps the config it launched with.

`LOCALLY_VERIFY_SYMBOLS=0` disables the `explore_task` symbol, file-path *and* placement checks — one switch for "check server-side that the names this answer asserts exist, and sit where it says". It is an env var rather than a config key because `LocallyConfig` is the parsed file verbatim — the per-field env fallback only exists inside `resolveAgentConfig`, and only for `baseUrl`/`model`/`apiKey` — so a config key would be unreachable from the environment. It is deliberately not a call parameter either: an answer must not be able to switch off its own fact-checking.

`ignorePatterns` and the built-in `IGNORED_DIRS` are now only the backstop for when git cannot answer (no repository, or no git); `IGNORED_DIRS` holds `node_modules` and `.git`. `.git` is load-bearing rather than redundant: `--hidden` un-hides it as readily as `.github`, and rg does not special-case it.

Optional `allowedRoots` (array of absolute dirs) confines every file/shell tool — `Read`, `Grep`, `Glob`, `write_file`, `patch_file`, and `run_shell`'s `cwd` — to those directories. The fence is driven by a `ToolFence` each tool declares (`src/llm/agent-loop.ts`), not by matching its name: it used to be a `switch` whose `default:` returned the tool unwrapped, so renaming a tool would have taken it out of the sandbox silently. Symlinks are resolved before the check (`src/tools/sandbox.ts`), so a link out of a root is rejected. Defaults to `[process.cwd()]` (the launch directory) when unset, so the model is sandboxed by default. A blocked path returns a `constraint` error and the model retries within bounds. The effective fence is logged to stderr at startup (`index.ts` → `effectiveRoots`), so you can see whether the default `process.cwd()` landed where you expect; a fully-unresolvable `allowedRoots` fails fast at startup. The shell allowlist (`src/tools/run-shell.ts`) is intentionally narrow — no `cat`/`find`/`grep` etc.; reading and searching go through the confined `Read`/`Grep`/`Glob` tools instead.

In HTTP mode, `transport.authToken` (env fallback `LOCALLY_AUTH_TOKEN`) is the shared secret `/mcp` requires as `Authorization: Bearer <token>`; unset means no auth, and `/health` is open either way. The rules live in `src/transport/auth.ts` as pure functions so the transport stays a router: `checkBearer` compares SHA-256 digests under `timingSafeEqual`, because that call throws on a length mismatch and comparing raw strings would leak the secret's length through the exception path. `assertBindSafety` runs before `listen` and makes a non-loopback bind with no token a startup `config` error — deliberately with no override flag, since the failure being guarded is the silent one (a `0.0.0.0` bind that works fine and says nothing), and an env var that turns the guard off is that same silent path renamed. The SDK's OAuth resource-server helpers (`requireBearerAuth` and friends) were passed over on purpose: they want an `AuthInfo` with an `expiresAt`, and the deployment here is one operator holding one secret.

Optional `transport.allowedHosts` / `transport.allowedOrigins` (arrays of hostnames) are the DNS-rebinding fence on the same endpoint. That fence defends a browser, not the endpoint — a direct client sends whatever `Host` and `Origin` it likes, which is what the token above is for. Both default to the bind host plus localhost, so a browser page on another origin cannot reach the endpoint. A deployment reached by any other name — a reverse proxy, a container hostname — must list it or requests get a `403`. Note a present-but-unparseable `Origin` (the opaque `null` sent by sandboxed iframes and `file://` pages) is rejected and cannot be allowlisted.

Tool failures are categorized via `LocallyError` (`src/llm/errors.ts`) and rendered as tagged prose by `formatLocallyError` in `server.ts`'s catch: `timeout`/`config`/`constraint` are local (configurable) faults, `upstream` is the model endpoint's fault, and `cancelled` means the caller stopped the task (nothing to fix). Each carries an actionable `Fix:` line.

## Protocol revisions

locally serves **both** the 2025-era revisions and **2026-07-28** from one build. Nothing in the SDK puts a 2026-07-28 byte on the wire by default — it is an explicit opt-in per transport, and both opt-ins keep serving 2025-era clients:

- `serveStdio(() => createServer(config))` — the opening exchange picks the era (`initialize` vs `server/discover`, which the entry answers itself) and pins one instance for the connection.
- `createMcpHandler(() => createServer(config))` — `legacy: 'stateless'` (the default) serves 2025-era traffic through the same per-request idiom the transport used before.

Do **not** pass `legacy: 'reject'` to either without a reason: it drops every current host, Claude Code included.

What the revision changes for this codebase:

- **No sessions, no `initialize`.** 2026-07-28 carries the protocol version, client identity, and capabilities in each request's `_meta` envelope, readable at `ctx.mcpReq.envelope`. locally was already stateless per request, so nothing had to be restructured.
- **Cacheable results.** `tools/list` and `server/discover` must carry `ttlMs`/`cacheScope`; the SDK defaults to `ttlMs: 0` unless `ServerOptions.cacheHints` says otherwise (`server.ts`). Both results are static for a process's lifetime here, hence the one-hour public hint.
- **Standard headers (SEP-2243).** A modern request POST must send `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` (the last only where it mirrors `params.name` — e.g. `tools/call`), and they must agree with the body or the entry answers `400`/`-32020`. SDK clients do this; hand-rolled `curl` probes must.
- **Cancellation.** On 2026-07-28 Streamable HTTP the cancel signal is the request stream closing, not a `notifications/cancelled` POST. Either way it lands on `ctx.mcpReq.signal`, which is threaded through `runAgenticTask` → `runAgentLoop` → `runCompletionWithTools` and merged with the per-request timeout, so a cancelled or disconnected client actually stops the local model.
- **Deprecated, and unused here:** Roots, Sampling, Logging, HTTP+SSE, and the experimental tasks side-channel. Do not adopt them. Diagnostics go to stderr, which is the recommended replacement for Logging on stdio.

The `io.modelcontextprotocol/tasks` extension is the natural home for locally's long-running work (a sweep can run 20 iterations of up to 600s inside one `tools/call`), but it moved out of the core protocol and the TypeScript SDK has not shipped it yet — cancellation is the interim answer. Revisit when it lands.

## Practices
Try to use locally yourself when working in this repo - but check its work.

For codebase Q&A, "where is X", how-something-works, and naming-convention sweeps, prefer delegating to `explore_task` (set `breadth` to `very thorough` for wide sweeps) instead of spawning a native Explore subagent — then verify the result before relying on it. Ask it for facts and locations; keep review, audits, severity calls and design judgment on the frontier model (issue #23).

When adding or updating functionality, before committing, check that the README is still accurate and doesn't need updating.

Before committing new work, ask the user whether to bump the version — don't decide it silently. If they say yes, bump `package.json` (via `npm version <x.y.z> --no-git-tag-version`, which updates `package-lock.json` too), update `SERVER_VERSION` in `src/server.ts` to match, and add a `CHANGELOG.md` entry. `src/server.test.ts` asserts the wire `serverInfo` against `package.json`, so a missed `SERVER_VERSION` fails the suite rather than drifting. Pre-1.0, breaking changes take the minor slot — note which surface broke, the MCP one (what a client calls) or the agent-loop one (the tools the local model is handed).

## Evals

We periodically benchmark locally against the native frontier-model agents (Explore for exploration, the main loop for run/generation tasks) to track how much quality we trade for the cost savings. Stored runs live in `eval-runs/` as dated Markdown files, each with the test definition, both verbatim outputs, and an evaluation section (qualitative notes + a quantitative inaccuracy count verified against source).

Run one with the `/run-eval` skill (`.claude/skills/run-eval/`). The method: give both agents the **identical** prompt, capture both outputs into one dated `eval-runs/` file, verify the points where they disagree (plus a sample of high-specificity claims) against source, then score hard vs. minor inaccuracies for each. First run: `eval-runs/2026-06-28-codebase-tour-locally-vs-explore.md` (exploration; ended 1 hard error each, locally ~15x cheaper). We expect to cover exploration, documentation, and code generation over time.