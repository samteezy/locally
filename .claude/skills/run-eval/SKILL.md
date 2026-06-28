---
name: run-eval
description: Benchmark locally (explore_task / run_task) against the equivalent native frontier-model agent on a codebase task, then score the results. Use when the user wants to evaluate, benchmark, or compare locally's output quality vs. the Explore/main-loop agent, or to add a run to eval-runs/. Covers exploration, documentation, and code-generation tasks.
---

# run-eval

Benchmark **locally** against the equivalent **native frontier-model agent** on the same task, capture both outputs, verify them against source, and score the quality gap. Output is one dated Markdown file in `eval-runs/`.

## When to use

The user wants to compare/benchmark locally's quality vs. the native agent, or asks to "add an eval run." Task categories:

| Category | locally tool | Native baseline |
|---|---|---|
| exploration | `explore_task` (`breadth: very thorough`) | Explore subagent |
| documentation | `explore_task` or `run_task` | Explore subagent or main loop |
| code-generation | `run_task` | main loop / a general-purpose subagent |

## Procedure

1. **Define the test.** Pin down one concrete task and the exact prompt. The same prompt string goes to **both** agents verbatim — no rewording, or the comparison is invalid. For exploration/docs, require `file:line` citations so claims are checkable.

2. **Run locally first.** Call the matching MCP tool (`mcp__locally__explore_task` or `mcp__locally__run_task`). For exploration, pass a `path` to pre-map and `breadth: "very thorough"`. Capture the full output including its usage footer (model, iterations, tokens).

3. **Run the native baseline.** Spawn the equivalent subagent (`Explore` for exploration/docs; a general-purpose or the main loop for generation) with the identical prompt.

4. **Verify, don't trust.** Find every point where the two outputs **disagree**, plus a sample of high-specificity claims (config defaults, fallback scope, data-structure names, line numbers). Verify each against source with Read/grep. This is the core of the eval — unverified scoring is worthless.

5. **Score.**
   - **Quantitative:** an inaccuracy table — for each contested/checked claim, mark each agent ✅ / ❌ / ⚠️ against ground truth. Tally **hard** inaccuracies (substantively wrong) vs. **minor** (terminology/imprecision) per agent.
   - **Qualitative:** citations, depth/completeness, accuracy, and cost/efficiency (local tokens vs. frontier).
   - **Pass criteria:** locally's hard-inaccuracy count ≤ the baseline's, and its core structure matches source. State PASS/FAIL.

6. **Write the file.** `eval-runs/YYYY-MM-DD-<slug>.md` (use the real current date). Structure:
   - A `<!-- test: ... -->` YAML-ish header block (id, category, subject-under-test, baseline, identical-prompt, scoring, pass-criteria, result).
   - `# Eval: <title>` with metadata (date, task type, prompt, runs, cost).
   - `## Output A — locally` (verbatim, incl. footer).
   - `## Output B — native <baseline>` (verbatim).
   - `## Evaluation` — quantitative table + totals, then qualitative notes, takeaway, and a short repeatable-method recap.

7. **Report back** the headline: hard/minor counts per agent, the cost delta, and PASS/FAIL.

## Reference

See `eval-runs/2026-06-28-codebase-tour-locally-vs-explore.md` for the canonical format. The repo convention and rationale live under **## Evals** in `CLAUDE.md`.

## Notes

- Keep the prompt identical across agents — this is the one rule that makes the numbers mean anything.
- Both agents make mistakes; the shared blind spots (e.g. mislabeling FIFO as "LRU" in the first run) are the most interesting findings — call them out.
- Convert any relative dates to absolute when writing the file.
