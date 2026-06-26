import { runCompletion } from "../llm/client.js";
import { resolveAgentConfig, type LocallyConfig } from "../config.js";

export interface RunTaskParams {
  task: string;
  system_prompt?: string;
  agent?: string;
  max_tokens?: number;
}

export async function runTask(config: LocallyConfig, params: RunTaskParams): Promise<string> {
  const { task, system_prompt, agent, max_tokens } = params;

  const agentConfig = resolveAgentConfig(config, agent);

  if (max_tokens !== undefined) {
    agentConfig.maxTokens = max_tokens;
  }

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (system_prompt) {
    messages.push({ role: "system", content: system_prompt });
  }
  messages.push({ role: "user", content: task });

  return runCompletion(agentConfig, messages);
}
