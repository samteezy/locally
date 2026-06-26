import { buildTree, exploreFiles, IGNORED_DIRS, type ExploreFilesParams } from "./explore-files.js";
import { runAgentLoop, AGENT_TOOLS, type AgentTool } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig } from "../config.js";
import type { Message } from "../llm/client.js";

export interface ExploreTaskParams {
  task: string;
  path?: string;
  system_prompt?: string;
  agent?: string;
  max_tokens?: number;
  max_iterations?: number;
  onProgress?: (message: string) => void;
}

export async function exploreTask(config: LocallyConfig, params: ExploreTaskParams): Promise<string> {
  const { task, path, system_prompt, agent, max_tokens, max_iterations, onProgress } = params;

  const agentConfig = resolveAgentConfig(config, resolveToolAgent(config, "explore", agent));
  if (max_tokens !== undefined) {
    agentConfig.maxTokens = max_tokens;
  }

  const configIgnore = config.ignorePatterns ?? [];
  const ignoreDirs = configIgnore.length > 0 ? new Set([...IGNORED_DIRS, ...configIgnore]) : IGNORED_DIRS;

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
    const tree = await buildTree(path, 5, ignoreDirs);
    userContent = `Here is the directory structure of ${path}:\n\n.\n${tree}\n\n---\n\n${task}`;
  }

  messages.push({ role: "user", content: userContent });

  const tools: AgentTool[] = configIgnore.length > 0
    ? AGENT_TOOLS.map((t) =>
        t.definition.function.name === "explore_files"
          ? {
              ...t,
              handler: (args: unknown) => {
                const p = args as ExploreFilesParams;
                return exploreFiles({ ...p, ignore_patterns: [...configIgnore, ...(p.ignore_patterns ?? [])] });
              },
            }
          : t
      )
    : AGENT_TOOLS;

  return runAgentLoop(agentConfig, messages, tools, max_iterations, onProgress);
}
