import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exploreFiles } from "./tools/explore-files.js";
import { runTask } from "./tools/run-task.js";
import type { LocallyConfig } from "./config.js";

export function createServer(config: LocallyConfig): Server {
  const server = new Server(
    { name: "locally", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "explore_files",
        description:
          "Walk a directory and return an LLM-friendly view of its contents. Searches with ripgrep when available, falls back to grep. Works for codebases, document folders, config directories, or any file tree.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to the directory to explore",
            },
            query: {
              type: "string",
              description:
                "Search for content using ripgrep (or grep). When provided, returns matching lines instead of full file contents.",
            },
            file_pattern: {
              type: "string",
              description: 'Filter files by pattern, e.g. "*.ts" or "*.md"',
            },
            max_depth: {
              type: "number",
              description: "Max directory depth to traverse (default: 5)",
            },
            max_file_size_kb: {
              type: "number",
              description: "Skip files larger than this many KB (default: 100)",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "run_task",
        description:
          "Delegate a task to a model via an OpenAI-compatible endpoint. Intended for small, self-contained tasks suited to local or lightweight models. Supports named agents with per-agent endpoint/model/key overrides.",
        inputSchema: {
          type: "object" as const,
          properties: {
            task: {
              type: "string",
              description: "The prompt or task to send to the model",
            },
            system_prompt: {
              type: "string",
              description: "Optional system prompt to set context",
            },
            agent: {
              type: "string",
              description:
                'Named agent from locally.config.json to use. Uses the "default" config when omitted.',
            },
            max_tokens: {
              type: "number",
              description: "Override max tokens for this call",
            },
          },
          required: ["task"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "explore_files": {
          const result = await exploreFiles(
            args as unknown as Parameters<typeof exploreFiles>[0]
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
