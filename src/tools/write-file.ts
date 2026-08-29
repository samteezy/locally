import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteFileParams {
  path: string;
  content: string;
}

export const WRITE_FILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Absolute path of the file to write.",
    },
    content: {
      type: "string",
      description: "Full content to write to the file.",
    },
  },
  required: ["path", "content"],
};

export async function writeFile(params: WriteFileParams): Promise<string> {
  const { path, content } = params;
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, content, "utf-8");
  return `Wrote ${content.length} characters to ${path}`;
}
