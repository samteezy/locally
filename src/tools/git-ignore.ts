import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { dirname, sep } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * What git excludes under a root — the ignore policy for every surface the model sees.
 *
 * This replaced a hand-written list of directory names, which only ever described the JavaScript
 * ecosystem: `dist`, `.next`, `.turbo` were in it and `target/`, `.venv/`, `vendor/`, `Pods/` were
 * not, so a Rust or Python repo searched its own build output and nobody could fix it without
 * editing that line. A repository already declares what is derived, and `--exclude-standard` reads
 * that declaration the way git itself does — nested `.gitignore` files, negations, `.git/info/exclude`
 * and the user's global excludes. Parsing `.gitignore` ourselves would have covered the first of
 * those and quietly missed the rest: in this very repository `.claude/settings.local.json` is
 * excluded by the user's global file, not by anything in the tree.
 *
 * It is a set of what to **hide**, not a set of what to show, and that direction is the whole
 * design. An allow-list built from `ls-files --cached --others` looks equivalent and is not: git
 * reports a submodule as a single gitlink entry, so every file inside one would have been absent
 * from the listing and therefore invisible to the map and to `Glob`, while `Read` opened them
 * happily — reintroducing the exact bug issue #22 exists to fix. A deny set fails open. Anything
 * git has not heard of — a file `run_task` wrote a moment ago, a submodule's contents, an empty
 * directory — stays visible.
 */
export interface GitIgnoreView {
  /** Paths relative to the root, slash-separated, no trailing slash. */
  denied: Set<string>;
}

/** A repo with thousands of *loose* ignored files; past this the backstop is the honest answer. */
const MAX_DENIED_ENTRIES = 5000;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;

let gitAvailable: boolean | null = null;

async function hasGit(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  try {
    await execFileAsync("which", ["git"]);
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** Reset the memoized git probe. Exposed for tests, mirroring `resetRipgrepCache`. */
export function resetGitCache(): void {
  gitAvailable = null;
}

/**
 * What git excludes under `root`, or null when it cannot answer — git missing, not a repository,
 * dubious ownership, a timeout, or a listing too large to hold.
 *
 * Null means "hide nothing". Every caller has to read it that way; inverting it is what would
 * blank the directory map on a machine without git.
 *
 * Deliberately not memoized across calls. `run_task` writes files mid-run, and the cost is bounded:
 * `buildTree` runs once per task, and the Node walk and grep fallback only run without ripgrep.
 */
export async function gitIgnoreView(root: string): Promise<GitIgnoreView | null> {
  if (!(await hasGit())) return null;

  // `git -C` needs a directory. A Grep may be pointed at a single file, and erroring there would
  // silently drop the filter for that call.
  let dir = root;
  try {
    if (!(await stat(root)).isDirectory()) dir = dirname(root);
  } catch {
    return null;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        // Read-only tools have no business taking index.lock in a repo someone is committing in.
        "--no-optional-locks",
        "-C", dir,
        "ls-files", "-z",
        "--others", "--ignored", "--exclude-standard",
        // Load-bearing: it collapses a wholly-ignored directory to one entry instead of listing
        // every file inside it. On this repo that is 6 entries rather than 4150.
        "--directory",
      ],
      { maxBuffer: MAX_LISTING_BYTES, timeout: GIT_TIMEOUT_MS }
    ));
  } catch {
    return null;
  }

  const denied = new Set<string>();
  for (const path of stdout.split("\0")) {
    if (!path) continue;
    denied.add(path.endsWith("/") ? path.slice(0, -1) : path);
    if (denied.size > MAX_DENIED_ENTRIES) return null;
  }
  return { denied };
}

/** Git spells paths with forward slashes; `path.relative` uses the platform separator. */
function toGitPath(relativePath: string): string {
  return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

/**
 * Whether git excludes this path, or anything it sits under.
 *
 * The ancestor walk is what makes `--directory` safe: the set holds `dist`, never `dist/index.js`,
 * so a caller matching only exact paths would let every file inside an ignored directory through.
 * Walkers prune and never ask, but the grep fallback filters finished output and does.
 */
export function viewDenies(view: GitIgnoreView | null, relativePath: string): boolean {
  if (!view || relativePath === "") return false;
  const path = toGitPath(relativePath);
  if (view.denied.has(path)) return true;
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
    if (view.denied.has(path.slice(0, at))) return true;
  }
  return false;
}
