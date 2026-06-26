import { readFile as fsReadFile } from "node:fs/promises";
import { extname } from "node:path";

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
      description: "Number of lines to read (default: all)",
    },
  },
  required: ["path"],
};

export async function readFile(params: ReadFileParams): Promise<string> {
  const { path, offset, limit } = params;

  let content: string;
  try {
    content = await fsReadFile(path, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (offset !== undefined || limit !== undefined) {
    const lines = content.split("\n");
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit !== undefined ? start + limit : lines.length;
    content = lines.slice(start, end).join("\n");
  }

  const lang = extname(path).slice(1);
  return `### ${path}\n\`\`\`${lang}\n${content}\n\`\`\``;
}
