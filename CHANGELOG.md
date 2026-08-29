# Changelog

Notable changes to `locally-mcp`. Dates are npm publish dates (UTC).

This project is pre-1.0: the minor slot carries breaking changes, the patch slot carries
fixes. "Breaking" below distinguishes the **MCP surface** (`explore_task`, `run_task`,
`usage_report` — what a client calls) from the **agent-loop surface** (the tools the local
model is handed inside a run). The two break independently, and only the first affects callers.

## [0.4.0] — 2026-08-29

Sharpen the explore surface (issue #2).

### Changed
- **Breaking (agent-loop surface):** `explore_files` is split into `Grep` and `Glob`, alongside
  `Read`. It had been one tool with eleven optional parameters whose behaviour flipped on whether
  `query` was set — two unrelated result shapes behind one name, with the mode switch invisible in
  the schema. The new names are the ones every coding agent uses, so a model guessing at the
  surface guesses right.
- **Breaking (agent-loop surface):** `include_content` is gone. It existed only to let a model
  swallow a directory, which the explore contract already forbids.
- A turn's tool calls now dispatch **in parallel** rather than sequentially. They are independent
  by construction — the model asked for all of them before seeing any result — and results are
  pushed back in call order because the API requires each tool message to follow its call. Two
  identical calls in one batch collapse to a single execution instead of racing to fill the cache.
- `explore_task` answers are asked to end with a `<citations>` block, read exactly when present and
  rendered back out as ordinary markdown so the caller never sees a tag. `verify-citations`'s four
  regex heuristics stay as the fallback for an answer that omits it.

### Notes
- The MCP surface is unchanged; no caller breaks.

## [0.3.2] — 2026-08-28

Fix the `explore_task` checkers' false alarms, and make `breadth` shape the run (issue #16).

### Fixed
- Citation resolution moved into `FileResolver` (`src/tools/resolve-path.ts`): absolute, then the
  task's own `path`, then each root, then a targeted by-name search. It replaces a whole-tree index
  capped at 20,000 paths — an arbitrary unordered slice that an entire monorepo subtree could fall
  outside, which is why correct citations came back reported as missing.
- Citation extraction reads four forms — inline `path:12`, ranges, `| File | Line |` table rows, and
  prose line references. An answer whose citations were all in table cells had been told it named no
  location at all.
- The footer words its three outcomes apart, so "nothing could be parsed" no longer reads like
  "these citations are wrong".
- `--glob <pattern>` was emitted before the ignore globs, and ripgrep resolves overlaps
  last-match-wins, so a `file_pattern` could pull `node_modules` back into a listing.

### Added
- `verify-paths.ts` existence-checks the file paths an answer names. `verify-symbols` could never do
  this — its identifier test rejects anything with a dot or slash, so a filename had been checked by
  nothing. Catches a correct list of tables generating a wrong list of one file per table.
- A `Coverage:` line naming real files the answer described without ever opening.
- `breadth` now shapes the run, not just the prompt: `runAgentLoop` takes an `onDraftAnswer` hook,
  and a "very thorough" sweep below six iterations or five files read is asked once to keep going.

## [0.3.1] — 2026-08-28

Check asserted symbols and label unread claims in `explore_task` (issue #13).

### Added
- `verify-symbols.ts` greps the tree for the distinctive identifiers an answer names in backticks and
  flags the ones that appear nowhere. Asymmetric on purpose: no hits proves the name was invented,
  hits prove nothing. Off with `LOCALLY_VERIFY_SYMBOLS=0`.
- A note when an answer cites no locations at all.
- `CONFIRMED`/`LIKELY` labelling in the explore contract, and an extended footer.

## [0.3.0] — 2026-08-28

Adopt MCP spec revision 2026-07-28.

### Added
- Both the 2025-era revisions and 2026-07-28 are served from one build, via the v2 SDK's dual-era
  entries (`serveStdio` / `createMcpHandler`). Existing clients, Claude Code included, keep working.
- Cacheable `tools/list` and `server/discover` results (one-hour public hint — both are static for a
  process's lifetime).
- Cancellation threaded from `ctx.mcpReq.signal` through `runAgenticTask` → `runAgentLoop` →
  `runCompletionWithTools`, so a cancelled or disconnected client actually stops the local model.
- DNS-rebinding fence on `/mcp` in HTTP mode: `transport.allowedHosts` / `transport.allowedOrigins`,
  defaulting to the bind host plus localhost.

### Changed
- Runtime deps are the split v2 SDK packages (`@modelcontextprotocol/server`,
  `@modelcontextprotocol/node`).

## [0.2.1] — 2026-08-28

Republish to replace a broken 0.2.0 npm release. No source changes.

## [0.2.0] — 2026-08-28

### Changed
- `explore_task` searches first instead of swallowing directories.

### Added
- Vitest as the testing framework, with tests colocated under `src/` as `*.test.ts`.
- Quickstart and config-layering docs; npx-first install instructions.

## [0.1.1] — 2026-06-28

Published from a branch that was never merged (an optional knowledge base: folder watch → embed →
semantic search). The feature is in no later release; 0.2.0 continues from 0.1.0.

## [0.1.0] — 2026-06-28

First release.

### Added
- `explore_task` and `run_task` over a shared agentic loop against any OpenAI-compatible endpoint.
- Agent-loop tools: `explore_files`, `read_file`, `write_file`, `patch_file`, `run_shell`.
- `allowedRoots` sandbox confining every file and shell tool, symlinks resolved before the check.
- Categorized errors (`LocallyError`) with an actionable `Fix:` line; default timeout 600s.
- Usage provenance footer and the `usage_report` tool.
- Config file with named agents, per-tool routing, and `ignorePatterns`.
- The `eval-runs/` harness comparing locally against the native Explore agent.
