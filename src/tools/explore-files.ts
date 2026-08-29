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
  /** Null for a file too large to count cheaply; it is still listed, just without a line count. */
  lines: number | null;
}

async function describeFile(
  fullPath: string,
  rootPath: string,
  maxFileSizeKb: number
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
      entry.lines = (await readFile(fullPath, "utf-8")).split("\n").length;
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

/**
 * Two tools, not one with a mode switch.
 *
 * `exploreFiles` used to be a single entry point whose behaviour depended on whether `query` was
 * set: with one it searched contents, without one it listed (or, before 0.2, dumped) a directory.
 * Eleven optional parameters and two unrelated result shapes behind one name is a lot of tool for a
 * small model to hold, and the mode switch was invisible in the schema. The two code paths were
 * already separate underneath, so this splits them at the tool boundary as well.
 *
 * The names are `Grep` and `Glob` (and `Read`, in read-file.ts) because that is what the rest of
 * the industry calls these three, and therefore what every model has seen most of during training.
 * A model that guesses at our tool surface should guess right.
 */

export interface GrepParams {
  pattern: string;
  /** Directory or file to search. Filled in from the task's own path when the model omits it. */
  path?: string;
  glob?: string;
  /** Case-insensitive search. Named for the ripgrep flag, as in every other agent's Grep. */
  "-i"?: boolean;
  /** Lines of context around each match. */
  "-C"?: number;
  max_results?: number;
  max_matches_per_file?: number;
  ignore_patterns?: string[];
}

export interface GlobParams {
  // Glob to match, e.g. "*.ts" or "src/**/*.tsx". Omit to list everything under `path`.
  pattern?: string;
  path?: string;
  max_files?: number;
  max_depth?: number;
  max_file_size_kb?: number;
  ignore_patterns?: string[];
}

export const GREP_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regular expression to search file contents for. Returns matching lines as path:line:text.",
    },
    path: {
      type: "string",
      description: "Directory or file to search in. Defaults to the directory the task was mapped at.",
    },
    glob: {
      type: "string",
      description: 'Restrict the search to files matching this glob, e.g. "*.ts" or "src/**/*.tsx"',
    },
    "-i": {
      type: "boolean",
      description: "Case-insensitive search (default: false)",
    },
    "-C": {
      type: "number",
      description: `Lines of context to show around each match (default: 0, max: ${MAX_CONTEXT_LINES})`,
    },
    max_results: {
      type: "number",
      description: `Maximum matching lines to return (default: ${MAX_RESULTS_DEFAULT})`,
    },
    max_matches_per_file: {
      type: "number",
      description: 'Maximum matches per file. Useful for "which files mention X" sweeps (e.g. 1).',
    },
    ignore_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Additional directory names or globs to ignore",
    },
  },
  required: ["pattern"],
};

export const GLOB_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: 'Glob to match file paths against, e.g. "*.ts" or "src/**/*.tsx". Omit to list every file under path.',
    },
    path: {
      type: "string",
      description: "Directory to search in. Defaults to the directory the task was mapped at.",
    },
    max_files: {
      type: "number",
      description: `Maximum files to list (default: ${MAX_FILES_DEFAULT})`,
    },
    max_depth: {
      type: "number",
      description: "Max directory depth to traverse when ripgrep is unavailable (default: 5)",
    },
    max_file_size_kb: {
      type: "number",
      description: "Skip counting lines for files larger than this many KB (default: 100)",
    },
    ignore_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Additional directory names or globs to ignore",
    },
  },
  required: [],
};

function mergedIgnores(extra: string[] | undefined): Set<string> {
  const merged = new Set<string>(IGNORED_DIRS);
  for (const p of extra ?? []) merged.add(p);
  return merged;
}

async function assertDirectory(dirPath: string): Promise<void> {
  let dirStat;
  try {
    dirStat = await stat(dirPath);
  } catch {
    throw new Error(`Path not found: ${dirPath}`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }
}

/**
 * Find files by name pattern. Ripgrep when it is available — it honours .gitignore and real
 * `**` globs — with a Node walk as the fallback, which matches on a prefix/substring instead.
 *
 * Deliberately does not emit a directory tree. The task prompt already carries one, and re-sending
 * it on every call is what made a single broad call cheaper than several focused ones.
 */
export async function globFiles(params: GlobParams): Promise<string> {
  const { pattern, path: rawPath, max_files, max_depth = 5, max_file_size_kb = 100 } = params;
  const dirPath = rawPath ?? process.cwd();
  const ignore = mergedIgnores(params.ignore_patterns);

  await assertDirectory(dirPath);

  const fileCap = max_files ?? MAX_FILES_DEFAULT;
  const viaRg = (await hasRipgrep()) ? await listFilesWithRg(dirPath, pattern, ignore, fileCap) : null;
  const paths = viaRg ?? (await walkFiles(dirPath, max_depth, pattern, ignore, fileCap));

  const entries: FileEntry[] = [];
  for (const p of paths) {
    if (BINARY_EXTENSIONS.has(extname(p).toLowerCase())) continue;
    const entry = await describeFile(isAbsolute(p) ? p : join(dirPath, p), dirPath, max_file_size_kb);
    if (entry) entries.push(entry);
  }

  const what = pattern ? `"${pattern}" in ${dirPath}` : dirPath;
  if (entries.length === 0) return `## Files: ${what}\n\n(no files found matching criteria)`;

  const truncated = entries.length >= fileCap;
  const header = truncated
    ? `## Files: ${what} (${entries.length}, truncated — narrow the pattern or use a subdirectory)`
    : `## Files: ${what} (${entries.length})`;

  const rows = entries.map((f) => {
    const lines = f.lines === null ? "—" : `${f.lines} lines`;
    return `${f.path} · ${lines} · ${fmtSize(f.size)}`;
  });

  return `${header}\n\n${rows.join("\n")}\n\nUse Grep to search these files, or Read to open one.`;
}

/**
 * Search file contents. Ripgrep when available, grep otherwise; both return `path:line:text`,
 * which is also the shape the run's coverage tracking reads to learn which files were seen inside.
 */
export async function grepFiles(params: GrepParams): Promise<string> {
  const {
    pattern,
    path: rawPath,
    glob,
    max_results = MAX_RESULTS_DEFAULT,
    max_matches_per_file,
  } = params;
  const dirPath = rawPath ?? process.cwd();
  const ignore = mergedIgnores(params.ignore_patterns);
  const context = Math.min(Math.max(params["-C"] ?? 0, 0), MAX_CONTEXT_LINES);
  const useRg = await hasRipgrep();

  // No directory tree here: a search runs many times per task, and re-sending the whole map on
  // each call is what makes one big sweep cheaper than several focused ones.
  const label = useRg ? "ripgrep" : "grep";
  let searchOutput: string;

  try {
    const args = useRg
      ? ["--no-heading", "--line-number", "--color=never"]
      : ["-rn", "--color=never"];

    if (glob) {
      if (useRg) args.push("--glob", glob);
      else args.push(`--include=${glob}`);
    }
    // Ignores go last. Ripgrep resolves overlapping globs last-match-wins, so a positive
    // `--glob "*.ts"` emitted after `--glob "!**/node_modules/**"` pulls vendored files back in.
    // The same ordering bug was fixed in listFilesWithRg and missed here.
    args.push(...(useRg ? rgIgnoreArgs(ignore) : grepIgnoreArgs(ignore)));

    if (params["-i"]) args.push("-i");
    if (context > 0) args.push("-C", String(context));
    if (max_matches_per_file !== undefined) args.push("-m", String(max_matches_per_file));

    // `--` so a pattern starting with "-" is treated as a pattern, not a flag.
    args.push("--", pattern, dirPath);

    const { stdout } = await execFileAsync(useRg ? "rg" : "grep", args, { maxBuffer: 10 * 1024 * 1024 });
    searchOutput = capResults(stdout.trim(), max_results) || "(no results)";
  } catch (err) {
    searchOutput = handleSearchError(err);
  }

  return `## Search (${label}): "${pattern}" in ${dirPath}\n\n${searchOutput}`;
}
