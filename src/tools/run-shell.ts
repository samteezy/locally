import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "blame", "branch", "tag"]);
const NPM_ALLOWED = new Set(["test", "run"]);

const ALLOWED_COMMANDS = new Set([
  "cat", "head", "tail", "wc", "diff",
  "ls", "find", "stat",
  "grep", "rg",
  "echo",
  "pwd",
  "git",
  "npm",
  "tsc",
  "eslint",
  "prettier",
]);

export interface RunShellParams {
  command: string;
  args: string[];
  cwd?: string;
}

export const RUN_SHELL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: `Executable to run. Must be one of: ${[...ALLOWED_COMMANDS].join(", ")}`,
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments to pass to the command",
    },
    cwd: {
      type: "string",
      description: "Working directory (defaults to process cwd)",
    },
  },
  required: ["command", "args"],
};

export async function runShell(params: RunShellParams): Promise<string> {
  const { command, args, cwd } = params;

  if (!ALLOWED_COMMANDS.has(command)) {
    return `Error: "${command}" is not allowed. Permitted commands: ${[...ALLOWED_COMMANDS].join(", ")}`;
  }

  if (command === "git") {
    const sub = args[0] ?? "";
    if (!GIT_ALLOWED.has(sub)) {
      return `Error: git subcommand "${sub}" is not allowed. Permitted: ${[...GIT_ALLOWED].join(", ")}`;
    }
  }

  if (command === "npm") {
    const sub = args[0] ?? "";
    if (!NPM_ALLOWED.has(sub)) {
      return `Error: npm subcommand "${sub}" is not allowed. Permitted: ${[...NPM_ALLOWED].join(", ")}`;
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_CHARS * 4,
    });

    const parts: string[] = [];
    if (stdout) parts.push(`stdout:\n${stdout}`);
    if (stderr) parts.push(`stderr:\n${stderr}`);
    return (parts.join("\n").slice(0, MAX_OUTPUT_CHARS) || "(no output)");
  } catch (err: unknown) {
    if (err !== null && typeof err === "object" && ("stdout" in err || "stderr" in err)) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      const parts: string[] = [];
      if (e.stdout) parts.push(`stdout:\n${e.stdout}`);
      if (e.stderr) parts.push(`stderr:\n${e.stderr}`);
      return `Exit code ${e.code ?? 1}:\n${parts.join("\n").slice(0, MAX_OUTPUT_CHARS) || "(no output)"}`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
