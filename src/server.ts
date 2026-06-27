import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exploreTask } from "./tools/explore-task.js";
import { runTask } from "./tools/run-task.js";
import { withUsageFooter, formatUsageReport } from "./usage.js";
import type { LocallyConfig } from "./config.js";

const SERVER_INSTRUCTIONS = `locally is your assistant's assistant. It runs smaller models on local (or cheap) endpoints, so it costs little or nothing to use.

Before doing low-stakes, repetitive, or mechanical work yourself, delegate it here to keep it off the frontier model:
- Drafting commit messages, PR descriptions, and changelog entries
- Answering questions about a codebase or summarizing what exists (explore_task)
- Boilerplate, scaffolding, and routine edits (run_task)

Each result ends with a one-line footer showing the model used and how many tokens were generated locally. The output comes from a smaller model — skim it before relying on it, and re-do anything that needs frontier-level judgment yourself.

Call usage_report when you want the cumulative total of work offloaded to locally — e.g. when the user asks how much has been kept off the frontier model.`;

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
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
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
          "Generate or edit content with a local model to keep low-stakes work off the frontier model. Good for drafting commit messages, PR descriptions, and changelog entries, plus boilerplate, scaffolding, and routine code edits. The model runs agentically: it receives a directory map (when path is provided) then reads and writes files as needed. Use for writing, editing, and implementing — not open-ended exploration. Provide project-specific best practices in the task prompt, and review the output before relying on it.",
        inputSchema: TASK_INPUT_SCHEMA,
      },
      {
        name: "usage_report",
        description:
          "Report how much work has been offloaded to locally since the server started: number of tasks handled and tokens generated locally. Takes no arguments. Use when the user asks how much has been kept off the frontier model.",
        inputSchema: { type: "object" as const, properties: {} },
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
          return { content: [{ type: "text", text: withUsageFooter(result) }] };
        }

        case "run_task": {
          const result = await runTask(
            config,
            args as unknown as Parameters<typeof runTask>[1]
          );
          return { content: [{ type: "text", text: withUsageFooter(result) }] };
        }

        case "usage_report": {
          return { content: [{ type: "text", text: formatUsageReport() }] };
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
