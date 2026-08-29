import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, isAbsolute, basename } from "node:path";
import { gitIgnoreView, viewDenies, type GitIgnoreView } from "./git-ignore.js";

const execFileAsync = promisify(execFile);

/**
 * The backstop for when git cannot answer — outside a repository, or with git off PATH.
 *
 * It used to carry eleven names, and it was the whole ignore policy. That only ever described the
 * JavaScript ecosystem: `dist`, `.next`, `.turbo`, `.nyc_output` were in it while `target/`,
 * `.venv/`, `vendor/`, `Pods/` were not, so a Rust or Python repo searched its own build output and
 * nobody could fix it without editing this line. `git-ignore.ts` now owns the policy, and a
 * repository's own `.gitignore` covers every one of the nine names dropped from here. These two
 * stay because they have to hold when there is no repository to ask: `.git` must never be walked,
 * and `node_modules` is the one directory that drowns a walk on its own.
 *
 * Config `ignorePatterns` still merges on top of this (`agentic-task.ts`).
 */
export const IGNORED_DIRS = new Set(["node_modules", ".git"]);

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

/**
 * The flags that make ripgrep search the same tree the rest of the server can see.
 *
 * By default rg skips gitignored files and hidden ones. `buildTree` — the directory map injected
 * into the task prompt — and `Read` walk the filesystem and honour only `IGNORED_DIRS`, so the map
 * advertises files that a default rg search cannot find. That asymmetry is harmless in a search
 * tool and fatal in a checker: it is what let `verify-symbols` report a name defined in a
 * gitignored or dot-directory file as appearing nowhere in the tree (issue #17).
 *
 * The checkers use these for every pass past the first, because a checker's universe has to be
 * whatever `Read` can open, which is everything.
 *
 * `Grep`/`Glob` now use `--hidden` unconditionally — `.github/`, `.claude/`, `.circleci/` and root
 * dotfiles are ordinary source, and skipping them was never defensible — and reach for
 * `--no-ignore` only as a second pass, when the first found nothing at all (issue #22). Their
 * default filter is `git-ignore.ts`, not this.
 */
export const UNFILTERED_RG_ARGS = ["--hidden", "--no-ignore"];

/** What `Grep`/`Glob` search on the first pass: hidden files included, ignored files still out. */
const HIDDEN_RG_ARG = "--hidden";

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

/**
 * The directory map injected into the task prompt.
 *
 * `view` is what git can see under the root, or null when git cannot answer. It is the reason the
 * map and the model's `Grep`/`Glob` finally describe the same tree: before issue #22 this walked
 * the filesystem at `IGNORED_DIRS` while ripgrep filtered at `.gitignore`, so the map advertised
 * files that no search could reach and the model had no way to tell.
 */
export async function buildTree(
  dirPath: string,
  maxDepth: number,
  ignoreDirs: Set<string>,
  view: GitIgnoreView | null = null,
  depth = 0,
  prefix = "",
  rel = ""
): Promise<string> {
  if (depth >= maxDepth) return "";

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return "";
  }

  const visible = entries
    .filter((e) => {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && ignoreDirs.has(e.name)) return false;
      return !viewDenies(view, childRel);
    })
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
        view,
        depth + 1,
        prefix + childPrefix,
        rel ? `${rel}/${entry.name}` : entry.name
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
  maxFiles: number,
  unfiltered = false
): Promise<string[] | null> {
  // Ignores go last: ripgrep resolves overlapping globs by last-match-wins, so a positive
  // `--glob alpha.ts` placed after `--glob !**/node_modules/**` would pull vendored files back in.
  const args = ["--files"];
  args.push(...(unfiltered ? UNFILTERED_RG_ARGS : [HIDDEN_RG_ARG]));
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
 * Files anywhere under a root whose *name* is `name` — ripgrep first, Node walk as the fallback.
 * Absolute paths.
 *
 * This is how the citation checker resolves a partially-specified path. It replaced a whole-tree
 * index that listed every file under the roots and kept the first 20,000: in a monorepo that slice
 * is arbitrary and unordered, so an entire subtree could fall outside it and every citation into it
 * came back "file not found" (issue #16). One targeted search per unresolved path has no such cap.
 *
 * An *empty* ripgrep result is not an answer, only a filtered one: rg skips gitignored and hidden
 * files that `buildTree` listed and `Read` can open, so a real file the model actually read came
 * back "does not exist anywhere in the tree" (issue #17). A first pass at rg's defaults stays
 * because it is the fast common case; nothing is reported missing on the strength of it.
 */
export async function findFilesNamed(dirPath: string, name: string): Promise<string[]> {
  let viaRg = (await hasRipgrep())
    ? await listFilesWithRg(dirPath, name, IGNORED_DIRS, MAX_NAME_MATCHES)
    : null;
  if (viaRg !== null && viaRg.length === 0) {
    viaRg = await listFilesWithRg(dirPath, name, IGNORED_DIRS, MAX_NAME_MATCHES, true);
  }
  // The Node fallback matches on `includes`, a superset of "named exactly this"; callers filter by
  // path suffix anyway, so over-returning here is harmless and under-returning would not be.
  const found =
    viaRg ?? (await walkFiles(dirPath, Number.MAX_SAFE_INTEGER, name, IGNORED_DIRS, MAX_NAME_CANDIDATES));
  return found.filter((f) => basename(f) === name).slice(0, MAX_NAME_MATCHES);
}

/**
 * Every text file under a root, honouring only `IGNORED_DIRS` — the universe `buildTree` maps and
 * `Read` can open, and therefore the universe a checker has to be able to see before it calls a
 * name invented. The last-resort backstop in verify-symbols.ts, never a search path.
 */
export async function listAllFiles(dirPath: string, maxFiles: number): Promise<string[]> {
  return walkFiles(dirPath, Number.MAX_SAFE_INTEGER, undefined, IGNORED_DIRS, maxFiles);
}

/**
 * `view` is optional and defaults to null, which admits everything. `listAllFiles` relies on that:
 * the checkers' universe has to stay wider than the model's.
 */
async function walkFiles(
  dirPath: string,
  maxDepth: number,
  filePattern: string | undefined,
  ignoreDirs: Set<string>,
  maxFiles: number,
  found: string[] = [],
  depth = 0,
  view: GitIgnoreView | null = null,
  rel = ""
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
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      // Prune here rather than filtering afterwards, so a 40k-file .venv/ is never walked at all.
      if (viewDenies(view, childRel)) continue;
      await walkFiles(
        fullPath, maxDepth, filePattern, ignoreDirs, maxFiles, found, depth + 1, view, childRel
      );
    } else if (entry.isFile()) {
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (!matchesPattern(entry.name, filePattern)) continue;
      if (viewDenies(view, childRel)) continue;
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
  include_ignored?: boolean;
}

export interface GlobParams {
  // Glob to match, e.g. "*.ts" or "src/**/*.tsx". Omit to list everything under `path`.
  pattern?: string;
  path?: string;
  max_files?: number;
  max_depth?: number;
  max_file_size_kb?: number;
  ignore_patterns?: string[];
  include_ignored?: boolean;
}

export const GREP_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regular expression to search file contents with. The tool returns matching lines as path:line:text.",
    },
    path: {
      type: "string",
      description: "Directory or file to search in. The default is the directory that the task was mapped at.",
    },
    glob: {
      type: "string",
      description: 'Search only the files that match this glob, such as "*.ts" or "src/**/*.tsx".',
    },
    "-i": {
      type: "boolean",
      description: "Ignore letter case in the search (default: false).",
    },
    "-C": {
      type: "number",
      description: `Lines of context to show around each match (default: 0, maximum: ${MAX_CONTEXT_LINES}).`,
    },
    max_results: {
      type: "number",
      description: `Maximum number of matching lines to return (default: ${MAX_RESULTS_DEFAULT}).`,
    },
    max_matches_per_file: {
      type: "number",
      description: 'Maximum number of matches for each file. Set it to 1 for a "which files mention X" sweep.',
    },
    ignore_patterns: {
      type: "array",
      items: { type: "string" },
      description: "More directory names or globs to ignore.",
    },
    include_ignored: {
      type: "boolean",
      description:
        "Also search the files that git ignores, such as build output, local config, and vendored code. Off by default. If a search finds nothing, locally runs it again with this option on.",
    },
  },
  required: ["pattern"],
};

export const GLOB_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: 'Glob to match file paths against, such as "*.ts" or "src/**/*.tsx". Omit it to list every file under path.',
    },
    path: {
      type: "string",
      description: "Directory to search in. The default is the directory that the task was mapped at.",
    },
    max_files: {
      type: "number",
      description: `Maximum number of files to list (default: ${MAX_FILES_DEFAULT}).`,
    },
    max_depth: {
      type: "number",
      description: "Maximum directory depth to go into when ripgrep is not available (default: 5).",
    },
    max_file_size_kb: {
      type: "number",
      description: "Do not count the lines of a file that is larger than this many KB (default: 100).",
    },
    ignore_patterns: {
      type: "array",
      items: { type: "string" },
      description: "More directory names or globs to ignore.",
    },
    include_ignored: {
      type: "boolean",
      description:
        "Also search the files that git ignores, such as build output, local config, and vendored code. Off by default. If a search finds nothing, locally runs it again with this option on.",
    },
  },
  required: [],
};

/**
 * The second pass runs with no ignore rules at all, so it can reach build output. It is only ever
 * shown when the first pass found nothing, and it is capped hard: this is a "here is where the name
 * actually lives" hint, not a result set.
 */
const WIDENED_CAP = 20;

/**
 * Which filter produced this result — the difference between "nothing is there" and "nothing I can
 * see". Without this line a model reading a short listing has no way to tell the two apart, and
 * the explore contract tells it to build file lists out of exactly these listings (issue #22).
 */
function filterLabel(state: {
  wide: boolean;
  widened: boolean;
  view: GitIgnoreView | null;
}): string {
  if (state.widened) return "widened past git's ignore rules — nothing matched without them";
  if (state.wide) return "ignore rules off";
  // A view means there is a repository to ask. ripgrep applies its rules itself and the Node/grep
  // paths apply them from the view, but neither has anything to apply without one — and claiming a
  // filter that did not run is the one thing this line must never do.
  if (state.view) return "git's ignore rules honoured";
  return "no ignore filter — not a git repository";
}

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
  const wide = params.include_ignored === true;
  const view = wide ? null : await gitIgnoreView(dirPath);
  const useRg = await hasRipgrep();

  const listOnce = async (unfiltered: boolean, cap: number): Promise<string[]> => {
    if (useRg) return (await listFilesWithRg(dirPath, pattern, ignore, cap, unfiltered)) ?? [];
    return walkFiles(dirPath, max_depth, pattern, ignore, cap, [], 0, unfiltered ? null : view);
  };

  let paths = await listOnce(wide, fileCap);
  // An empty listing is not an answer, only a filtered one. Widening past the ignore rules here is
  // what stops "Glob found nothing" from reading as "there is nothing there" (issue #22).
  let widened = false;
  if (paths.length === 0 && !wide) {
    paths = await listOnce(true, WIDENED_CAP);
    widened = paths.length > 0;
  }

  const entries: FileEntry[] = [];
  for (const p of paths) {
    if (BINARY_EXTENSIONS.has(extname(p).toLowerCase())) continue;
    const entry = await describeFile(isAbsolute(p) ? p : join(dirPath, p), dirPath, max_file_size_kb);
    if (entry) entries.push(entry);
  }

  const filter = filterLabel({ wide, widened, view });
  const what = pattern ? `"${pattern}" in ${dirPath}` : dirPath;
  if (entries.length === 0) {
    return `## Files: ${what} (${filter})\n\n(no files found matching criteria)`;
  }

  const truncated = entries.length >= fileCap;
  const header = truncated
    ? `## Files: ${what} (${entries.length}, ${filter}, truncated — narrow the pattern or use a subdirectory)`
    : `## Files: ${what} (${entries.length}, ${filter})`;

  const rows = entries.map((f) => {
    const lines = f.lines === null ? "—" : `${f.lines} lines`;
    return `${f.path} · ${lines} · ${fmtSize(f.size)}`;
  });

  return `${header}\n\n${rows.join("\n")}\n\nUse Grep to search these files, or Read to open one.`;
}

/**
 * Split a grep output line into the file it belongs to and the rest.
 *
 * grep spells a match `path:12:text` and, under `-C`, a context line `path-11-text` — a dash, not a
 * colon. A filter that knows only the colon form drops every context line the model asked for. The
 * path itself may contain either character, so the first split is a guess and we widen it until a
 * candidate lands in the set of files we know about.
 */
function grepLinePath(line: string, known: (candidate: string) => boolean): string | null {
  const re = /[:-]\d+[:-]/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const candidate = line.slice(0, m.index);
    if (candidate && known(candidate)) return candidate;
  }
  return null;
}

/**
 * Keep only the grep output belonging to files git can see.
 *
 * `grep -r` honours neither `.gitignore` nor hidden-file rules, so before issue #22 a run without
 * ripgrep searched a strictly wider tree than one with it — in this repository that meant every hit
 * arriving twice, once from a gitignored worktree holding a second copy of the source. Filtering
 * the output is what brings the two backends to the same answer.
 */
function filterGrepOutput(output: string, dirPath: string, view: GitIgnoreView): string {
  const kept: string[] = [];
  const known = (candidate: string): boolean =>
    !viewDenies(view, relative(dirPath, isAbsolute(candidate) ? candidate : join(dirPath, candidate)));

  for (const line of output.split("\n")) {
    // A bare "--" separates context blocks. Keep it only between two lines we kept, so dropping a
    // block never leaves an orphan.
    if (line === "--") {
      if (kept.length > 0 && kept[kept.length - 1] !== "--") kept.push(line);
      continue;
    }
    if (grepLinePath(line, known)) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "--") kept.pop();
  return kept.join("\n");
}

/**
 * Search file contents. Ripgrep when available, grep otherwise; both return `path:line:text`,
 * which is also the shape the run's coverage tracking reads to learn which files were seen inside.
 *
 * Two passes. The first honours git's ignore rules but not its hidden-file blindness; the second
 * runs only when the first matched nothing at all, drops the ignore rules, and says so. An empty
 * result is not an answer, only a filtered one — the same reasoning `findFilesNamed` already used,
 * applied to the tools the model actually calls (issue #22).
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
  const wide = params.include_ignored === true;
  const view = wide ? null : await gitIgnoreView(dirPath);

  const buildArgs = (unfiltered: boolean): string[] => {
    // `-I` so a binary hit does not arrive as "Binary file X matches", which carries no line number
    // and so cannot be attributed to a file. verify-symbols has always passed it; this had not.
    const args = useRg
      ? ["--no-heading", "--line-number", "--color=never", ...(unfiltered ? UNFILTERED_RG_ARGS : [HIDDEN_RG_ARG])]
      : ["-rn", "-I", "--color=never"];

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
    return args;
  };

  // Both engines exit 1 on "no match", which execFile reports as a throw. Turning that into an
  // empty string here is what lets the widening pass see an empty first pass at all — left as a
  // throw it escapes to the catch below and the second pass never runs.
  const runSearch = async (unfiltered: boolean): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(useRg ? "rg" : "grep", buildArgs(unfiltered), {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (err) {
      if ((err as { code?: number }).code === 1) return "";
      throw err;
    }
  };

  const label = useRg ? "ripgrep" : "grep";
  let searchOutput: string;
  let widened = false;

  try {
    // grep searched everything either way, so its widened result is already in hand — no second
    // spawn on this branch, only on ripgrep's.
    const raw = await runSearch(wide);
    // Filter before capping, or `max_results` is spent on lines that are then discarded. ripgrep
    // applied the policy itself; only the grep fallback arrives here unfiltered.
    let hits = view && !wide && !useRg ? filterGrepOutput(raw, dirPath, view) : raw;

    if (!hits && !wide) {
      const widerRaw = useRg ? await runSearch(true) : raw;
      if (widerRaw) {
        // Its own, tighter cap: this is a "here is where the name actually lives" hint, not a
        // result set, and the files it reaches are build output.
        hits = capResults(widerRaw, WIDENED_CAP);
        widened = true;
      }
    }
    searchOutput = capResults(hits, max_results) || "(no results)";
  } catch (err) {
    searchOutput = handleSearchError(err);
  }

  const filter = filterLabel({ wide, widened, view });
  return `## Search (${label}, ${filter}): "${pattern}" in ${dirPath}\n\n${searchOutput}`;
}

