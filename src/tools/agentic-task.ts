import { buildTree, exploreFiles, IGNORED_DIRS, type ExploreFilesParams } from "./explore-files.js";
import { runAgentLoop, type AgentTool, type AgentRunResult } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig } from "../config.js";
import { assertWithinRoots, effectiveRoots } from "./sandbox.js";
import type { ReadFileParams } from "./read-file.js";
import type { WriteFileParams } from "./write-file.js";
import type { PatchFileParams } from "./patch-file.js";
import type { RunShellParams } from "./run-shell.js";
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
   * Cancellation from the MCP caller (`ctx.mcpReq.signal`). Aborts the in-flight endpoint
   * request and stops the loop between iterations, so a cancelled or disconnected client no
   * longer leaves the local model running.
   */
  signal?: AbortSignal;
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
  const { task, path, system_prompt, agent, max_tokens, max_iterations, baseSystemPrompt, onProgress, signal } =
    params;

  const agentConfig = resolveAgentConfig(config, resolveToolAgent(config, toolKey, agent));
  if (max_tokens !== undefined) {
    agentConfig.maxTokens = max_tokens;
  }

  const configIgnore = config.ignorePatterns ?? [];
  const ignoreDirs = configIgnore.length > 0 ? new Set([...IGNORED_DIRS, ...configIgnore]) : IGNORED_DIRS;

  // Confine every file/shell tool to the allowed roots (default: the launch directory). The
  // per-task `path` is only a tree-map hint, not the boundary — using it would block legitimate
  // cross-directory work within the same project.
  const roots = effectiveRoots(config);

  // How many distinct files the model actually opened — reported in the result footer, so a
  // caller can tell a run that read widely from one that answered off the directory map alone
  // (issue #13). Collected here rather than in the loop, which dispatches tools by name and has
  // no business knowing which of them take a path.
  const filesRead = new Set<string>();

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
  //
  // The map is explicitly labelled a starting point and the real fence is named, because
  // an unqualified tree reads as the edge of the world: the model stops at it and infers
  // rather than searching outward (issue #10).
  let userContent = task;
  const treeRoot = path ?? process.cwd();
  try {
    const tree = await buildTree(treeRoot, 5, ignoreDirs);
    userContent = [
      `Starting point — the directory structure of ${treeRoot}:`,
      "",
      ".",
      tree,
      "",
      `This map is where to start looking, not a boundary. You can search and read anywhere under: ${roots.join(", ")}.`,
      "If the answer lives outside the map above, search for it there rather than inferring it.",
      "",
      "---",
      "",
      task,
    ].join("\n");
  } catch {
    // No usable tree (e.g. unreadable cwd) — fall back to the bare task.
  }

  messages.push({ role: "user", content: userContent });

  // Wrap each path-bearing tool so its path/cwd is validated against the roots before it runs.
  // Thrown LocallyErrors are caught by the agent loop and fed back to the model as a tool result,
  // so the model self-corrects to a valid path rather than aborting the run.
  const resolvedTools: AgentTool[] = tools.map((t) => {
    switch (t.definition.function.name) {
      case "read_file":
        return {
          ...t,
          handler: (args: unknown) => {
            // The canonical path, so the same file reached by two spellings counts once.
            const canonical = assertWithinRoots((args as ReadFileParams).path, roots, { mustExist: true });
            filesRead.add(canonical);
            return t.handler(args);
          },
        };
      case "explore_files":
        return {
          ...t,
          handler: (args: unknown) => {
            const p = args as ExploreFilesParams;
            assertWithinRoots(p.path, roots, { mustExist: true });
            const merged = configIgnore.length > 0
              ? { ...p, ignore_patterns: [...configIgnore, ...(p.ignore_patterns ?? [])] }
              : p;
            return exploreFiles(merged);
          },
        };
      case "write_file":
        return {
          ...t,
          handler: (args: unknown) => {
            assertWithinRoots((args as WriteFileParams).path, roots);
            return t.handler(args);
          },
        };
      case "patch_file":
        return {
          ...t,
          handler: (args: unknown) => {
            assertWithinRoots((args as PatchFileParams).path, roots);
            return t.handler(args);
          },
        };
      case "run_shell":
        return {
          ...t,
          handler: (args: unknown) => {
            const p = args as RunShellParams;
            const canonicalCwd = assertWithinRoots(p.cwd ?? process.cwd(), roots, { mustExist: true });
            return t.handler({ ...p, cwd: canonicalCwd });
          },
        };
      default:
        return t;
    }
  });

  const result = await runAgentLoop(agentConfig, messages, resolvedTools, max_iterations, onProgress, signal);
  return { ...result, filesRead: filesRead.size };
}
