import { buildTree, IGNORED_DIRS } from "./explore-files.js";
import { runAgentLoop, type AgentTool, type AgentRunResult, type DraftAnswerHook } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig, type ResolvedAgentConfig } from "../config.js";
import { assertWithinRoots, effectiveRoots } from "./sandbox.js";
import type { Message } from "../llm/client.js";
import { isAbsolute, join } from "node:path";

/** Result lines scanned for a matched path; a wider search adds nothing but stat calls. */
const MAX_SCANNED_HITS = 400;

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
  /**
   * Minimum work a run must have done before its answer is accepted. When it has not, the loop is
   * asked once to keep sweeping (see `sweepNudge`). Only set for a breadth that promised coverage —
   * a "very thorough" sweep that reads five files has not swept (issue #16).
   */
  sweepFloor?: { minIterations: number; minFilesRead: number };
  /** The message pushed back when the floor is not met. Given what the run has done so far. */
  sweepNudge?: (state: { iterations: number; filesRead: number }) => string;
  /**
   * Already-resolved agent config. A tool that has to know the agent's settings before building the
   * run — explore_task needs `maxIterations` to size its sweep floor — resolves once and passes the
   * result in, rather than resolving the same config twice.
   */
  resolvedAgent?: ResolvedAgentConfig;
}

export async function runAgenticTask(
  config: LocallyConfig,
  params: AgenticTaskParams,
  toolKey: "explore" | "run",
  tools: AgentTool[]
): Promise<AgentRunResult> {
  const { task, path, system_prompt, agent, max_tokens, max_iterations, baseSystemPrompt } = params;
  const { sweepFloor, sweepNudge, onProgress, signal } = params;

  const agentConfig = params.resolvedAgent ?? resolveAgentConfig(config, resolveToolAgent(config, toolKey, agent));
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

  // Files the model saw *inside* — matched lines in an explore_files search. Tracked alongside the
  // files it opened because the coverage note has to answer "did this run have any evidence about
  // this file", and the contract explicitly allows a claim backed by a search hit. Counting only
  // read_file would flag the tool's own recommended workflow as unevidenced, which is the class of
  // false alarm issue #16 is about.
  const filesMatched = new Set<string>();
  const canonical = new Map<string, string | null>();
  const canonicalise = (raw: string): string | null => {
    let hit = canonical.get(raw);
    if (hit === undefined) {
      try {
        hit = assertWithinRoots(raw, roots, { mustExist: true });
      } catch {
        hit = null;
      }
      canonical.set(raw, hit);
    }
    return hit;
  };

  /** `path:line:text` rows, the shape ripgrep and grep both emit. Bounded so one wide search
   *  cannot turn into thousands of stat calls. */
  const recordSearchHits = (output: string): void => {
    for (const line of output.split("\n").slice(0, MAX_SCANNED_HITS)) {
      const match = /^(.+?):\d+:/.exec(line);
      if (!match) continue;
      const path = canonicalise(match[1]);
      if (path) filesMatched.add(path);
    }
  };

  // Files named by a directory listing. Weaker evidence than the two above — the model saw the
  // name, not the contents — but it is exactly the evidence an inventory answer rests on, and one
  // of issue #16's two runs was a correct listing of three directories. Flagging those files as
  // undescribed would be the same class of false alarm the issue is about.
  const filesListed = new Set<string>();
  const LISTING_ROW_RE = /^(.+?) · (?:\d+ lines|—) · /;
  const recordListedFiles = (output: string, dir: string): void => {
    for (const line of output.split("\n").slice(0, MAX_SCANNED_HITS)) {
      const match = LISTING_ROW_RE.exec(line);
      if (!match) continue;
      const path = canonicalise(isAbsolute(match[1]) ? match[1] : join(dir, match[1]));
      if (path) filesListed.add(path);
    }
  };

  const messages: Message[] = [];

  // Tool-supplied base prompt first (e.g. the Explore contract), then the caller's
  // optional system_prompt — both are kept, not one replacing the other. An agent configured with
  // its own systemPrompt replaces the tool's contract rather than stacking on it: a model trained
  // against a fixed harness wants that harness, not ours plus that harness.
  const systemContent = [agentConfig.systemPrompt ?? baseSystemPrompt, system_prompt]
    .filter(Boolean)
    .join("\n\n");
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

  // Every tool is wrapped the same way, driven by the fence it declares (see ToolFence): its path
  // argument is validated against the allowed roots before it runs, and what the call proves about
  // the files it touched is recorded for the coverage note. This used to be a switch over tool
  // names whose default branch returned the tool unwrapped, so renaming a tool would have quietly
  // taken it out of the sandbox. Thrown LocallyErrors are caught by the agent loop and fed back to
  // the model as a tool result, so it self-corrects to a valid path rather than aborting the run.
  const fallbackRoot = path ?? roots[0];

  const resolvedTools: AgentTool[] = tools.map((tool) => {
    const { fence } = tool;
    return {
      ...tool,
      handler: async (args: unknown) => {
        const call = { ...(args as Record<string, unknown>) };
        const given = call[fence.pathKey];
        const requested =
          typeof given === "string" && given.length > 0
            ? given
            : fence.defaultsToTaskRoot
              ? fallbackRoot
              : undefined;

        if (requested === undefined) {
          throw new Error(`"${fence.pathKey}" is required and must be an absolute path.`);
        }

        const canonical = assertWithinRoots(requested, roots, { mustExist: fence.mustExist });
        call[fence.pathKey] = canonical;

        if (fence.mergesIgnorePatterns && configIgnore.length > 0) {
          call.ignore_patterns = [...configIgnore, ...((call.ignore_patterns as string[] | undefined) ?? [])];
        }

        const output = await tool.handler(call);

        switch (fence.evidence) {
          case "read":
            // The canonical path, so the same file reached by two spellings counts once.
            filesRead.add(canonical);
            break;
          case "searchHits":
            recordSearchHits(output);
            break;
          case "listing":
            recordListedFiles(output, canonical);
            break;
        }

        return output;
      },
    };
  });

  // The sweep floor lives here rather than in the loop because it is measured in files read, and
  // this is the layer that knows which tools take a path. Fires at most once per run: a second
  // refusal to accept an answer stops being a nudge and starts being padding.
  let nudged = false;
  const onDraftAnswer: DraftAnswerHook | undefined =
    sweepFloor && sweepNudge
      ? ({ iterations }) => {
          if (nudged) return null;
          if (iterations >= sweepFloor.minIterations && filesRead.size >= sweepFloor.minFilesRead) {
            return null;
          }
          nudged = true;
          return sweepNudge({ iterations, filesRead: filesRead.size });
        }
      : undefined;

  const result = await runAgentLoop(
    agentConfig,
    messages,
    resolvedTools,
    max_iterations ?? agentConfig.maxIterations,
    onProgress,
    signal,
    onDraftAnswer
  );
  return {
    ...result,
    filesRead: filesRead.size,
    filesReadPaths: [...filesRead],
    filesMatchedPaths: [...filesMatched],
    filesListedPaths: [...filesListed],
    nudged,
  };
}
