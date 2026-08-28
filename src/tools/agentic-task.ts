import { buildTree, exploreFiles, IGNORED_DIRS, type ExploreFilesParams } from "./explore-files.js";
import { runAgentLoop, type AgentTool, type AgentRunResult, type DraftAnswerHook } from "../llm/agent-loop.js";
import { resolveAgentConfig, resolveToolAgent, type LocallyConfig } from "../config.js";
import { assertWithinRoots, effectiveRoots } from "./sandbox.js";
import type { ReadFileParams } from "./read-file.js";
import type { WriteFileParams } from "./write-file.js";
import type { PatchFileParams } from "./patch-file.js";
import type { RunShellParams } from "./run-shell.js";
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
}

export async function runAgenticTask(
  config: LocallyConfig,
  params: AgenticTaskParams,
  toolKey: "explore" | "run",
  tools: AgentTool[]
): Promise<AgentRunResult> {
  const { task, path, system_prompt, agent, max_tokens, max_iterations, baseSystemPrompt } = params;
  const { sweepFloor, sweepNudge, onProgress, signal } = params;

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
          handler: async (args: unknown) => {
            const p = args as ExploreFilesParams;
            assertWithinRoots(p.path, roots, { mustExist: true });
            const merged = configIgnore.length > 0
              ? { ...p, ignore_patterns: [...configIgnore, ...(p.ignore_patterns ?? [])] }
              : p;
            const output = await exploreFiles(merged);
            if (p.query) recordSearchHits(output);
            else recordListedFiles(output, p.path);
            return output;
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
    max_iterations,
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
