# Changelog

Notable changes to `locally-mcp`. Dates are npm publish dates (UTC).

This project is pre-1.0: the minor slot carries breaking changes, the patch slot carries
fixes. "Breaking" below distinguishes the **MCP surface** (`explore_task`, `run_task`,
`usage_report` — what a client calls) from the **agent-loop surface** (the tools the local
model is handed inside a run). The two break independently, and only the first affects callers.

## [0.6.3] — 2026-08-29

Route work to `explore_task` by how checkable the answer is, not by topic.

The server instructions and the tool description disagreed. The instructions listed "how
something works" as a job for `explore_task`. The description called the same question a
weakness. The description also called the tool "strongest at inventory work". The stored eval
runs do not support this. The worst run in `eval-runs/` is an inventory task with 5 hard
errors. The baseline had 0. Two "how does this work" runs each scored 0 hard errors. No
schema, tool, or behavior changes.

### Changed
- **`SERVER_INSTRUCTIONS` and the `explore_task` description now give three tiers.** The tool
  is accurate and complete when the answer is text in the code. It is accurate but can be
  incomplete when you ask how something works. It can be confidently wrong when it must derive
  the answer.
- **The derived-answer tier names four things to check.** These are a default value, an order
  of precedence, a complete count, and a rule about which code runs when. Each one is a
  measured failure in `eval-runs/`.
- **`README.md`, `CLAUDE.md`, and `docs/claude-code.md` now give the same three tiers.** All
  four surfaces stated the old topic-based routing. They now agree.

### Fixed
- **`docs/claude-code.md` showed a stale footer example.** The example named a model that this
  project does not run. It also showed ~12k tokens read. A real sweep reads 138k or more. The
  example is now a footer from a stored eval run.

## [0.6.2] — 2026-08-29

Fix six lines that the 0.6.1 rewrite left wrong, and settle the scope of the rule.

The rewrite touched every string in the project. A review of the result found five statements
that are inaccurate, and one rule that contradicts itself. No schema, tool, or behavior changes.

### Fixed
- **`Grep` named a parameter that does not exist.** A capped result told the model to "set
  `file_pattern`". The parameter is `glob`. A model that obeyed the instruction sent an unknown
  argument and got no narrowing.
- **`run_shell` stated the wrong default for `cwd`.** The description said the default is the
  working directory of the process. An omitted `cwd` gets the path of the task, or the first
  allowed root. The description now says that.
- **The `explore_task` description overclaimed the checks.** It said the server resolves each
  citation, and checks that each file path and each asserted name exists. Citations stop at 200,
  and paths and names stop at 100 each. `LOCALLY_VERIFY_SYMBOLS=0` turns three of the checks off.
  The description now says that each check states how much of the answer it covered.
- **Two `Fix:` lines kept the old form.** The HTTP-status line in `src/llm/client.ts` was the
  last string in `src/` that said "verify". Both lines are now short sentences that say "check".
- **The coverage note was wrong in the singular.** It rendered "this answer names 1 file that
  exist". The singular is the common case.
- **The rule for `README.md` contradicted itself.** `CLAUDE.md` put all technical documentation
  under the strict pass. `CHANGELOG.md` exempted the README. `CLAUDE.md` now holds one rule:
  keep the README accurate and current, and write it in the voice of the project.

## [0.6.1] — 2026-08-29

Rewrite every instruction, description, and report line in Simplified Technical English.

All the text that a model reads was written like architecture prose: long sentences, em-dash
asides, semicolons, and soft modals. A frontier model can read that. The 9B model at the other
end of `explore_task` reads the same text, and "may be incomplete" is not an instruction to a
small model. "Can be incomplete" is. This release applies the rules of ASD-STE100 Simplified
Technical English to that text. No schema, tool, or behavior changes.

### Changed
- **The MCP surface.** The server instructions, the three tool descriptions, and every
  input-schema field are now short sentences with one fact in each. The `explore_task`
  description held six unrelated facts in one 130-word paragraph, and the rule that matters most
  ("not for review, audits, ratings") sat at the end after a semicolon. Each fact is now its own
  sentence.
- **The `explore_task` contract.** The system prompt, the breadth guidance, the sweep nudge, the
  shallow-sweep note, and the coverage note. Every rule is one imperative sentence. `may` and
  `should` are gone, because a small model reads them as optional. The deliberate signals stay
  exact: `LIKELY:`, the capitalized `SET`, and the `<citations>` block format.
- **The agent-loop tools.** The descriptions of `Grep`, `Glob`, `Read`, `write_file`,
  `patch_file`, and `run_shell`, plus every parameter description behind them.
- **The verification footers.** The citation, symbol, file-path, and placement reports. Each one
  now ends with a plain instruction to the caller ("Check the line again before you trust the
  claim") instead of a semicolon-joined clause.
- **The error text.** Every `Fix:` line, and the `run_shell` allowlist rejections.
- **One word, one meaning.** This repository now says `check` (not verify, confirm, or ensure)
  and `config` (not configuration or settings) everywhere in model-facing text.

### Not changed
- `README.md`. Its voice needs more nuance than a mechanical pass gives it. It stays exempt from
  the strict pass by standing rule, and stays accurate by the usual one.
- The doc comments in the source. They explain a decision to a person who reads the code, which
  is a different job from instructing a model.
- Behavior. The test suite is the evidence: the assertions that pinned the old wording were
  updated to the new wording, and nothing else moved.

## [0.6.0] — 2026-08-29

Put a lock on the HTTP transport (issue #4).

### Added
- `transport.authToken` (env fallback `LOCALLY_AUTH_TOKEN`): a shared secret `/mcp` requires as
  `Authorization: Bearer <token>`. Missing or wrong gets a `401` with a `WWW-Authenticate` challenge,
  answered before the request body is read. `GET /health` stays open.
- A startup line on stderr saying whether `/mcp` requires a token, next to the existing bind line.
- A fatal startup `LocallyError` now prints its `Fix:` line, not just its message.

### Breaking (operational — not the MCP or agent-loop surface)
- Binding a non-loopback host with no token configured is now a startup error rather than a silent
  success. An existing `LOCALLY_HOST=0.0.0.0` deployment will not start until it sets a token or
  moves back to `127.0.0.1`. There is deliberately no override flag: the failure being guarded is the
  quiet one, and a switch that turns the guard off is that same quiet path renamed.

## [0.5.1] — 2026-08-29

Focus `explore_task` on finding, not evaluating (issue #23).

The tools behind `locally` are small models. They are accurate about structure they read and
confident about judgments they have not earned — and every place the server advertised "analysis",
"understanding" or "summarizing what exists" was an invitation to spend the caller's time on a bad
verdict. Two of this repository's own eval runs are the evidence: asked to audit the shell
allowlist, the model missed the `find -exec` and `npm run` bypasses entirely and concluded the
surface was safe (a confident false negative on the worst issue), and the config-surface run's five
hard errors were all the same failure — a claim asserted at a confidence the run had not earned.

Nothing in the schema or the behaviour changes; what narrows is what the tools promise.

### Changed
- **The `explore_task` contract bars verdicts.** Its output is findings, not an assessment: no
  judging quality or correctness, no severity or risk ratings, no recommendations, and no summary
  or "key takeaways" section nobody asked for. A task that asks for one is answered with the factual
  what/where half plus a line naming what was left out — "Out of scope: whether this is safe.
  Reported: where each check runs." A named gap is useful to the caller; a guessed verdict is worse
  than nothing. The rule is stated at the top of the contract as well as
  in the answer rules, and how far that gets is measured rather than assumed: asked point-blank to
  review this repository's own client error handling and say whether it is correct, a 9B returned a
  full review in both positions — the second run picking up the phrase and ending with an "Out of
  scope:" line about a side question while still shipping the verdict. Like the `LIKELY:` marker
  this is a request to the model, not something the server enforces. The caller-facing half below is
  what actually keeps such a task from arriving.
- **Reporting a mechanism it actually read is still in scope.** The narrowing is "no verdicts",
  not "locate only" — on the needle eval that reasoning beat the frontier agent's, and a test now
  fails if a later tightening drops it.
- **The tool descriptions and server instructions say the same thing.** `explore_task` no longer
  reads "use for analysis, Q&A, and understanding"; it reports what the code does and where it is,
  and review, audits, severity calls and design judgment stay with the caller. `run_task` gains the
  same scope discipline from the other direction: it does the task it is given and stops, rather
  than volunteering a review or a redesign of the code it touches.
- **README, `docs/claude-code.md` and `CLAUDE.md`** follow, including the delegation snippets and
  the `local-delegate` subagent, whose examples asked for summaries.

## [0.5.0] — 2026-08-29

Give the tree one ignore policy, and let git own it (issue #22).

`explore_task` handed the local model four ways to look at a tree and they disagreed about which
files existed. The directory map in the prompt walked the filesystem at a hardcoded name list; `Read`
opened anything; `Grep`/`Glob` shelled out to ripgrep at its defaults, which skips gitignored **and**
hidden files. So the map advertised a file, `Read` opened it happily, and no search could reach it —
and *which* of those behaviours you got depended on whether ripgrep happened to be on `PATH`, since
the `grep` fallback honoured neither rule. The contract made it worse by telling the model to build
file lists out of `Glob` listings that were silently short.

### Breaking (agent-loop surface)
- **`Grep` and `Glob` search hidden files.** `.github/`, `.claude/`, `.circleci/` and root dotfiles
  are ordinary source, not build output, and skipping them was never defensible. This is the half of
  the problem with no argument on the other side.
- **Git owns the ignore policy.** New `src/tools/git-ignore.ts` asks
  `git ls-files --others --ignored --exclude-standard --directory` once and hides what it names —
  covering nested `.gitignore` files, negations, `.git/info/exclude` and the user's global excludes.
  The directory map, `Grep`, `Glob` and the `grep`/Node fallbacks all now apply it, so the two search
  backends finally agree with each other and with the map. Outside a repository, or without git, it
  changes nothing.
- **A search that finds nothing is retried without the filter**, and the result says so. An empty
  result was never an answer, only a filtered one — the reasoning `findFilesNamed` already used,
  applied to the tools the model actually calls.
- **Every result names the filter that produced it** (`## Search (ripgrep, git's ignore rules
  honoured)`). That line is what lets a model tell "nothing is there" from "nothing I can see".
- **`include_ignored` added to both tools.** The auto-retry only fires on *zero* results; a search
  that returns four hits in `src/` and misses the gitignored config needs a parameter, not a label.
- **The built-in ignore list shrank from eleven names to two** (`node_modules`, `.git`). It only ever
  described the JavaScript ecosystem — `dist`, `.next`, `.turbo` were in it while `target/`,
  `.venv/`, `vendor/`, `Pods/` were not — so a Rust or Python repo searched its own build output and
  nobody could fix it without editing that line. A repository already declares what is derived.
  Outside a git repository the nine dropped names now appear in listings; `ignorePatterns` is the
  lever if that is unwanted.

### Fixed
- The `grep` fallback searched a strictly wider tree than ripgrep, so a machine without ripgrep got
  different answers to the same question — in this repository, every hit twice, once from a
  gitignored worktree holding a second copy of the source. It now filters the same way.
- `grepFiles` gained `-I`, which `verify-symbols` has always passed: a binary hit used to arrive as
  `Binary file X matches`, carrying no line number and attributable to nothing.

### Notes
- `Read` and the three answer checks deliberately stay outside the policy. A tool that opens files
  and a tool that fact-checks them both have to see everything — that is the issue #17 fix, and it is
  why `UNFILTERED_RG_ARGS` still exists.
- The ignore view is a set of what to **hide**, not what to show, and the direction is load-bearing.
  An allow-list built from `ls-files --cached --others` looks equivalent and is not: git reports a
  submodule as a single gitlink, so every file inside one would have vanished from the map and from
  `Glob` while `Read` opened it — reintroducing the exact bug this release fixes. A deny set fails
  open.
- `--directory` collapses a wholly-ignored tree to one entry: 6 entries rather than 4150 on this
  repository, and it is what lets a walk prune before descending into a 40k-file `.venv/`.
- With the list down to two names, `.git` is load-bearing rather than redundant. `--hidden` un-hides
  it as readily as `.github/`, and ripgrep does not special-case it — there is a test asserting
  `.git` never leaks into results at any width.
- One consequence accepted rather than fixed: `listAllFiles` feeds `verify-symbols`' in-process
  third pass and stays unfiltered, so it now walks `dist/` and `coverage/` too. In a repository large
  enough to exceed its 20,000-file cap, that pass returns inconclusive and its names are dropped
  rather than warned about — incomplete, never wrong, which is the invariant that file states. A
  follow-up could order the walk git-visible-first instead.

## [0.4.1] — 2026-08-29

Make `explore_task`'s self-check trustworthy (issue #17).

A run came back with a footer carrying 9 warnings, every one of them wrong, while the 2 real
errors in the answer passed unflagged. The answer was good — 102 of 104 verifiable claims correct
— so the defect was entirely in the verification layer. A check with 9 false alarms and 0 true
alarms is worse than no check: it moves the reader's attention off the claims that were wrong and
teaches them to skip the footer.

### Fixed
- **The checkers searched a smaller tree than the model does.** `verify-symbols` and the by-name
  half of `verify-paths` shell out to ripgrep, which skips gitignored and hidden files, while the
  directory map in the task prompt (`buildTree`) and the `Read` tool honour only `IGNORED_DIRS`.
  An answer could therefore correctly describe a file no default search can see, and have every
  distinctive name in it reported as appearing nowhere in the tree. Nothing is now called missing
  on the word of one search: a miss is re-searched unfiltered, and if that fails too the tree is
  read in-process and scanned directly. The last pass depends on no external tool, because the
  reported repository is private and the exact trigger cannot be replayed — so the fix closes the
  class rather than the one instance. `findFilesNamed` likewise treats an empty ripgrep result as
  filtered rather than final.
- **The footer counted a cap as a coverage figure.** "60 names checked" was `MAX_SYMBOLS`, not a
  count of what the answer named. Every report line now states its own coverage ("60 of 84 names
  checked"), and the symbols line names the search it ran.
- **A `<citations>` block no longer hides the answer's other locations.** It used to be read
  exclusively, so an answer carrying 100+ inline `path:line` references and a five-line block was
  reported as "5 citations checked". Inline citations are checked alongside the block; the two
  looser forms — table rows and prose ranges — stay block-absent-only, since those are the
  inference the block exists to replace.

### Added
- **A placement check** (`Placement:`), the first that relates a name to a location. When an answer
  names a distinctive identifier and a `path:line` as one assertion, and the cited file really does
  contain that identifier but only far from the cited line, the footer says so and gives the line
  the name actually sits on. This is the error issue #17 reported as missed: the file exists, the
  line exists and the name exists, so each existing check passed it individually.

  A symbol *absent* from its cited file is always silent. That single rule absorbs call sites,
  re-exports, barrel files and every cross-file claim, and it is what keeps the check from
  repeating the bug it was written for: the same corpus contains five citations misspelling
  `LOCALLY_*` as `LOCALY_*` against perfectly correct line numbers.

  Measured before shipping against the recorded answers in `eval-runs/`, each resolved at its own
  commit: **0 fires on 36 real pairs**, and **19 of 24 caught** when every citation in that corpus
  is shifted 70 lines. It is blind to line errors under roughly 35 lines, which is the cost of a
  window generous enough to clear every correct citation in the corpus by ten lines.

  Under the existing `LOCALLY_VERIFY_SYMBOLS=0` switch, which now covers three checks.

### Notes
- Issue #17's second missed error — an invented cross-file relationship carrying a *correct* line
  number — is deliberately not addressed. Refuting "re-exported from A and imported in B" needs a
  module graph (`export *` chains, renames, path aliases) and a parser per language; the cheap
  textual version fires hardest on barrel files, which is the most common correct case. The
  `explore_task` description already warns about this class.
- `verifyCitations`, `verifyPaths` and `verifyPlacement` now share one `FileResolver`, so a cited
  file is read once rather than three times.

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
