<!-- test:
id: 2026-06-28-security-analysis-locally-vs-explore
category: exploration (security audit variant)
subject-under-test: locally explore_task (breadth=very thorough, path=src)
baseline: native Explore subagent
identical-prompt: true
scoring: hard vs. minor inaccuracies per agent, verified against source
pass-criteria: locally hard-inaccuracy count <= baseline AND finds the most-severe issues
result: FAIL (locally 2 hard vs. baseline 0; locally missed the actual RCE class)
-->

# Eval: Security analysis of the locally MCP server — locally vs. native Explore

- **Date:** 2026-06-28
- **Task type:** Security audit (adversarial reasoning over a codebase) — an exploration-category task that demands review, not just code location
- **Subject under test:** `mcp__locally__explore_task` (`breadth: "very thorough"`, `path: src/`)
- **Baseline:** native `Explore` subagent (same repo, same focus)
- **Identical prompt:** yes (verbatim below, sent to both)
- **Cost:** locally — `ornith-1.0-9b-q8_0`, 5 iters, ~40k processed / ~4.8k generated. Native — frontier Explore subagent (≈ an order of magnitude more expensive).

> **Note on baseline choice.** The skill maps exploration → Explore. Explore's charter is "locates code; it doesn't review or audit it," so this stretches it. It still materially out-audited locally — so the conclusion (locally underperforms on security reasoning) holds *a fortiori*; a general-purpose baseline would only widen the gap.

## Prompt (identical to both)

> Perform a security analysis of this MCP server codebase (the src/ directory). Identify the most significant security vulnerabilities, weaknesses, or risky design decisions. This server runs local LLM-driven agentic loops that can read files, write files, patch files, and execute shell commands, and it exposes an HTTP transport. For each finding, provide: (1) a short title, (2) severity (critical/high/medium/low), (3) the exact file:line location(s), (4) a concise explanation of the risk and how it could be exploited, and (5) a suggested fix. Focus on real, exploitable issues — command injection, path traversal, SSRF, missing authentication/authorization, unsafe deserialization, sandbox escapes, secret handling, and DoS. Order findings by severity. Be specific and cite file:line for every claim.

---

## Output A — locally (`explore_task`, very thorough)

> Verbatim. Note: the output **truncated mid–finding #16** (hit the generation budget).

### 1. CRITICAL — Unrestricted Filesystem Write (Any Path, Recursive Directory Creation)
`src/tools/write-file.ts:29-31` — `write_file` accepts an arbitrary `path` and writes with `recursive: true`; an agent can overwrite `/etc/passwd`, `/root/.ssh/authorized_keys`, etc. **Fix:** confine writes to a configurable root via `path.resolve()` + `path.relative()`.

### 2. CRITICAL — Unrestricted Filesystem Read (Any Path)
`src/tools/read-file.ts:25-29` — `read_file` accepts any path, no validation; can read `/etc/shadow`, AWS creds, etc. **Fix:** confine to a root dir.

### 3. CRITICAL — Unrestricted File Patch (Any File, Any Replacement)
`src/tools/patch-file.ts:29-37` — arbitrary `path`/`old_str`/`new_str`; full read-modify-write of any file. **Fix:** root-dir confinement.

### 4. CRITICAL — No Authentication on HTTP Transport
`src/transport/http.ts:45-78` — zero auth; any client reaching host:port can call `run_task` with write/patch/shell capability. **Fix:** bearer-token / basic auth on every request.

### 5. CRITICAL — No Authorization / No User Context Binding
`src/server.ts:85-120` — dispatch by tool name only; no per-user authz. **Fix:** authorization layer keyed on caller identity.

### 6. HIGH — SSRF / Data Exfiltration via Unvalidated `baseUrl`
`src/config.ts:61-78`, `src/llm/client.ts:91-92` — `baseUrl` from config/env, unvalidated; an attacker with config/env control can redirect LLM traffic internally. **Fix:** scheme allowlist, restrict to localhost/private ranges.

### 7. HIGH — HTTP Transport Bindable to Any Host
`src/transport/http.ts:80-81` — host configurable; `LOCALLY_HOST=0.0.0.0` exposes on all interfaces. **Fix:** keep 127.0.0.1, reject non-local hosts.

### 8. HIGH — Unvalidated Shell Arguments (Command Injection via Args)
`src/tools/run-shell.ts:71-93` — uses `execFile` (no shell metachar injection), but `args` unvalidated. Notes that `execFile` splits command from args, so `cat /etc/passwd` passed to `git` "would just fail the allowlist check." **Fix:** safe-argument allowlist, constrain `cwd`.

### 9. HIGH — No Rate Limiting on HTTP Transport
`src/transport/http.ts:38-60` — 1MB body cap but no rate limiting → quota/CPU/memory DoS. **Fix:** token-bucket per client.

### 10. HIGH — Secrets in Plaintext Config Files
`src/config.ts:39-48` — `apiKey` stored plaintext in JSON. **Fix:** env vars / secrets manager; reject `apiKey` in config files.

### 11. MEDIUM — Information Leakage in Error Messages
`src/llm/client.ts:115-118`, `src/tools/run-shell.ts:96-97` — errors include full URLs/paths. **Fix:** sanitize.

### 12. MEDIUM — Unvalidated `cwd` in Shell Execution
`src/tools/run-shell.ts:58-61` — `cwd` from LLM, unvalidated. **Fix:** confine to root.

### 13. MEDIUM — No Input Validation on Shell Arguments
`src/tools/run-shell.ts:65-69` — args type-checked only. **Fix:** reject null bytes / separators / metachars.

### 14. MEDIUM — Cache of Tool Results Could Expose Sensitive Data
`src/llm/agent-loop.ts:77-80` — read results cached in memory for the run. **Fix:** TTL / exclude sensitive paths.

### 15. MEDIUM — No HTTPS on HTTP Transport
`src/transport/http.ts:80-81` — plain HTTP; intercepted if non-local. **Fix:** TLS.

### 16. LOW — No Path Canonicalization on File Operations
`src/tools/read-file.ts:25`, `src/tools/write-file.ts:29`, `src/tools` *[output truncated here]*

`_locally · ornith-1.0-9b-q8_0 · 5 iters · ~40k processed · ~4.8k generated_`

---

## Output B — native Explore

### CRITICAL
1. **Unrestricted Path Traversal in File Read/Write/Patch** — `read-file.ts:34`, `write-file.ts:26-27`, `patch-file.ts:31`. Arbitrary absolute paths, no sandbox. Example: read `/root/.ssh/id_rsa`, write `/etc/cron.d/backdoor`. Fix: allowed-base allowlist + `path.resolve` boundary check + `realpath`.
2. **No Authentication on HTTP Transport** — `transport/http.ts:37-72`, `:49` (`/mcp`). Network-accessible backdoor if `LOCALLY_HOST` is public. Fix: bearer-token auth, origin checks.
3. **Unrestricted `cwd` in Shell Execution** — `run-shell.ts:52-74`. `cwd` passed straight to `execFile`; combine with write_file to drop+run a file. Fix: resolve+confine `cwd`.
4. **LLM Prompt Injection / Jailbreak** — `agentic-task.ts:27-56`, `agent-loop.ts:145-149`. Task concatenated into messages; tool calls executed with only command-name checks. Fix: guardrails, output validation, sandbox instruction.

### HIGH
5. **Secrets in Plaintext Config** — `config.ts:47-60`, `locally.config.example.json:19-22`. Fix: env-only, no config fallback.
6. **Dangerous Git/NPM Subcommands** — `run-shell.ts:9-10, 58-62`. `git show`/`blame` info-disclosure; **`npm run` executes package.json scripts → RCE**; malicious repo `.gitconfig` → code exec. Fix: drop `show`/`blame`, `--no-pager`, restrict `npm`.
7. **Symlink Following** — `read-file.ts:34`, `explore-files.ts:65,112`. No `lstat`/`realpath`; symlink in project escapes boundary. Fix: `realpath` + boundary check.
8. **Dangerous Commands in Allowlist** — `run-shell.ts:12-23`. **`find -exec` → arbitrary code execution**; `cat`/`echo` broaden surface. Fix: trim allowlist to truly nondestructive commands.

### MEDIUM
9. **No Rate Limiting** — `transport/http.ts:41-72`. Fix: per-IP/token limiter.
10. **Missing Numeric-Param Validation** — `explore-files.ts:198` (`max_depth`/`max_file_size_kb`/`max_files`), `run-shell.ts:76`. Extreme values → OOM/deep recursion. Fix: clamp.
11. **Patch-File First-Match Replacement** — `patch-file.ts:32-38`. `indexOf` replaces only first occurrence. Fix: assert single occurrence.
12. **Error Messages May Leak Secrets** — `client.ts:143,160`, `read-file.ts:36`. Fix: sanitize, log server-side.
13. **Directory Traversal in explore-files** — `explore-files.ts:197-215`. `dirPath` unvalidated. Fix: boundary check.

### LOW
14. **Cache Ignores Side Effects** — `agent-loop.ts:113-185`. Don't cache `write_file`/`patch_file`/`run_shell`.
15. **No Security Headers on HTTP** — `transport/http.ts:43-72`.

Summary: "should not run untrusted LLMs or be exposed to untrusted networks without these fixes."

---

## Evaluation

### Quantitative — claims verified against source

| # | Claim | locally | native | Ground truth (source) |
|---|---|---|---|---|
| 1 | No auth on HTTP `/mcp` | ✅ | ✅ | Confirmed — `grep` finds zero auth code; `http.ts:49-66` handles `/mcp` with none |
| 2 | Unrestricted file read/write/patch | ✅ | ✅ | Confirmed — no path validation in `read/write/patch-file.ts` |
| 3 | `find -exec` → RCE (allowlist bypass) | ❌ missed | ✅ | `find` is allowlisted `run-shell.ts:14`; `-exec` runs arbitrary commands |
| 4 | `npm run`/`npm test` → RCE via package.json | ❌ missed | ✅ | `NPM_ALLOWED = {test, run}` `run-shell.ts:10` executes arbitrary scripts |
| 5 | Malicious-repo git RCE (cwd-controlled) | ❌ missed | ⚠️ | Real via `core.pager`/`fsmonitor`/alias; native's "format strings execute code" mechanism is wrong |
| 6 | Shell surface is essentially safe ("would just fail the allowlist check") | ❌ | — | **False reassurance** — `find`/`npm`/`git` are the RCE path |
| 7 | Unvalidated `cwd` | ✅ (MED) | ✅ (CRIT) | `run-shell.ts:74` passes `cwd` unchecked; native's higher severity is right given #3/#4 |
| 8 | patch-file first-match only | ❌ not raised | ✅ | `indexOf` at `patch-file.ts:32` — confirmed |
| 9 | Plaintext secrets in config | ✅ `:39-48` | ✅ `:47-60` | `readFileSync`+`JSON.parse` `config.ts:47-48`; native range tighter |
| 10 | No rate limiting / DoS | ✅ | ✅ | Confirmed — only a 1MB body cap (`http.ts:6,14`) |
| 11 | Numeric params unclamped | ❌ not raised | ✅ `:198` | `max_depth=5,...` defaults, no clamp — confirmed |
| 12 | `write-file` line cite | ❌ `29-31` | ✅ `26-27` | Actual `mkdir`/`writeFile` at **26-27** |
| 13 | `read-file` line cite | ❌ `25-29` | ✅ `34` | Actual `fsReadFile` at **34** |
| 14 | HTTP host line cite | ❌ `80-81` | ⚠️ range | Host default at **`http.ts:39`** (locally pointed at the stderr.write) |
| 15 | client.ts error-leak line | ⚠️ `115-118` | ⚠️ `143,160` | Actual `at ${url}` throw at **121-123**; both imprecise |
| 16 | `MAX_OUTPUT_CHARS*4` "from params" | — | ❌ | It's a **constant** (`run-shell.ts:7`), not a param |
| 17 | SSRF via `baseUrl` | ⚠️ | ❌ not raised | Real only given pre-existing config/env control — low practical severity |

**Tally**

| | Hard inaccuracies | Minor inaccuracies | Notes |
|---|---|---|---|
| **locally** | **2** | 2 | Hard: (a) missed the entire allowlist-bypass RCE class *and* gave false reassurance the shell surface is safe; (b) cluster of wrong file:line cites (write/read/host) that don't resolve. Minor: SSRF needs prior config control; #8 muddled execFile-arg reasoning. Also **incomplete** (truncated at #16). |
| **native** | **0** | 3 | Minor: "git format strings execute code" (wrong mechanism, right conclusion); `MAX_OUTPUT_CHARS*4` "from params" (it's a const); symlink rated HIGH but moot since no boundary exists to escape. |

### Qualitative

- **Severity ranking that matters.** The single most exploitable surface is the shell allowlist: `find -exec`, `npm run`, and `git` in an attacker-controlled `cwd` all yield RCE *within the allowlist*. Native surfaced all three. locally not only missed them but concluded the opposite — that `execFile` + allowlist neutralizes the shell tool. For a security audit, a confident false-negative on the top issue is the worst failure mode.
- **Citations.** Native's file:line cites land on the right code almost every time; locally's are frequently 3–8 lines off and several don't resolve to the cited construct. In an audit where citations are the verification handle, this materially lowers trust in every locally claim.
- **Completeness.** locally ran out of budget and truncated mid-finding; native delivered a complete, severity-grouped report with a closing risk statement.
- **Where locally was solid.** It independently found the two genuinely-critical issues both agents agree on (no-auth HTTP, unsandboxed FS) and added a defensible SSRF angle native omitted. As an *exploration* pass ("what's risky here, roughly") it's useful; as an *audit* it under-delivers.
- **Shared blind spots.** Neither flagged that `http.ts` spins up a fresh stateless MCP server per request (`sessionIdGenerator: undefined`), nor that there is no CSRF/origin defense beyond the missing auth. Both leaned on "add a root dir" as the universal fix without noting the symlink-resolution subtlety that only native then (separately) raised.

### Result: **FAIL** (for the audit task category)

Pass criteria = locally's hard count ≤ baseline **and** it surfaces the most-severe issues. locally: **2 hard vs. 0**, and it missed the top RCE class while affirmatively misjudging it as safe. The ~10× cost saving does not offset that gap for security work.

**Takeaway.** This is consistent with locally's charter and the tool's own description ("reads excerpts to locate code; it does not review or audit it"). The 9B local model is fine for *locating* risky surfaces and restating obvious issues (no auth, no sandbox), but adversarial reasoning — "the allowlist is bypassable via `find -exec`/`npm run`" — and precise citations need frontier judgment. **Use `explore_task` to enumerate the attack surface cheaply, then do the exploit reasoning and severity ranking yourself.** Do not ship a locally-only security verdict.

### Method recap (repeatable)

1. Identical security-audit prompt → both agents (locally `explore_task` very-thorough on `src/`; native `Explore`).
2. Capture both verbatim incl. locally's usage footer.
3. Read every cited file; verify each contested claim and every high-specificity file:line against source.
4. Score hard vs. minor per agent; require locally ≤ baseline on hard count AND coverage of the worst issue.
5. Headline the cost delta and PASS/FAIL.
