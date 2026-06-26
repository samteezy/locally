import { readFile, writeFile } from "node:fs/promises";

export interface PatchFileParams {
  path: string;
  old_str: string;
  new_str: string;
}

export const PATCH_FILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to patch",
    },
    old_str: {
      type: "string",
      description: "Exact string to find and replace",
    },
    new_str: {
      type: "string",
      description: "Replacement string",
    },
  },
  required: ["path", "old_str", "new_str"],
};

export async function patchFile(params: PatchFileParams): Promise<string> {
  const { path: filePath, old_str, new_str } = params;

  const content = await readFile(filePath, "utf-8");
  const index = content.indexOf(old_str);

  if (index === -1) {
    throw new Error(`String not found in file ${filePath}: ${old_str}`);
  }

  const newContent = content.slice(0, index) + new_str + content.slice(index + old_str.length);

  await writeFile(filePath, newContent, "utf-8");

  return `Successfully replaced text in ${filePath}`;
}
