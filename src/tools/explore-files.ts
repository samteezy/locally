import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".cache", ".turbo", "coverage", ".nyc_output",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".bin", ".so", ".dylib", ".dll", ".o", ".a",
  ".lock", ".db", ".sqlite",
]);

let rgAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync("which", ["rg"]);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

function matchesPattern(filename: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (pattern.startsWith("*.")) return filename.endsWith(pattern.slice(1));
  return filename.includes(pattern);
}

async function buildTree(dirPath: string, maxDepth: number, depth = 0, prefix = ""): Promise<string> {
  if (depth >= maxDepth) return "";

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return "";
  }

  const visible = entries
    .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const lines: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const isLast = i === visible.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    lines.push(prefix + connector + entry.name + (entry.isDirectory() ? "/" : ""));

    if (entry.isDirectory()) {
      const subtree = await buildTree(
        join(dirPath, entry.name),
        maxDepth,
        depth + 1,
        prefix + childPrefix
      );
      if (subtree) lines.push(subtree);
    }
  }

  return lines.join("\n");
}

async function collectFiles(
  dirPath: string,
  rootPath: string,
  maxDepth: number,
  maxFileSizeKb: number,
  filePattern: string | undefined,
  depth = 0
): Promise<Array<{ path: string; content: string }>> {
  if (depth >= maxDepth) return [];

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: Array<{ path: string; content: string }> = [];

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const sub = await collectFiles(fullPath, rootPath, maxDepth, maxFileSizeKb, filePattern, depth + 1);
      results.push(...sub);
    } else if (entry.isFile()) {
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (!matchesPattern(entry.name, filePattern)) continue;

      try {
        const info = await stat(fullPath);
        if (info.size > maxFileSizeKb * 1024) continue;
        const content = await readFile(fullPath, "utf-8");
        results.push({ path: relative(rootPath, fullPath), content });
      } catch {
        // skip unreadable files
      }
    }
  }

  return results;
}

export interface ExploreFilesParams {
  path: string;
  query?: string;
  file_pattern?: string;
  max_depth?: number;
  max_file_size_kb?: number;
}

export async function exploreFiles(params: ExploreFilesParams): Promise<string> {
  const { path: dirPath, query, file_pattern, max_depth = 5, max_file_size_kb = 100 } = params;

  let dirStat;
  try {
    dirStat = await stat(dirPath);
  } catch {
    throw new Error(`Path not found: ${dirPath}`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  const sections: string[] = [];

  const tree = await buildTree(dirPath, max_depth);
  sections.push(`## Directory: ${dirPath}\n\n.\n${tree}`);

  if (query) {
    const useRg = await hasRipgrep();
    let searchOutput: string;

    if (useRg) {
      try {
        const args = ["--no-heading", "--line-number", "--color=never"];
        if (file_pattern) args.push("--glob", file_pattern);
        args.push(query, dirPath);
        const { stdout } = await execFileAsync("rg", args, { maxBuffer: 10 * 1024 * 1024 });
        searchOutput = stdout.trim() || "(no results)";
      } catch (err) {
        const e = err as { code?: number };
        if (e.code === 1) {
          searchOutput = "(no results)";
        } else {
          throw err;
        }
      }
      sections.push(`## Search (ripgrep): "${query}"\n\n${searchOutput}`);
    } else {
      try {
        const args = [
          "-rn", "--color=never",
          "--exclude-dir=node_modules", "--exclude-dir=.git",
          "--exclude-dir=dist", "--exclude-dir=build",
        ];
        if (file_pattern) args.push(`--include=${file_pattern}`);
        args.push(query, dirPath);
        const { stdout } = await execFileAsync("grep", args, { maxBuffer: 10 * 1024 * 1024 });
        searchOutput = stdout.trim() || "(no results)";
      } catch (err) {
        const e = err as { code?: number };
        if (e.code === 1) {
          searchOutput = "(no results)";
        } else {
          throw err;
        }
      }
      sections.push(`## Search (grep): "${query}"\n\n${searchOutput}`);
    }
  } else {
    const files = await collectFiles(dirPath, dirPath, max_depth, max_file_size_kb, file_pattern);

    if (files.length === 0) {
      sections.push("## Files\n\n(no files found matching criteria)");
    } else {
      const blocks = files.map((f) => {
        const lang = extname(f.path).slice(1);
        return `### ${f.path}\n\`\`\`${lang}\n${f.content}\n\`\`\``;
      });
      sections.push(`## Files (${files.length})\n\n${blocks.join("\n\n")}`);
    }
  }

  return sections.join("\n\n---\n\n");
}
