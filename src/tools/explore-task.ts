import { runAgenticTask, type AgenticTaskParams } from "./agentic-task.js";
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
- Use explore_files to fan out: search file contents, list directories, and follow naming conventions across the tree.
- Use read_file to read targeted EXCERPTS (pass offset/limit for a line range). Do not read whole files unless they are small; you are locating code, not reviewing it.
- Prefer several cheap, focused searches over one broad dump.

How to answer:
- Finish with a concise conclusion that directly answers the task.
- Cite concrete locations as path:line (e.g. src/llm/agent-loop.ts:152). Reference code; do not paste large file contents.
- If you cannot find something, say so plainly rather than guessing.
- Report what the code does and where it is. Do not evaluate quality, judge correctness, or recommend changes — if the task asks for that, answer only the factual "what/where" part and say the rest is out of scope.`;

const BREADTH_GUIDANCE: Record<Breadth, string> = {
  medium: "Breadth: medium — check the most likely locations and stop once you can answer confidently.",
  "very thorough":
    "Breadth: very thorough — sweep multiple locations and naming-convention variants across the whole tree before concluding.",
};

const BREADTH_MAX_ITERATIONS: Record<Breadth, number> = {
  medium: 8,
  "very thorough": 20,
};

export function exploreTask(config: LocallyConfig, params: ExploreTaskParams): Promise<AgentRunResult> {
  const breadth: Breadth = params.breadth === "very thorough" ? "very thorough" : "medium";

  const baseSystemPrompt = `${EXPLORE_SYSTEM_PROMPT}\n\n${BREADTH_GUIDANCE[breadth]}`;

  // An explicit max_iterations from the caller still wins; otherwise default per breadth.
  const max_iterations = params.max_iterations ?? BREADTH_MAX_ITERATIONS[breadth];

  return runAgenticTask(
    config,
    { ...params, baseSystemPrompt, max_iterations },
    "explore",
    AGENT_TOOLS
  );
}
