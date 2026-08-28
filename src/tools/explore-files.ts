import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, isAbsolute, basename } from "node:path";

const execFileAsync = promisify(execFile);

export const IGNORED_DIRS = new Set([
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

/** Listing entries are one line each, so this can be far higher than the content cap. */
const MAX_FILES_DEFAULT = 200;
/** Whole-file dumps are expensive; keep the opt-in path narrow. */
const MAX_CONTENT_FILES_DEFAULT = 50;
const MAX_RESULTS_DEFAULT = 200;
const MAX_CONTEXT_LINES = 5;

let rgAvailable: boolean | null = null;

export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync("which", ["rg"]);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Reset the memoized ripgrep probe. Exposed for tests. */
export function resetRipgrepCache(): void {
  rgAvailable = null;
}

function matchesPattern(filename: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (pattern.startsWith("*.")) return filename.endsWith(pattern.slice(1));
  return filename.includes(pattern);
}

function sortEntries(a: { isDirectory(): boolean; name: string }, b: { isDirectory(): boolean; name: string }): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function handleSearchError(err: unknown): string {
  const e = err as { message?: string; code?: number };
  if (e.code === 1) return "(no results)";
  if (e.message?.includes("maxBuffer") || e.message?.includes("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
    return "(search results exceeded 10MB limit — try a more specific query)";
  }
  throw err;
}

/**
 * A bare name ("tmp") means a directory anywhere in the tree; anything containing
 * a glob metacharacter or a slash is already a path pattern and passes through.
 */
function toIgnoreGlob(pattern: string): string {
  if (pattern.includes("*") || pattern.includes("/")) return `!${pattern}`;
  return `!**/${pattern}/**`;
}

export function rgIgnoreArgs(ignore: Iterable<string>): string[] {
  const args: string[] = [];
  for (const p of ignore) {
    args.push("--glob", toIgnoreGlob(p));
  }
  return args;
}

export function grepIgnoreArgs(ignore: Iterable<string>): string[] {
  const args: string[] = [];
  for (const p of ignore) {
    // grep has no path-glob exclusion; bare names map to --exclude-dir, globs to --exclude.
    if (p.includes("*") || p.includes("/")) args.push(`--exclude=${p}`);
    else args.push(`--exclude-dir=${p}`);
  }
  return args;
}

/** Cap total lines returned so one broad query can't flood the model's context. */
function capResults(output: string, maxResults: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxResults) return output;
  const kept = lines.slice(0, maxResults).join("\n");
  const dropped = lines.length - maxResults;
  return `${kept}\n… ${dropped} more matching line${dropped === 1 ? "" : "s"} not shown — narrow the query or set file_pattern.`;
}

export async function buildTree(
  dirPath: string,
  maxDepth: number,
  ignoreDirs: Set<string>,
  depth = 0,
  prefix = ""
): Promise<string> {
  if (depth >= maxDepth) return "";

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return "";
  }

  const visible = entries
    .filter((e) => !(e.isDirectory() && ignoreDirs.has(e.name)))
    .sort(sortEntries);

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
        ignoreDirs,
        depth + 1,
        prefix + childPrefix
      );
      if (subtree) lines.push(subtree);
    }
  }

  return lines.join("\n");
}

interface FileEntry {
  path: string;
  size: number;
  lines: number | null;
  content?: string;
}

async function describeFile(
  fullPath: string,
  rootPath: string,
  maxFileSizeKb: number,
  withContent: boolean
): Promise<FileEntry | null> {
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) return null;
    const entry: FileEntry = {
      path: relative(rootPath, fullPath),
      size: info.size,
      lines: null,
    };
    if (info.size <= maxFileSizeKb * 1024) {
      const content = await readFile(fullPath, "utf-8");
      entry.lines = content.split("\n").length;
      if (withContent) entry.content = content;
    } else if (withContent) {
      return null; // oversized: excluded from dumps, still listed
    }
    return entry;
  } catch {
    return null; // unreadable
  }
}

/** Filename search via ripgrep, which honours .gitignore and real globs. */
async function listFilesWithRg(
  dirPath: string,
  filePattern: string | undefined,
  ignore: Set<string>,
  maxFiles: number
): Promise<string[] | null> {
  // Ignores go last: ripgrep resolves overlapping globs by last-match-wins, so a positive
  // `--glob alpha.ts` placed after `--glob !**/node_modules/**` would pull vendored files back in.
  const args = ["--files"];
  if (filePattern) args.push("--glob", filePattern);
  args.push(...rgIgnoreArgs(ignore), dirPath);
  try {
    const { stdout } = await execFileAsync("rg", args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout.split("\n").filter(Boolean).slice(0, maxFiles);
  } catch (err) {
    const e = err as { code?: number };
    if (e.code === 1) return []; // no matches
    return null; // fall back to the Node walk
  }
}

/** Enough same-named files to decide a citation; past this the extra matches add nothing. */
const MAX_NAME_MATCHES = 50;
/** The Node fallback matches loosely, so it needs headroom before the exact names are filtered out. */
const MAX_NAME_CANDIDATES = 500;

/**
 * Files anywhere under a root whose *name* is `name` — ripgrep first (it honours .gitignore),
 * Node walk as the fallback. Absolute paths.
 *
 * This is how the citation checker resolves a partially-specified path. It replaced a whole-tree
 * index that listed every file under the roots and kept the first 20,000: in a monorepo that slice
 * is arbitrary and unordered, so an entire subtree could fall outside it and every citation into it
 * came back "file not found" (issue #16). One targeted search per unresolved path has no such cap.
 */
export async function findFilesNamed(dirPath: string, name: string): Promise<string[]> {
  const viaRg = (await hasRipgrep())
    ? await listFilesWithRg(dirPath, name, IGNORED_DIRS, MAX_NAME_MATCHES)
    : null;
  // The Node fallback matches on `includes`, a superset of "named exactly this"; callers filter by
  // path suffix anyway, so over-returning here is harmless and under-returning would not be.
  const found =
    viaRg ?? (await walkFiles(dirPath, Number.MAX_SAFE_INTEGER, name, IGNORED_DIRS, MAX_NAME_CANDIDATES));
  return found.filter((f) => basename(f) === name).slice(0, MAX_NAME_MATCHES);
}

async function walkFiles(
  dirPath: string,
  maxDepth: number,
  filePattern: string | undefined,
  ignoreDirs: Set<string>,
  maxFiles: number,
  found: string[] = [],
  depth = 0
): Promise<string[]> {
  if (depth >= maxDepth || found.length >= maxFiles) return found;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries.sort(sortEntries)) {
    if (found.length >= maxFiles) break;
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      await walkFiles(fullPath, maxDepth, filePattern, ignoreDirs, maxFiles, found, depth + 1);
    } else if (entry.isFile()) {
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (!matchesPattern(entry.name, filePattern)) continue;
      found.push(fullPath);
    }
  }

  return found;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round(bytes / 1024)}K`;
}

export interface ExploreFilesParams {
  path: string;
  query?: string;
  file_pattern?: string;
  context_lines?: number;
  max_results?: number;
  max_matches_per_file?: number;
  include_content?: boolean;
  max_depth?: number;
  max_file_size_kb?: number;
  max_files?: number;
  ignore_patterns?: string[];
}

export const EXPLORE_FILES_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory to search or list",
    },
    query: {
      type: "string",
      description:
        "Regex to search file contents for, via ripgrep (or grep). Returns matching lines as path:line:text — this is the main way to use this tool. Omit it only to list what files exist.",
    },
    file_pattern: {
      type: "string",
      description: 'Restrict to files matching this glob, e.g. "*.ts" or "src/**/*.tsx"',
    },
    context_lines: {
      type: "number",
      description: `Lines of context to show around each match (default: 0, max: ${MAX_CONTEXT_LINES})`,
    },
    max_results: {
      type: "number",
      description: `Maximum matching lines to return (default: ${MAX_RESULTS_DEFAULT})`,
    },
    max_matches_per_file: {
      type: "number",
      description: "Maximum matches per file. Useful for \"which files mention X\" sweeps (e.g. 1).",
    },
    include_content: {
      type: "boolean",
      description:
        "Return whole file contents instead of a listing. Expensive — prefer query, then read_file for the specific files you need.",
    },
    max_depth: {
      type: "number",
      description: "Max directory depth to traverse when listing (default: 5)",
    },
    max_file_size_kb: {
      type: "number",
      description: "Skip files larger than this many KB when returning contents (default: 100)",
    },
    max_files: {
      type: "number",
      description: `Maximum files to list (default: ${MAX_FILES_DEFAULT}, or ${MAX_CONTENT_FILES_DEFAULT} with include_content)`,
    },
    ignore_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Additional directory names or globs to ignore",
    },
  },
  required: ["path"],
};

export async function exploreFiles(params: ExploreFilesParams): Promise<string> {
  const {
    path: dirPath,
    query,
    file_pattern,
    context_lines,
    max_results = MAX_RESULTS_DEFAULT,
    max_matches_per_file,
    include_content = false,
    max_depth = 5,
    max_file_size_kb = 100,
    max_files,
    ignore_patterns,
  } = params;

  const mergedIgnoreDirs = new Set<string>(IGNORED_DIRS);
  if (ignore_patterns) {
    for (const p of ignore_patterns) {
      mergedIgnoreDirs.add(p);
    }
  }

  let dirStat;
  try {
    dirStat = await stat(dirPath);
  } catch {
    throw new Error(`Path not found: ${dirPath}`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  if (query) {
    return searchContents(dirPath, query, {
      file_pattern,
      context_lines,
      max_results,
      max_matches_per_file,
      ignore: mergedIgnoreDirs,
    });
  }

  const fileCap = max_files ?? (include_content ? MAX_CONTENT_FILES_DEFAULT : MAX_FILES_DEFAULT);
  const sections: string[] = [];

  const tree = await buildTree(dirPath, max_depth, mergedIgnoreDirs);
  sections.push(`## Directory: ${dirPath}\n\n.\n${tree}`);

  const useRg = await hasRipgrep();
  let paths: string[] | null = useRg
    ? await listFilesWithRg(dirPath, file_pattern, mergedIgnoreDirs, fileCap)
    : null;
  if (paths === null) {
    paths = await walkFiles(dirPath, max_depth, file_pattern, mergedIgnoreDirs, fileCap);
  }

  const entries: FileEntry[] = [];
  for (const p of paths) {
    if (BINARY_EXTENSIONS.has(extname(p).toLowerCase())) continue;
    const entry = await describeFile(isAbsolute(p) ? p : join(dirPath, p), dirPath, max_file_size_kb, include_content);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    sections.push("## Files\n\n(no files found matching criteria)");
    return sections.join("\n\n---\n\n");
  }

  const truncated = entries.length >= fileCap;
  const header = truncated
    ? `## Files (${entries.length}, truncated — use file_pattern or a subdirectory path to narrow scope)`
    : `## Files (${entries.length})`;

  if (include_content) {
    const blocks = entries.map((f) => {
      const lang = extname(f.path).slice(1);
      return `### ${f.path}\n\`\`\`${lang}\n${f.content ?? ""}\n\`\`\``;
    });
    sections.push(`${header}\n\n${blocks.join("\n\n")}`);
  } else {
    // Listing, not a dump: enough to choose what to read next, without spending the
    // context on files the task never needed.
    const rows = entries.map((f) => {
      const lines = f.lines === null ? "—" : `${f.lines} lines`;
      return `${f.path} · ${lines} · ${fmtSize(f.size)}`;
    });
    sections.push(
      `${header}\n\n${rows.join("\n")}\n\nUse query to search these files, or read_file to read one.`
    );
  }

  return sections.join("\n\n---\n\n");
}

interface SearchOptions {
  file_pattern?: string;
  context_lines?: number;
  max_results: number;
  max_matches_per_file?: number;
  ignore: Set<string>;
}

async function searchContents(dirPath: string, query: string, opts: SearchOptions): Promise<string> {
  const { file_pattern, context_lines, max_results, max_matches_per_file, ignore } = opts;
  const context = Math.min(Math.max(context_lines ?? 0, 0), MAX_CONTEXT_LINES);
  const useRg = await hasRipgrep();

  // The tree is deliberately not emitted here: a search runs many times per task, and
  // re-sending the whole directory map on each call is what makes one big dump cheaper
  // than several focused searches — exactly the behaviour we want to discourage.
  const label = useRg ? "ripgrep" : "grep";
  let searchOutput: string;

  try {
    const args = useRg
      ? ["--no-heading", "--line-number", "--color=never", ...rgIgnoreArgs(ignore)]
      : ["-rn", "--color=never", ...grepIgnoreArgs(ignore)];

    if (file_pattern) {
      if (useRg) args.push("--glob", file_pattern);
      else args.push(`--include=${file_pattern}`);
    }
    if (context > 0) args.push("-C", String(context));
    if (max_matches_per_file !== undefined) args.push("-m", String(max_matches_per_file));

    // `--` so a query starting with "-" is treated as a pattern, not a flag.
    args.push("--", query, dirPath);

    const { stdout } = await execFileAsync(useRg ? "rg" : "grep", args, { maxBuffer: 10 * 1024 * 1024 });
    searchOutput = capResults(stdout.trim(), max_results) || "(no results)";
  } catch (err) {
    searchOutput = handleSearchError(err);
  }

  return `## Search (${label}): "${query}" in ${dirPath}\n\n${searchOutput}`;
}
