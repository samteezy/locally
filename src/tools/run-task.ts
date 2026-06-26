import { runAgenticTask, type AgenticTaskParams } from "./agentic-task.js";
import { RUN_AGENT_TOOLS } from "../llm/agent-loop.js";
import type { LocallyConfig } from "../config.js";

export type RunTaskParams = AgenticTaskParams;

export function runTask(config: LocallyConfig, params: RunTaskParams): Promise<string> {
  return runAgenticTask(config, params, "run", RUN_AGENT_TOOLS);
}
