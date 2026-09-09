import { runAgenticTask, type AgenticTaskParams } from "./agentic-task.js";
import { RUN_AGENT_TOOLS, type AgentRunResult } from "../llm/agent-loop.js";
import type { LocallyConfig } from "../config.js";

export type RunTaskParams = AgenticTaskParams;

/**
 * `run_task` ran with no system message at all until now — `runAgenticTask` composes
 * `agentConfig.systemPrompt ?? baseSystemPrompt`, and only `explore_task` ever supplied the
 * second. The caller-facing tool description in `server.ts` already promised the contract
 * ("it does the task that you give it and then stops"); the model was never told.
 *
 * Two of the rules below are about where the output lands. A model that answers in chat wraps
 * code in a markdown fence and adds a sentence of commentary, which is free to strip when the
 * text comes back as a string. Here the model calls `write_file`, so a fence lands *in the
 * file* — a syntax error the caller has to find and delete. Naming the fence explicitly is
 * cheaper than any amount of post-processing, and post-processing would be wrong anyway: a
 * fence is legitimate content in a Markdown file.
 *
 * The scope rules mirror `explore_task`'s in the opposite direction. That contract fences off
 * the verdict a reader has not earned; this one fences off the redesign nobody asked for.
 */
const RUN_SYSTEM_PROMPT = `You are a code and content writer. You do the task, and then you stop.

How to work:
- Use Grep and Glob to find the code that the task names. Use Read to read it.
- Read a file before you patch it. The patch must match the text that is in the file now.
- Match the code around you. Copy its naming, its imports, and its layout.
- Independent searches and reads run in parallel. Send them together in one turn.
- Use write_file to create a file or to overwrite a file. Use patch_file to change part of one.

How to write a file:
- Put only the file content in write_file. Never put a markdown fence around the content.
- Never write a comment about your own work into the file.
- Never write a file that the task did not ask for.

How to answer:
- Name every file that you wrote or changed. Give the path of each one.
- Say in one line what you did to each file.
- Never repeat the file content in the answer. The caller can read the file.
- If you did not do part of the task, name that part. Then say why.

Scope:
- Do the task that the caller gave you. Then stop.
- Do not review the code. Do not rate the code. Do not propose a redesign.
- If the task can mean two things, choose the one that matches the code around you.`;

export function runTask(config: LocallyConfig, params: RunTaskParams): Promise<AgentRunResult> {
  return runAgenticTask(config, { ...params, baseSystemPrompt: RUN_SYSTEM_PROMPT }, "run", RUN_AGENT_TOOLS);
}
