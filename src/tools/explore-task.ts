import { runAgenticTask, type AgenticTaskParams } from "./agentic-task.js";
import { verifyCitations, formatCitationReport, renderCitationBlock, type CitationCheck } from "./verify-citations.js";
import { verifySymbols, formatSymbolReport } from "./verify-symbols.js";
import { verifyPaths, formatPathReport, type PathCheck } from "./verify-paths.js";
import { verifyPlacement, formatPlacementReport } from "./verify-placement.js";
import { FileResolver } from "./resolve-path.js";
import { effectiveRoots } from "./sandbox.js";
import { AGENT_TOOLS, type AgentRunResult } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, symbolCheckEnabled, type LocallyConfig } from "../config.js";

export type Breadth = "medium" | "very thorough";

export interface ExploreTaskParams extends AgenticTaskParams {
  /** How widely to search. Mirrors the native Explore agent's breadth knob. */
  breadth?: Breadth;
}

/**
 * Base contract handed to the local model — what to do, how to read, how to answer.
 *
 * The "findings, not an assessment" rule is issue #23, and it is measured rather than assumed:
 * asked to audit this repository's shell surface, a 9B model missed the `find -exec` / `npm run`
 * allowlist bypass entirely and concluded the surface was safe
 * (`eval-runs/2026-06-28-security-analysis-locally-vs-explore.md`). A small model is accurate about
 * structure it read and confident about judgments it has not earned, so the contract asks for the
 * half it can do and makes it name the half it cannot. Reporting a mechanism it actually read is
 * still in scope — on the needle eval that reasoning beat the frontier agent's.
 */
const EXPLORE_SYSTEM_PROMPT = `You are a fast, read-only code-exploration agent. Your job is to ANSWER the question by searching the codebase — not to write, edit, review, evaluate, or audit code.

How to work:
- Start with Grep: it searches file contents and returns matching lines as path:line:text. Several narrow searches beat one broad sweep.
- Use Glob to find out which files exist before deciding what to open — it takes a pattern like "*.ts" or "src/**/*.tsx" and returns paths with line counts.
- Use Read to read targeted EXCERPTS (pass offset and limit for a line range). Do not read whole files unless they are small; you are locating code, not reviewing it.
- Independent searches and reads are run in parallel, so issue them together in one turn rather than one at a time.
- Grep and Glob skip files git ignores, such as build output and local config; every result header names the filter that ran. A search that finds nothing is retried without it automatically, and include_ignored forces it.
- The directory map you are given is a starting point, not a boundary. If the answer depends on a file outside it, search for that file and read it.

How to answer:
- Finish with a concise conclusion that directly answers the task.
- Every factual claim carries a path:line, written from the top of the repository — src/llm/agent-loop.ts:152, not agent-loop.ts:152. A claim with no location is not an answer. Read output and search results are line-numbered — cite the number you actually saw, never one you estimated.
- Never state what a file contains unless you read it or matched it in a search. Describing an unopened file is the worst thing you can do here.
- Before naming a SET of files, list the directory with Glob and take the names from that listing. Never derive a filename from a pattern: "one schema file per table" is a guess about what the code ought to look like, and a correct list of tables is not evidence for a list of files.
- If you did not actually read the code behind a claim, begin that claim with "LIKELY:" and say what you inferred it from. An honest LIKELY beats a guessed path:line. Do not label the claims you did read — their citation is the evidence — and never rate the answer as a whole: a blanket "everything here is confirmed" line gives the reader nothing to act on.
- When you list or enumerate, name the search that produced the list and say it may be incomplete — e.g. "4 found via Grep 'can[A-Z]' in entitlements/; this sweep may be incomplete." A bare list reads as exhaustive whether or not it is.
- If you cannot find something, say so plainly and name where you looked. "Not found in X, Y, Z" is a useful answer; a confident guess is not.
- Your output is findings, not an assessment. Report what the code does and where it is. Do not judge quality or correctness, rate severity or risk, recommend or suggest changes, or add a summary, "key takeaways" or assessment section nobody asked for.
- If the task asks for a judgment, answer the factual what/where half and end with one line naming what you left out — "Out of scope: whether this is safe. Reported: where each check runs." A named gap is useful; a guessed verdict is worse than nothing.

End your answer with a citations block listing every location it rests on, one per line, each a path and a line or line range followed by a few words on what is there:

<citations>
src/llm/agent-loop.ts:238-279 parallel tool dispatch
src/config.ts:107 agent resolution
</citations>

This block is checked against the filesystem before your answer is returned, so put a location in it only if you actually saw it.`;

const BREADTH_GUIDANCE: Record<Breadth, string> = {
  medium: "Breadth: medium — check the most likely locations and stop once you can answer confidently.",
  "very thorough":
    "Breadth: very thorough — before concluding, list the candidate locations and naming-convention variants you intend to check, then work through that list with separate searches and tick each one off. One search is not a thorough sweep.",
};

const BREADTH_MAX_ITERATIONS: Record<Breadth, number> = {
  medium: 8,
  "very thorough": 20,
};

/**
 * What a "very thorough" sweep has to have done before its answer is accepted.
 *
 * Breadth used to be prompt flavouring and an iteration ceiling, and nothing scaled the work to it:
 * one measured run spent 5 of its 20 iterations and read 5 files against a subsystem of ~8,800
 * lines, while a "medium" run of the same repository read 8 (issue #16). A run below this floor is
 * asked once to keep going, and is told to the caller if it still finishes short.
 */
const THOROUGH_FLOOR = { minIterations: 6, minFilesRead: 5 };

/** Beyond this the "described without being read" list stops being readable. */
const MAX_LISTED_UNREAD = 8;

function sweepNudge(state: { iterations: number; filesRead: number }): string {
  return [
    `You are on a "very thorough" sweep and have made ${state.iterations} search iteration(s), opening ${state.filesRead} file(s). That is not yet a thorough sweep.`,
    "",
    "Before concluding: name the directories and naming-convention variants relevant to this task that you have NOT yet opened, then check them with Grep, Glob and Read. Prefer listing a directory over guessing what is in it.",
    "",
    "If you have genuinely covered them, say which searches you ran and give your answer again — do not pad it.",
  ].join("\n");
}

function shallowSweepNote(result: AgentRunResult): string {
  const iters = `${result.iterations} iteration${result.iterations === 1 ? "" : "s"}`;
  const files = `${result.filesRead} file${result.filesRead === 1 ? "" : "s"}`;
  const asked = result.nudged ? " It was asked to keep sweeping and concluded anyway." : "";
  return `> **Shallow sweep:** this ran as "very thorough" but concluded after ${iters}, opening ${files}.${asked} Treat the coverage as narrow.`;
}

/**
 * Which of the files this answer describes did the run never actually look at?
 *
 * The complement of the existence check: those files are real, so nothing above flags them, and a
 * model that never opened them described them anyway (issue #16).
 *
 * What counts as evidence depends on the claim. Citing `foo.ts:47` is a claim about the *contents*
 * of a line, and only reading the file or matching it in a search supports that. Naming `foo.ts` is
 * a claim that the file exists, which a directory listing settles perfectly well — and one of the
 * two runs behind this issue was a correct inventory of three directories, so treating a listing as
 * no evidence would recreate the false alarm the issue is about.
 */
function coverageNote(
  citations: CitationCheck[],
  paths: PathCheck[],
  result: AgentRunResult
): string {
  // canonical path → how the answer wrote it.
  const named = new Map<string, string>();
  // Files the answer cited a line of. A listing does not support a claim about a line's contents,
  // so if a file is both cited and merely named, the stricter requirement is the one that holds.
  const citedByLine = new Set<string>();

  for (const c of citations) {
    if (!c.ok || !c.resolvedPath) continue;
    named.set(c.resolvedPath, c.citation.replace(/:\d+(?:-\d+)?$/, ""));
    citedByLine.add(c.resolvedPath);
  }
  for (const p of paths) {
    if (p.exists && p.resolvedPath && !named.has(p.resolvedPath)) named.set(p.resolvedPath, p.path);
  }
  if (named.size === 0) return "";

  const read = new Set([...result.filesReadPaths, ...result.filesMatchedPaths]);
  const listed = new Set(result.filesListedPaths);
  const unread = [...named]
    .filter(([canonical]) => (citedByLine.has(canonical) ? !read.has(canonical) : !read.has(canonical) && !listed.has(canonical)))
    .map(([, written]) => written);
  if (unread.length === 0) return "";

  const shown = unread.slice(0, MAX_LISTED_UNREAD).map((p) => `\`${p}\``).join(", ");
  const more = unread.length > MAX_LISTED_UNREAD ? `, and ${unread.length - MAX_LISTED_UNREAD} more` : "";
  return `_Coverage: this answer names ${named.size} existing file${named.size === 1 ? "" : "s"}; ${named.size - unread.length} of them were opened, searched, or listed during the run. Described without being looked at: ${shown}${more}._`;
}

export async function exploreTask(config: LocallyConfig, params: ExploreTaskParams): Promise<AgentRunResult> {
  const breadth: Breadth = params.breadth === "very thorough" ? "very thorough" : "medium";

  const baseSystemPrompt = `${EXPLORE_SYSTEM_PROMPT}\n\n${BREADTH_GUIDANCE[breadth]}`;

  // Resolved here rather than inside runAgenticTask because the sweep floor below has to know the
  // budget the run will actually get, and that depends on the agent's own maxIterations. Passed
  // down so the same config is not resolved twice.
  const resolvedAgent = resolveAgentConfig(config, resolveToolAgent(config, "explore", params.agent));

  // An explicit max_iterations from the caller wins, then the agent's own budget, then breadth.
  const max_iterations =
    params.max_iterations ?? resolvedAgent.maxIterations ?? BREADTH_MAX_ITERATIONS[breadth];

  // Only ask for more work when there is budget left to do it in — a caller who capped the run
  // short has already said how much sweeping they want.
  const sweepFloor =
    breadth === "very thorough" && max_iterations > THOROUGH_FLOOR.minIterations ? THOROUGH_FLOOR : undefined;

  const result = await runAgenticTask(
    config,
    { ...params, baseSystemPrompt, max_iterations, sweepFloor, sweepNudge, resolvedAgent },
    "explore",
    AGENT_TOOLS
  );

  const roots = effectiveRoots(config);
  const notes: string[] = [];

  // One resolver for all three filesystem checks. Each of them re-opens the files the answer cites,
  // and the placement check needs their text rather than just their length, so sharing the cache is
  // what keeps a fourth check from costing a fourth read of every file.
  const resolver = new FileResolver(roots, params.path);

  // The tagged block is for the checkers below, not for the caller: verification reads it off the
  // raw text, and what comes back is the same citations as ordinary markdown.
  const text = renderCitationBlock(result.text);
  let citations: CitationCheck[] = [];
  let paths: PathCheck[] = [];

  // Check the citations against the filesystem before handing them back, so the caller
  // gets "checked" rather than "probably right". The task's own path is passed in: a run mapped at
  // a subdirectory cites basenames from it, and resolving those against the roots alone reported
  // 19 of 19 correct citations as missing files (issue #16).
  try {
    const checked = await verifyCitations(result.text, roots, params.path, resolver);
    citations = checked.checks;
    const report = formatCitationReport(checked);
    if (report) notes.push(report);
  } catch {
    // Verification is an add-on; never fail a good answer because the check itself broke.
  }

  // Names and file paths the answer asserts exist, checked against the tree. Off switch is an env
  // var set by whoever runs the server (LOCALLY_VERIFY_SYMBOLS=0), not something the model can reach.
  if (symbolCheckEnabled()) {
    try {
      const report = formatSymbolReport(await verifySymbols(text, roots));
      if (report) notes.push(report);
    } catch {
      // Same rule as the citation check: an add-on must never sink a good answer.
    }

    try {
      // Paths a citation already covered are skipped, so one invented file is named once.
      const cited = new Set(citations.map((c) => c.citation.replace(/:\d+(?:-\d+)?$/, "")));
      const checked = await verifyPaths(text, roots, params.path, cited, resolver);
      paths = checked.checks;
      const report = formatPathReport(checked);
      if (report) notes.push(report);
    } catch {
      // As above.
    }

    try {
      // Read off the raw answer, like the citation check, so the tagged block is still there to
      // pair a name with a line. Citations that already failed are skipped: a bad line number and a
      // missing file are one mistake, and it gets one footer line.
      const failed = new Set(citations.filter((c) => !c.ok).map((c) => c.citation));
      const checked = await verifyPlacement(result.text, roots, params.path, failed, resolver);
      const report = formatPlacementReport(checked);
      if (report) notes.push(report);
    } catch {
      // As above.
    }
  }

  try {
    const report = coverageNote(citations, paths, result);
    if (report) notes.push(report);
  } catch {
    // As above.
  }

  if (
    breadth === "very thorough" &&
    (result.iterations < THOROUGH_FLOOR.minIterations || result.filesRead < THOROUGH_FLOOR.minFilesRead)
  ) {
    notes.push(shallowSweepNote(result));
  }

  if (notes.length === 0) return { ...result, text };
  return { ...result, text: [text, ...notes].join("\n\n") };
}
