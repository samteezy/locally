import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exploreTask } from "./tools/explore-task.js";
import { runTask } from "./tools/run-task.js";
import type { LocallyConfig } from "./config.js";

const TASK_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    task: {
      type: "string",
      description: "The prompt or task to send to the model",
    },
    path: {
      type: "string",
      description:
        "Root directory to pre-map before the agent starts. When provided, the model receives a directory tree as context and can explore deeper via tool calls.",
    },
    system_prompt: {
      type: "string",
      description: "Optional system prompt to set context",
    },
    agent: {
      type: "string",
      description:
        'Named agent from locally.config.json to use. Falls back to the tool-specific default in config.tools, then the global default.',
    },
    max_tokens: {
      type: "number",
      description: "Override max tokens for this call",
    },
    max_iterations: {
      type: "number",
      description: "Maximum agentic loop iterations before forcing a final answer (default: 10)",
    },
  },
  required: ["task"],
};

export function createServer(config: LocallyConfig): Server {
  const server = new Server(
    { name: "locally", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "explore_task",
        description:
          "Explore a codebase or file tree to answer questions, understand structure, trace logic, or summarize what exists. The model runs agentically: it receives a directory map (when path is provided) then reads files as needed before answering. Use this for analysis, Q&A, and understanding — not for generating new code.",
        inputSchema: TASK_INPUT_SCHEMA,
      },
      {
        name: "run_task",
        description:
          "Generate code, draft content, or implement changes using a local model. The model runs agentically: it receives a directory map (when path is provided) then reads and writes files as needed. Use this for writing, editing, and implementing — not for open-ended exploration. Provide project-specific best practices in the task prompt.",
        inputSchema: TASK_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "explore_task": {
          const result = await exploreTask(
            config,
            args as unknown as Parameters<typeof exploreTask>[1]
          );
          return { content: [{ type: "text", text: result }] };
        }

        case "run_task": {
          const result = await runTask(
            config,
            args as unknown as Parameters<typeof runTask>[1]
          );
          return { content: [{ type: "text", text: result }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: err instanceof Error ? err.message : String(err) },
        ],
        isError: true,
      };
    }
  });

  return server;
}
