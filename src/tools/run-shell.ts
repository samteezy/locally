import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "blame", "branch", "tag"]);
const NPM_ALLOWED = new Set(["test", "run"]);

// Reading and searching go through the dedicated read_file / explore_files tools, which are
// confined to the allowed roots. The shell allowlist therefore omits file-reading commands
// (cat/head/tail/stat) and search/exec primitives (find/grep/rg/echo) — find -exec in particular
// is arbitrary code execution. What remains is a build/test/inspect surface; the commands that can
// run code (git, npm) only ever run with a cwd validated against the allowed roots.
const ALLOWED_COMMANDS = new Set([
  "ls", "pwd", "wc", "diff",
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
      description: `Program to run. It must be one of these: ${[...ALLOWED_COMMANDS].join(", ")}.`,
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments for the command.",
    },
    cwd: {
      type: "string",
      description: "Working directory. The default is the working directory of the process.",
    },
  },
  required: ["command", "args"],
};

export async function runShell(params: RunShellParams): Promise<string> {
  const { command, args, cwd } = params;

  if (!ALLOWED_COMMANDS.has(command)) {
    return `Error: the command "${command}" is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].join(", ")}.`;
  }

  if (command === "git") {
    const sub = args[0] ?? "";
    if (!GIT_ALLOWED.has(sub)) {
      return `Error: the git subcommand "${sub}" is not allowed. Allowed subcommands: ${[...GIT_ALLOWED].join(", ")}.`;
    }
  }

  if (command === "npm") {
    const sub = args[0] ?? "";
    if (!NPM_ALLOWED.has(sub)) {
      return `Error: the npm subcommand "${sub}" is not allowed. Allowed subcommands: ${[...NPM_ALLOWED].join(", ")}.`;
    }
  }

  // git reads the repository's own .git/config, which can configure programs that run on
  // otherwise read-only subcommands (core.fsmonitor, the pager). cwd is already confined to the
  // allowed roots, but neutralize those vectors as defense in depth: skip system config and
  // override the dangerous keys regardless of what a repo's config sets.
  let runArgs = args;
  let env = process.env;
  if (command === "git") {
    runArgs = ["-c", "core.fsmonitor=", "-c", "core.pager=cat", ...args];
    env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_PAGER: "cat" };
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, runArgs, {
      cwd,
      env,
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
