import { buildTree } from "./explore-files.js";
import { runAgentLoop, RUN_AGENT_TOOLS } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig } from "../config.js";
import type { Message } from "../llm/client.js";

export interface RunTaskParams {
  task: string;
  path?: string;
  system_prompt?: string;
  agent?: string;
  max_tokens?: number;
  max_iterations?: number;
}

export async function runTask(config: LocallyConfig, params: RunTaskParams): Promise<string> {
  const { task, path, system_prompt, agent, max_tokens, max_iterations } = params;

  const agentConfig = resolveAgentConfig(config, resolveToolAgent(config, "run", agent));
  if (max_tokens !== undefined) {
    agentConfig.maxTokens = max_tokens;
  }

  const messages: Message[] = [];

  if (system_prompt) {
    messages.push({ role: "system", content: system_prompt });
  }

  // Pre-seed with a directory tree injected into the user message.
  // Tree only (no file contents) keeps the context small; the agent reads specific
  // files via read_file tool calls. Injected into the user turn rather than system
  // to avoid servers that strip system messages (e.g. llama-swap with Gemma).
  let userContent = task;
  if (path) {
    const tree = await buildTree(path, 5);
    userContent = `Here is the directory structure of ${path}:\n\n.\n${tree}\n\n---\n\n${task}`;
  }

  messages.push({ role: "user", content: userContent });

  return runAgentLoop(agentConfig, messages, RUN_AGENT_TOOLS, max_iterations);
}
