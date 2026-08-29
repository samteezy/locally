import { Server } from "@modelcontextprotocol/server";
import { exploreTask } from "./tools/explore-task.js";
import { runTask } from "./tools/run-task.js";
import { withUsageFooter, formatUsageReport } from "./usage.js";
import { formatLocallyError } from "./llm/errors.js";
import type { LocallyConfig } from "./config.js";

const SERVER_INSTRUCTIONS = `locally is an assistant for your assistant. It runs small models on local or low-cost endpoints, so it costs little or nothing to use.

Send low-stakes, repetitive, or mechanical work here. This keeps the work off the frontier model.

Use explore_task for these jobs:
- Wide codebase searches: where a thing is, how something works, naming-convention sweeps.
- Inventory of a codebase: what exists, where it is, what a cited line says.

explore_task returns a conclusion with file:line citations, not file dumps. It reports what the code does and where it is. Keep code review, audits, severity ratings, and design judgment for yourself.

Use run_task for boilerplate, scaffolding, and routine edits.

Each result ends with a one-line footer. The footer names the model and counts the tokens that the local model generated. A small model wrote the output. Read it before you rely on it, and do the parts that need frontier-level judgment again yourself.

Use usage_report to get the total work sent to locally. For example, use it when the user asks how much work stayed off the frontier model.`;

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
        "Directory to map as a starting point. The model gets this tree at the start. The tree is not a boundary: the model can search and read anywhere in the configured allowedRoots. The default is the working directory.",
    },
    system_prompt: {
      type: "string",
      description: "Optional system prompt that gives the model more context",
    },
    agent: {
      type: "string",
      description:
        'Named agent from locally.config.json. If you do not set it, locally uses the tool default in config.tools, then the global default.',
    },
    max_tokens: {
      type: "number",
      description: "Maximum tokens for this call. This value replaces the configured maximum.",
    },
    max_iterations: {
      type: "number",
      description:
        "Maximum loop iterations before the model must give a final answer. The default is 10 for run_task. For explore_task the default is the breadth budget (medium: 8, very thorough: 20).",
    },
  },
  required: ["task"],
};

const EXPLORE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ...TASK_INPUT_SCHEMA.properties,
    task: {
      type: "string",
      description:
        "What to find, in natural language. For example: \"where is the agentic loop and what handles result caching?\" Ask for facts and locations. Do not ask for a review, a risk rating, or a recommendation.",
    },
    breadth: {
      type: "string",
      enum: ["medium", "very thorough"],
      description:
        "How widely to search. \"medium\" searches the most likely locations. \"very thorough\" sweeps many locations and naming conventions across the tree. The default is \"medium\".",
    },
  },
  required: ["task"],
};

/**
 * Server identity reported to the client. Protocol revision 2026-07-28 stamps this onto every
 * response's `_meta`, so server.test.ts asserts it against package.json rather than leaving it
 * to drift.
 */
const SERVER_VERSION = "0.6.1";

export function createServer(config: LocallyConfig): Server {
  const server = new Server(
    { name: "locally", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
      // Both results are static literals — they cannot change within a process — so a long TTL is
      // honest, and neither carries per-caller data, so a shared cache may hold them. Without
      // this, 2026-07-28 emits the conservative default (ttlMs: 0, private) and every reconnect
      // re-fetches. 2025-era responses never carry these fields.
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "explore_task",
        title: "Explore codebase (local model)",
        // Search and read only, and fenced to allowedRoots (src/tools/sandbox.ts) — so a host
        // can run it without a confirmation prompt.
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Read-only search across a codebase with a local model. It is the local-model equivalent of an Explore subagent.\n\n" +
          "It searches file contents with ripgrep and reads short excerpts. It returns a conclusion with file:line citations, not file dumps.\n\n" +
          "The server checks the answer before it comes back. It resolves each citation against the filesystem again. It checks that each file path and each asserted name exists. It names each file that the answer describes but never opened.\n\n" +
          "It is strongest at inventory work: list, enumerate, locate, \"where is X\", and naming-convention sweeps. It is weaker at open-ended \"explain how this is wired\" questions, so check those answers.\n\n" +
          "The path is a starting point, not a boundary. Set breadth to \"medium\" or \"very thorough\".\n\n" +
          "It reports what the code does and where it is. It is not for review, audits, ratings, or recommendations. Ask it where and what. Keep whether and why on the frontier model.",
        inputSchema: EXPLORE_INPUT_SCHEMA,
      },
      {
        name: "run_task",
        title: "Run task (local model)",
        // Writes files, patches them, and runs shell commands (RUN_AGENT_TOOLS) — still fenced
        // to allowedRoots, but destructive within that fence.
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Generate or edit content with a local model. Use it to keep low-stakes work off the frontier model.\n\n" +
          "It is good for commit messages, PR descriptions, changelog entries, boilerplate, scaffolding, and routine code edits.\n\n" +
          "The model works agentically. It gets a directory map when you give a path. Then it reads and writes files as necessary.\n\n" +
          "Use it to write, edit, and implement. It does the task that you give it and then stops. It does not explore further, and it does not add a review, a critique, or a redesign of the code. If you want one of these, ask for it in the task.\n\n" +
          "Put project-specific best practices in the task prompt. Read the output before you rely on it.",
        inputSchema: TASK_INPUT_SCHEMA,
      },
      {
        name: "usage_report",
        title: "Local usage report",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          "Report the work sent to locally since the server started. The report gives the number of tasks and the count of tokens generated locally. This tool takes no arguments. Use it when the user asks how much work stayed off the frontier model.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args = {} } = request.params;

    // A long sweep is otherwise silent, so the caller cannot tell a slow run from a
    // stuck one. When the client supplies a progressToken, relay each iteration and
    // tool call as an MCP progress notification.
    const progressToken = ctx.mcpReq._meta?.progressToken;
    let progressCount = 0;
    const onProgress = progressToken === undefined
      ? undefined
      : (message: string) => {
          // A dropped heartbeat must never take down the task it is reporting on, so
          // both a synchronous throw and a rejected send are swallowed.
          try {
            progressCount++;
            void ctx.mcpReq
              .notify({
                method: "notifications/progress",
                params: { progressToken, progress: progressCount, message },
              })
              .catch(() => {});
          } catch {
            // ignore
          }
        };

    // Cancellation from the caller — and, since v2, from the transport closing. A sweep can run
    // 20 iterations of up to 600s each, so without this a disconnected client leaves the local
    // model running to completion with nobody to hand the answer to.
    const signal = ctx.mcpReq.signal;

    try {
      switch (name) {
        case "explore_task": {
          const result = await exploreTask(config, {
            ...(args as unknown as Parameters<typeof exploreTask>[1]),
            onProgress,
            signal,
          });
          return { content: [{ type: "text", text: withUsageFooter(result) }] };
        }

        case "run_task": {
          const result = await runTask(config, {
            ...(args as unknown as Parameters<typeof runTask>[1]),
            onProgress,
            signal,
          });
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
        content: [{ type: "text", text: formatLocallyError(err) }],
        isError: true,
      };
    }
  });

  return server;
}
