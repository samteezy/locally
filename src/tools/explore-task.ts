import { runAgenticTask, type AgenticTaskParams } from "./agentic-task.js";
import { verifyCitations, formatCitationReport } from "./verify-citations.js";
import { effectiveRoots } from "./sandbox.js";
import { AGENT_TOOLS, type AgentRunResult } from "../llm/agent-loop.js";
import type { LocallyConfig } from "../config.js";

export type Breadth = "medium" | "very thorough";

export interface ExploreTaskParams extends AgenticTaskParams {
  /** How widely to search. Mirrors the native Explore agent's breadth knob. */
  breadth?: Breadth;
}

/** Base contract handed to the local model — what to do, how to read, how to answer. */
const EXPLORE_SYSTEM_PROMPT = `You are a fast, read-only code-exploration agent. Your job is to ANSWER the question by searching the codebase — not to write, edit, review, or audit code.

How to work:
- Start with explore_files and a query: it greps file contents and returns matching lines as path:line:text. Several narrow searches beat one broad sweep.
- Use explore_files without a query to see what files exist (paths, line counts, sizes) before deciding what to open.
- Use read_file to read targeted EXCERPTS (pass offset/limit for a line range). Do not read whole files unless they are small; you are locating code, not reviewing it.
- The directory map you are given is a starting point, not a boundary. If the answer depends on a file outside it, search for that file and read it.

How to answer:
- Finish with a concise conclusion that directly answers the task.
- Cite concrete locations as path:line (e.g. src/llm/agent-loop.ts:152). read_file output and search results are line-numbered — cite the number you actually saw, never one you estimated.
- Never state what a file contains unless you read it or matched it in a search. Describing an unopened file is the worst thing you can do here.
- If you cannot find something, say so plainly and name where you looked. "Not found in X, Y, Z" is a useful answer; a confident guess is not.
- Report what the code does and where it is. Do not evaluate quality, judge correctness, or recommend changes — if the task asks for that, answer only the factual "what/where" part and say the rest is out of scope.`;

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
 * A "very thorough" sweep that finishes almost immediately did not actually sweep.
 * Say so rather than letting the breadth setting imply coverage that never happened.
 */
const SHALLOW_SWEEP_ITERATIONS = 2;

export async function exploreTask(config: LocallyConfig, params: ExploreTaskParams): Promise<AgentRunResult> {
  const breadth: Breadth = params.breadth === "very thorough" ? "very thorough" : "medium";

  const baseSystemPrompt = `${EXPLORE_SYSTEM_PROMPT}\n\n${BREADTH_GUIDANCE[breadth]}`;

  // An explicit max_iterations from the caller still wins; otherwise default per breadth.
  const max_iterations = params.max_iterations ?? BREADTH_MAX_ITERATIONS[breadth];

  const result = await runAgenticTask(
    config,
    { ...params, baseSystemPrompt, max_iterations },
    "explore",
    AGENT_TOOLS
  );

  const notes: string[] = [];

  // Check the citations against the filesystem before handing them back, so the caller
  // gets "checked" rather than "probably right".
  try {
    const report = formatCitationReport(await verifyCitations(result.text, effectiveRoots(config)));
    if (report) notes.push(report);
  } catch {
    // Verification is an add-on; never fail a good answer because the check itself broke.
  }

  if (breadth === "very thorough" && result.iterations <= SHALLOW_SWEEP_ITERATIONS) {
    notes.push(
      `> **Shallow sweep:** this ran as "very thorough" but concluded after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"}, so few searches were actually made. Treat the coverage as narrow.`
    );
  }

  if (notes.length === 0) return result;
  return { ...result, text: [result.text, ...notes].join("\n\n") };
}
