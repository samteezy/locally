<!--
test:
  id: needle-maxbuffer
  category: exploration          # exploration | documentation | code-generation
  subject-under-test: locally explore_task (very thorough)
  baseline: native Explore subagent
  identical-prompt: true         # both agents receive the same prompt verbatim
  scoring: inaccuracy-count       # hard vs. minor, verified against source
  pass-criteria: |
    locally locates the correct needle (run-shell.ts maxBuffer = MAX_OUTPUT_CHARS * 4)
    with the right value and a correct "why", AND its hard-inaccuracy count <= baseline's.
  result: PASS                    # locally 1 hard / 1 minor; Explore 1 hard / 1 minor — needle found by both
-->

# Eval: Needle-in-a-haystack (subprocess buffer vs. truncation cap) — locally `explore_task` vs. native Explore agent

- **Date:** 2026-06-28
- **Task type:** Exploration (needle-in-a-haystack retrieval + reasoning)
- **Prompt (both agents, verbatim):**
  > Needle-in-a-haystack search of this codebase (the `locally` MCP server, root `src/`).
  >
  > Somewhere in the code, a subprocess's output buffer is deliberately sized to a multiple of the limit on how much of that output is actually returned to the caller — i.e. the capture buffer is intentionally larger than the truncation cap. There are several other byte/character caps and `maxBuffer` settings scattered across the codebase that are NOT this one; ignore them.
  >
  > Find that specific spot and answer, with a `file:line` citation for each:
  > 1. The exact `file:line` where the capture buffer size is set, and the expression used to compute it.
  > 2. The numeric value that expression evaluates to.
  > 3. The `file:line`(s) and value of the limit that actually truncates the returned output.
  > 4. Why is the buffer deliberately larger than the truncation limit — what would break if they were equal? Explain the mechanism.
  > 5. Name at least two other `maxBuffer`/byte caps elsewhere in the codebase and why they are NOT the answer.
- **locally run:** `explore_task`, `breadth: "very thorough"`, `path: src/`, agent `ornith-1.0-9b-q8_0`
- **Explore run:** native Explore subagent (frontier model)
- **Cost:** locally = ~6.4k processed / ~1.3k generated locally, 3 iterations. Explore = full frontier tokens.

## The needle (ground truth, verified against source)

- **Buffer:** `src/tools/run-shell.ts:76` — `maxBuffer: MAX_OUTPUT_CHARS * 4`, where `MAX_OUTPUT_CHARS = 10_000` (`run-shell.ts:7`). Evaluates to **40,000**.
- **Truncation:** `run-shell.ts:82` (success path) **and `:89`** (error path) — `.slice(0, MAX_OUTPUT_CHARS)` → **10,000**.
- **Why ×4:** Node's `maxBuffer` is a hard, per-stream **byte** ceiling on captured output — exceed it and `execFile` aborts the child with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and the caller gets an error, not truncated text. The truncation `.slice()` only runs *after* a successful capture. So the buffer must exceed the return cap, or any output past 10k would error instead of being captured-then-truncated. The specific ×4 maps to UTF-8's max **4 bytes/char**: it guarantees 10,000 chars of even maximally-wide characters fit in the byte buffer. (No comment in source states this — the "why" is pure inference.)
- **Decoys:** `explore-files.ts:231` & `:246` (`maxBuffer: 10 * 1024 * 1024`, 10MB, for rg/grep — no post-truncation), `http.ts:6` (`MAX_BODY_BYTES = 1024 * 1024`, 1MB HTTP body cap), the `"exceeded 10MB limit"` string at `explore-files.ts:49`, and the 100KB per-file skip at `explore-files.ts:136`.

---

## Output A — locally (`explore_task`, very thorough)

> Footer reported by the tool: `_locally · ornith-1.0-9b-q8_0 · 3 iters · ~6.4k processed · ~1.3k generated_`

### 1. Capture buffer size (set deliberately larger)

**File:** `src/tools/run-shell.ts:76`

```ts
maxBuffer: MAX_OUTPUT_CHARS * 4,
```

`MAX_OUTPUT_CHARS` is defined at **`src/tools/run-shell.ts:13`** as `10_000`.

**Numeric value:** `10_000 × 4 = 40,000` characters.

### 2. Truncation cap on the returned output

**File:** `src/tools/run-shell.ts:71`

```ts
return (parts.join("\n").slice(0, MAX_OUTPUT_CHARS) || "(no output)");
```

**Value:** `MAX_OUTPUT_CHARS = 10_000` characters.

### 3. Why the buffer is deliberately larger

Node.js's `maxBuffer` is a **hard capture ceiling** — if a subprocess writes more than `maxBuffer` bytes to stdout or stderr, Node throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and the child process is killed, **before any output is returned to the caller**.

The truncation at line 71 (`.slice(0, MAX_OUTPUT_CHARS)`) runs only *after* the subprocess has already finished and its output has been fully captured. If `maxBuffer` were set equal to the truncation cap (10,000), then any subprocess producing **exactly 10,001 characters** would exceed the buffer, the error would fire, and the caller would get an error instead of the truncated output. The `× 4` multiplier gives headroom so that the full output is safely captured, then intentionally truncated for the response payload.

### 4. Two other `maxBuffer` / byte caps (not the answer)

| Location | Value | Why it's not the answer |
|---|---|---|
| `src/tools/explore-files.ts:231` | `10 * 1024 * 1024` (10 MB) | No corresponding smaller truncation cap; the ripgrep output is expected to be large (multi-GB file trees) and is only bounded by Node's default `maxBuffer` (~1 MB), so 10 MB is chosen to avoid the error entirely. |
| `src/tools/explore-files.ts:246` | `10 * 1024 * 1024` (10 MB) | Same pattern — grep output over large trees is not truncated afterward, just captured with a generous buffer. |

These are "just make it big enough" buffers, not "buffer > truncation cap" patterns.

---

## Output B — native Explore agent

**1. Buffer size location and expression:**
- **File:Line**: `/root/projects/locally/src/tools/run-shell.ts:76`
- **Expression**: `maxBuffer: MAX_OUTPUT_CHARS * 4`
- **Numeric value**: `40,000` bytes (MAX_OUTPUT_CHARS is defined as 10,000 on line 7)

**2. Truncation limit:**
- **File:Lines**: `/root/projects/locally/src/tools/run-shell.ts:82` and `:89`
- **Expression**: `.slice(0, MAX_OUTPUT_CHARS)`
- **Value**: `10,000` bytes

**3. Why the buffer is deliberately 4x larger:**

The buffer must be significantly larger than the truncation limit because of how the code handles subprocess output:

```typescript
const { stdout, stderr } = await execFileAsync(command, args, {
  maxBuffer: MAX_OUTPUT_CHARS * 4,  // 40,000 bytes
});
const parts: string[] = [];
if (stdout) parts.push(`stdout:\n${stdout}`);
if (stderr) parts.push(`stderr:\n${stderr}`);
return parts.join("\n").slice(0, MAX_OUTPUT_CHARS);  // truncate to 10,000
```

**The mechanism**: If maxBuffer equaled the truncation limit (10,000), the formatting prefixes ("stdout:\n" and "stderr:\n") would consume part of that limit. A subprocess outputting 10,000 bytes plus formatting would cause content loss during truncation. By setting maxBuffer to 40,000, both stdout and stderr can capture meaningful amounts independently, and when combined with formatting and then truncated, there's sufficient headroom to preserve actual output without the prefix strings eating into the final 10,000-byte result.

**4. Other maxBuffer/byte caps that are NOT this answer:**

1. **`/root/projects/locally/src/tools/explore-files.ts:231`** - `maxBuffer: 10 * 1024 * 1024` (10MB for ripgrep): This is a large, fixed buffer with no corresponding truncation limit—the entire stdout is returned as-is, not combined with formatted prefixes.

2. **`/root/projects/locally/src/tools/explore-files.ts:246`** - `maxBuffer: 10 * 1024 * 1024` (10MB for grep): Same as ripgrep—no truncation limit applied to the final output.

3. **`/root/projects/locally/src/transport/http.ts:6`** - `MAX_BODY_BYTES = 1024 * 1024` (1MB): This is an HTTP request body size limit, entirely different use case—not related to subprocess output capture.

---

## Evaluation

### Quantitative — inaccuracy count (verified against source)

Verified by reading `src/tools/run-shell.ts` (full), and grepping `maxBuffer` / `slice(0` / `MAX_BODY_BYTES` across `src/`.

| # | Claim | locally | Explore | Ground truth |
|---|---|---|---|---|
| 1 | Needle location (buffer) | ✅ `run-shell.ts:76`, `MAX_OUTPUT_CHARS * 4` | ✅ `run-shell.ts:76`, `MAX_OUTPUT_CHARS * 4` | `run-shell.ts:76` |
| 2 | Buffer value | ✅ 40,000 | ✅ 40,000 | 40,000 |
| 3 | `MAX_OUTPUT_CHARS` definition line | ⚠️ "line 13" | ✅ "line 7" | `run-shell.ts:7` (line 13 is the `ALLOWED_COMMANDS` list) |
| 4 | Truncation site `file:line` | ❌ "line 71"; missed `:89` | ✅ `:82` **and** `:89` | `.slice(0, MAX_OUTPUT_CHARS)` at `:82` (success) and `:89` (error path) |
| 5 | Truncation value | ✅ 10,000 chars | ⚠️ "10,000 bytes" | 10,000 (chars — `.slice` on a JS string) |
| 6 | **Why buffer > cap (mechanism)** | ✅ capture-then-truncate; equal cap → output >10k **errors** instead of truncating | ❌ "formatting prefixes would eat the limit" | Prefixes are added in JS *after* capture and are never counted against `maxBuffer` (a per-stream raw-byte ceiling); locally's mechanism is the real one |
| 7 | Decoys identified | ✅ 231, 246 (10MB) | ✅ 231, 246 (10MB) + `http.ts:6` (1MB) | all valid; Explore gave one extra |

**Hard inaccuracies: locally 1 (#4 — truncation cited at wrong line 71, second site `:89` missed), Explore 1 (#6 — wrong mechanism for the "why").**

**Minor/terminology: locally 1 (#3 — `MAX_OUTPUT_CHARS` line drift), Explore 1 (#5 — "bytes" for a char-based `.slice`).**

**Totals — locally: 1 hard + 1 minor = 2. Explore: 1 hard + 1 minor = 2.** Dead even again — and again the errors are *complementary*: each was right exactly where the other slipped.

### Qualitative

- **Retrieval (the actual needle):** Both nailed it on the first real read — correct file, expression, and 40,000/10,000 values, and both correctly discriminated the needle from the 10MB rg/grep decoys. For pure "find the buried thing," they tied. locally did it in **3 iterations / ~6.4k processed** — it did not get lost in the haystack.
- **Role-reversal vs. the first eval.** Last run, Explore won citations and locally won nothing on precision. Here it splits the *other* way on the two dimensions:
  - **Citations:** Explore wins — exact lines (7, 76, 82, 89), both truncation sites, an extra decoy. locally's in-file line numbers **drifted** (13 vs 7, 71 vs 82) and it missed the error-path truncation at `:89`, even though its quoted code was verbatim-correct. Same weakness flagged in the first eval: locally is unreliable on precise line numbers (note its *cross-file* decoy cites 231/246 were spot-on — the drift is local to the file it reasons hardest about).
  - **Reasoning:** locally wins — it gave the correct mechanism (buffer must exceed the cap or large output errors before it can be truncated). Explore produced a confident but **wrong** rationale (formatting prefixes eating the limit), conflating the post-capture JS `.slice()` with Node's pre-capture per-stream byte ceiling. Neither surfaced the sharpest reason (×4 = UTF-8's max 4 bytes/char), but locally's answer is correct and responsive; Explore's is not.
- **Cost/efficiency:** locally is again the standout — frontier-comparable retrieval and *better* reasoning here for ~6.4k/1.3k local tokens and zero frontier cost. ~8x cheaper than its own first-eval run, on a harder-to-locate target.

### Takeaway

For needle-in-a-haystack retrieval, locally is fully competitive: it found the same buried constant as the frontier agent, discriminated it from convincing decoys, and reasoned about it *more* correctly — for a rounding-error token cost. The persistent caveat is unchanged and now doubly confirmed: **do not trust locally's exact line numbers** — verify them (its prose/quotes were right while its line citations were off by 6–11 lines and dropped a second site). Conversely, this run is a reminder the frontier agent is **not** automatically right on the "why": Explore's precise citations came bundled with a confidently wrong mechanism. Verify both — locally for *where*, Explore for *why*.

### Method (repeatable)

1. Pick a genuine needle: one deliberate, obscure detail (here, `maxBuffer = MAX_OUTPUT_CHARS * 4`) surrounded by ~15 confusable numeric caps as decoys; confirm ground truth by reading source first.
2. Give **both** agents the identical prompt (locate + value + truncation site + *why* + name the decoys), requiring `file:line` for each — so retrieval, discrimination, and reasoning are all scored.
3. locally: `explore_task`, `breadth: "very thorough"`, `path: src/`. Explore: native subagent. Same prompt verbatim.
4. Capture both outputs verbatim into one dated file under `eval-runs/`.
5. Verify every line citation and the mechanism against source (Read/grep). Score hard vs. minor per agent; state PASS/FAIL.
