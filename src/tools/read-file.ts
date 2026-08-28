import { readFile as fsReadFile } from "node:fs/promises";
import { extname } from "node:path";

/**
 * Default cap on returned lines. Without it an `offset`/`limit` read still returns
 * from the whole file, so a single call could swallow the caller's context.
 */
const MAX_LINES_DEFAULT = 2000;

export interface ReadFileParams {
  path: string;
  offset?: number; // 1-based start line
  limit?: number;  // number of lines to read
}

export const READ_FILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Absolute path to the file to read",
    },
    offset: {
      type: "number",
      description: "Line number to start reading from (1-based, default: 1)",
    },
    limit: {
      type: "number",
      description: `Number of lines to read (default: up to ${MAX_LINES_DEFAULT})`,
    },
  },
  required: ["path"],
};

/**
 * Prefix each line with its absolute 1-based line number, so the model can cite
 * `path:line` from what it read instead of counting lines itself. Numbering is
 * absolute — an `offset` read still reports the file's own line numbers.
 */
function numberLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i}\t${line}`).join("\n");
}

export async function readFile(params: ReadFileParams): Promise<string> {
  const { path, offset, limit } = params;

  let raw: string;
  try {
    raw = await fsReadFile(path, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const allLines = raw.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const requested = limit ?? MAX_LINES_DEFAULT;
  const end = Math.min(allLines.length, start + Math.max(0, requested));

  const slice = allLines.slice(start, end);
  const remaining = allLines.length - end;

  const lang = extname(path).slice(1);
  const body = numberLines(slice, start + 1);
  const footer = remaining > 0
    ? `\n_… ${remaining} more line${remaining === 1 ? "" : "s"} (read from line ${end + 1} to continue)_`
    : "";

  return `### ${path}\n\`\`\`${lang}\n${body}\n\`\`\`${footer}`;
}
