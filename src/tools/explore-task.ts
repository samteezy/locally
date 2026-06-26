import { runAgenticTask, type AgenticTaskParams } from "./agentic-task.js";
import { AGENT_TOOLS } from "../llm/agent-loop.js";
import type { LocallyConfig } from "../config.js";

export type ExploreTaskParams = AgenticTaskParams;

export function exploreTask(config: LocallyConfig, params: ExploreTaskParams): Promise<string> {
  return runAgenticTask(config, params, "explore", AGENT_TOOLS);
}
