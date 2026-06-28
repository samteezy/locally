import { buildTree, exploreFiles, IGNORED_DIRS, type ExploreFilesParams } from "./explore-files.js";
import { runAgentLoop, type AgentTool, type AgentRunResult } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig } from "../config.js";
import type { Message } from "../llm/client.js";

export interface AgenticTaskParams {
  task: string;
  path?: string;
  system_prompt?: string;
  agent?: string;
  max_tokens?: number;
  max_iterations?: number;
  onProgress?: (message: string) => void;
  /**
   * Tool-supplied default system prompt (e.g. the Explore contract). Composed ahead of the
   * caller's `system_prompt` rather than replaced by it — both are included when present.
   */
  baseSystemPrompt?: string;
}

export async function runAgenticTask(
  config: LocallyConfig,
  params: AgenticTaskParams,
  toolKey: "explore" | "run",
  tools: AgentTool[]
): Promise<AgentRunResult> {
  const { task, path, system_prompt, agent, max_tokens, max_iterations, baseSystemPrompt, onProgress } = params;

  const agentConfig = resolveAgentConfig(config, resolveToolAgent(config, toolKey, agent));
  if (max_tokens !== undefined) {
    agentConfig.maxTokens = max_tokens;
  }

  const configIgnore = config.ignorePatterns ?? [];
  const ignoreDirs = configIgnore.length > 0 ? new Set([...IGNORED_DIRS, ...configIgnore]) : IGNORED_DIRS;

  const messages: Message[] = [];

  // Tool-supplied base prompt first (e.g. the Explore contract), then the caller's
  // optional system_prompt — both are kept, not one replacing the other.
  const systemContent = [baseSystemPrompt, system_prompt].filter(Boolean).join("\n\n");
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  // Pre-seed with a directory tree injected into the user message.
  // Tree only (no file contents) keeps the context small; the agent reads specific
  // files via read_file tool calls. Injected into the user turn rather than system
  // to avoid servers that strip system messages (e.g. llama-swap with Gemma).
  // Fall back to the process cwd so callers get a map even without an explicit path
  // (matches the native Explore agent, which needs no path).
  let userContent = task;
  const treeRoot = path ?? process.cwd();
  try {
    const tree = await buildTree(treeRoot, 5, ignoreDirs);
    userContent = `Here is the directory structure of ${treeRoot}:\n\n.\n${tree}\n\n---\n\n${task}`;
  } catch {
    // No usable tree (e.g. unreadable cwd) — fall back to the bare task.
  }

  messages.push({ role: "user", content: userContent });

  const resolvedTools: AgentTool[] = configIgnore.length > 0
    ? tools.map((t) =>
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
    : tools;

  return runAgentLoop(agentConfig, messages, resolvedTools, max_iterations, onProgress);
}
