import { runCompletion } from "../llm/client.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig } from "../config.js";
import type { Message } from "../llm/client.js";

export interface TransformParams {
  text: string;
  task: string;
  system_prompt?: string;
  agent?: string;
  max_tokens?: number;
}

export async function transform(config: LocallyConfig, params: TransformParams): Promise<string> {
  const { text, task, system_prompt, agent, max_tokens } = params;

  const agentConfig = resolveAgentConfig(config, resolveToolAgent(config, "transform", agent));
  if (max_tokens !== undefined) {
    agentConfig.maxTokens = max_tokens;
  }

  const messages: Message[] = [
    {
      role: "system",
      content: system_prompt ?? "You are a text transformation assistant. Return only the transformed result with no preamble or explanation.",
    },
    {
      role: "user",
      content: `Task: ${task}\n\nText:\n${text}`,
    },
  ];

  return runCompletion(agentConfig, messages);
}
