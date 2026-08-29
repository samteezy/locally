import { Server } from "@modelcontextprotocol/server";
import { exploreTask } from "./tools/explore-task.js";
import { runTask } from "./tools/run-task.js";
import { withUsageFooter, formatUsageReport } from "./usage.js";
import { formatLocallyError } from "./llm/errors.js";
import type { LocallyConfig } from "./config.js";

const SERVER_INSTRUCTIONS = `locally is your assistant's assistant. It runs smaller models on local (or cheap) endpoints, so it costs little or nothing to use.

Before doing low-stakes, repetitive, or mechanical work yourself, delegate it here to keep it off the frontier model:
- Broad fan-out codebase searches — "where is X", how something works, naming-convention sweeps — the situations you'd otherwise spawn an Explore subagent for (explore_task). It returns a conclusion with file:line citations, not file dumps.
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
        "Directory to pre-map as a starting point. The model gets this tree up front, but it is not a boundary — the model can search and read anywhere within the configured allowedRoots. Defaults to the working directory.",
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
      description:
        "Maximum agentic loop iterations before forcing a final answer. Defaults to 10 for run_task, and to the breadth budget for explore_task (medium: 8, very thorough: 20).",
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
        "What to find or understand, in natural language (e.g. \"where is the agentic loop and how does result caching work?\").",
    },
    breadth: {
      type: "string",
      enum: ["medium", "very thorough"],
      description:
        "How widely to search. \"medium\" checks the most likely locations; \"very thorough\" sweeps multiple locations and naming conventions across the tree. Defaults to \"medium\".",
    },
  },
  required: ["task"],
};

/**
 * Server identity reported to the client. Protocol revision 2026-07-28 stamps this onto every
 * response's `_meta`, so server.test.ts asserts it against package.json rather than leaving it
 * to drift.
 */
const SERVER_VERSION = "0.5.0";

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
          "Read-only fan-out search over a codebase — the local-model equivalent of an Explore subagent. It greps with ripgrep and reads targeted excerpts, returning a conclusion with file:line citations rather than file dumps. Before the answer comes back the server checks it: citations are re-resolved against the filesystem, file paths and asserted names are existence-checked, and any file the answer describes without ever having opened is named. Strongest at inventory work — list, enumerate, locate, \"where is X\", naming-convention sweeps. Weaker at open-ended \"explain how this is wired\" architecture questions, so verify those. The path is a starting point, not a boundary. Set breadth (\"medium\" / \"very thorough\"). Use for analysis, Q&A, and understanding — not for generating code.",
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
          "Generate or edit content with a local model to keep low-stakes work off the frontier model. Good for drafting commit messages, PR descriptions, and changelog entries, plus boilerplate, scaffolding, and routine code edits. The model runs agentically: it receives a directory map (when path is provided) then reads and writes files as needed. Use for writing, editing, and implementing — not open-ended exploration. Provide project-specific best practices in the task prompt, and review the output before relying on it.",
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
          "Report how much work has been offloaded to locally since the server started: number of tasks handled and tokens generated locally. Takes no arguments. Use when the user asks how much has been kept off the frontier model.",
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
