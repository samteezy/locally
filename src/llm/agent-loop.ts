import { runCompletionWithTools, type Message, type ToolDefinition } from "./client.js";
import { exploreFiles, EXPLORE_FILES_SCHEMA } from "../tools/explore-files.js";
import { readFile, READ_FILE_SCHEMA } from "../tools/read-file.js";
import { writeFile, WRITE_FILE_SCHEMA } from "../tools/write-file.js";
import { patchFile, PATCH_FILE_SCHEMA } from "../tools/patch-file.js";
import { runShell, RUN_SHELL_SCHEMA } from "../tools/run-shell.js";
import type { ResolvedAgentConfig } from "../config.js";

export interface AgentTool {
  definition: ToolDefinition;
  handler: (args: unknown) => Promise<string>;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "explore_files",
        description:
          "Walk a directory and return an LLM-friendly view of its contents. Searches with ripgrep when available, falls back to grep. Use this to understand directory structure or search for content across files.",
        parameters: EXPLORE_FILES_SCHEMA,
      },
    },
    handler: (args) => exploreFiles(args as Parameters<typeof exploreFiles>[0]),
  },
  {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the contents of a specific file by absolute path. Optionally read a range of lines with offset and limit.",
        parameters: READ_FILE_SCHEMA,
      },
    },
    handler: (args) => readFile(args as Parameters<typeof readFile>[0]),
  },
];

export const RUN_AGENT_TOOLS: AgentTool[] = [
  ...AGENT_TOOLS,
  {
    definition: {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write content to a file at the given absolute path, creating parent directories as needed. Use this to create or overwrite files.",
        parameters: WRITE_FILE_SCHEMA,
      },
    },
    handler: (args) => writeFile(args as Parameters<typeof writeFile>[0]),
  },
  {
    definition: {
      type: "function",
      function: {
        name: "patch_file",
        description:
          "Replace an exact string in a file. Prefer this over write_file for targeted edits — safer than rewriting the whole file.",
        parameters: PATCH_FILE_SCHEMA,
      },
    },
    handler: (args) => patchFile(args as Parameters<typeof patchFile>[0]),
  },
  {
    definition: {
      type: "function",
      function: {
        name: "run_shell",
        description:
          "Run a nondestructive shell command from the allowlist. Use to check compilation errors, run tests, inspect git state, or verify output.",
        parameters: RUN_SHELL_SCHEMA,
      },
    },
    handler: (args) => runShell(args as Parameters<typeof runShell>[0]),
  },
];

const MAX_ITERATIONS_DEFAULT = 10;

export async function runAgentLoop(
  config: ResolvedAgentConfig,
  messages: Message[],
  tools: AgentTool[],
  maxIterations: number = MAX_ITERATIONS_DEFAULT,
  onProgress?: (message: string) => void
): Promise<string> {
  const toolDefs: ToolDefinition[] = tools.map((t) => t.definition);
  const toolMap = new Map<string, AgentTool["handler"]>(
    tools.map((t) => [t.definition.function.name, t.handler])
  );

  // Cache keyed by "toolName:argsJson" — return cached results on duplicate calls
  const toolResultCache = new Map<string, string>();

  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    onProgress?.(`[iteration ${iterations}/${maxIterations}]`);

    const turn = await runCompletionWithTools(config, messages, toolDefs);

    // Push the full assistant turn (including tool_calls) before processing results.
    // The API requires the assistant message with tool_calls to precede role:"tool" messages.
    messages.push({
      role: "assistant",
      content: turn.content,
      ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}),
    });

    if (!turn.tool_calls || turn.tool_calls.length === 0) {
      if (typeof turn.content !== "string") {
        throw new Error("Model returned neither tool calls nor text content.");
      }
      return turn.content;
    }

    for (const toolCall of turn.tool_calls) {
      const { name, arguments: argsJson } = toolCall.function;
      const cacheKey = `${name}:${argsJson}`;
      let result: string;

      if (toolResultCache.has(cacheKey)) {
        result = `(already retrieved — returning cached result)\n${toolResultCache.get(cacheKey)!}`;
      } else {
        try {
          onProgress?.(`[tool: ${name}] ${argsJson}`);
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(argsJson);
          } catch {
            throw new Error(`Invalid JSON in tool arguments: ${argsJson}`);
          }

          const handler = toolMap.get(name);
          if (!handler) {
            result = `Error: unknown tool "${name}"`;
          } else {
            result = await handler(parsedArgs);
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        toolResultCache.set(cacheKey, result);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Max iterations reached — call without tools to force a final text answer
  const finalTurn = await runCompletionWithTools(config, messages);
  if (typeof finalTurn.content !== "string") {
    throw new Error(`Agent exceeded ${maxIterations} iterations and the model returned no content.`);
  }
  return finalTurn.content;
}
