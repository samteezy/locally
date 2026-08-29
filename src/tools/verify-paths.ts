import { FileResolver } from "./resolve-path.js";
import { codeSpans, stripFences, tableRows } from "./answer-text.js";

/**
 * A small model that gets the *shape* of an answer right will fill it with files that do not exist.
 *
 * Issue #16 run A produced a correct list of 12 database tables and then a table of one Zod schema
 * file per table, seven of which were invented — plus three test files and a route that were not
 * there either. It never opened the directory. The invention was *shaped by the correct part of its
 * own answer*: one schema file per table is what the answer ought to look like.
 *
 * Every one of those ten is decidable with a single search, which is what this does. It is the
 * sibling of verify-symbols.ts and inherits its asymmetry: no hits proves the name was invented,
 * hits prove nothing at all. verify-symbols cannot do this job itself — its identifier test rejects
 * anything containing a dot or a slash, so a filename has never been checked by anything.
 *
 * Everything below is biased toward a false pass, because the one failure this check cannot afford
 * is telling a caller that a real file is missing.
 */

/**
 * Extensions worth deciding on. An allowlist rather than "anything after a dot", because prose is
 * full of tokens that parse as a path and are not one, and a warning about `Ruby.on` would cost
 * more than the miss on an unusual extension does.
 */
const CHECKED_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sql", "prisma", "graphql", "proto",
  "json", "yaml", "yml", "toml", "ini", "env",
  "md", "mdx", "css", "scss", "html", "vue", "svelte", "sh",
]);

/**
 * Library names that are not files. `Node.js` and `Vue.js` parse as a path with a `.js` extension
 * and appear in answers constantly; without this they would be reported as fabricated files.
 */
const NOT_FILES = new Set([
  "node.js", "next.js", "nuxt.js", "nest.js", "vue.js", "react.js", "express.js", "ember.js",
  "backbone.js", "three.js", "chart.js", "d3.js", "socket.io", "vite.js", "angular.js",
]);

/** A path token: optional directories, a filename, a dotted extension. No globs, no spaces. */
const PATH_TOKEN_RE = /^\/?(?:[\w.@+~-]+\/)*([\w.@+~-]+)\.([A-Za-z][A-Za-z0-9]{0,7})$/;

/** Bounds the work; an answer naming more than this is not the common case. */
const MAX_PATHS = 100;

export interface PathCheck {
  path: string;
  exists: boolean;
  /** Canonical path, when the token resolved to exactly one file. Absent when it was ambiguous. */
  resolvedPath?: string;
}

export interface PathReport {
  checks: PathCheck[];
  /** Distinct file paths the answer named, before the MAX_PATHS cap. */
  named: number;
}

/**
 * Is this token a filename the tree can be asked about?
 *
 * Only tokens the model set apart — in a code span or a table cell — get here. A path written in
 * bare prose is not checked: a model that mentions "the config.ts pattern" is not asserting a file,
 * and reading it as one manufactures a warning.
 */
export function isPathToken(token: string): boolean {
  const m = PATH_TOKEN_RE.exec(token);
  if (!m) return false;
  const [, name, ext] = m;
  if (!CHECKED_EXTENSIONS.has(ext.toLowerCase())) return false;
  if (NOT_FILES.has(token.toLowerCase())) return false;
  // A bare extension (".env") or an all-digit name ("2.ts") is not a claim about a file.
  return /[A-Za-z]/.test(name);
}

/** Distinct file paths the answer sets apart in code spans or table cells, in order of appearance. */
export function extractPaths(text: string): string[] {
  const prose = stripFences(text);
  const seen = new Set<string>();
  const paths: string[] = [];

  const consider = (token: string): void => {
    // A citation is a path plus `:line`; check the path half, and let the citation checker own
    // the line half rather than reporting the same file twice under two headings.
    const bare = token.replace(/:\d+(?:\s*[-–]\s*\d+)?$/, "");
    if (!isPathToken(bare) || seen.has(bare)) return;
    seen.add(bare);
    paths.push(bare);
  };

  for (const span of codeSpans(prose)) consider(span);
  for (const cells of tableRows(prose)) {
    for (const cell of cells) consider(cell);
  }

  return paths;
}

/**
 * @param taskPath the directory the caller asked to be mapped, tried first when resolving.
 * @param skip paths already reported by another check, so one bad file is named once.
 * @param resolver shared with the other checks so each file is read once, not three times.
 */
export async function verifyPaths(
  text: string,
  roots: string[],
  taskPath?: string,
  skip?: ReadonlySet<string>,
  resolver: FileResolver = new FileResolver(roots, taskPath)
): Promise<PathReport> {
  const named = extractPaths(text).filter((p) => !skip?.has(p));
  const paths = named.slice(0, MAX_PATHS);
  if (paths.length === 0) return { checks: [], named: named.length };

  const checks: PathCheck[] = [];
  for (const path of paths) {
    try {
      const files = await resolver.candidates(path);
      checks.push({
        path,
        exists: files.length > 0,
        ...(files.length === 1 ? { resolvedPath: files[0].path } : {}),
      });
    } catch {
      // An unusable search is not evidence of absence. Treat it as present.
      checks.push({ path, exists: true });
    }
  }
  return { checks, named: named.length };
}

/**
 * One line for the caller, and only when there is something to say — the same rule verify-symbols
 * follows. A clean run stays silent: the answer already carries a Citations: line, and a third
 * all-clear on every response is the kind of noise that gets all of them skipped.
 */
export function formatPathReport(report: PathReport): string {
  const { checks, named } = report;
  const missing = checks.filter((c) => !c.exists);
  if (missing.length === 0) return "";

  const label =
    named > checks.length
      ? `${checks.length} of ${named} file paths checked`
      : `${checks.length} file path${checks.length === 1 ? "" : "s"} checked`;
  const verb = missing.length === 1 ? "does" : "do";
  const names = missing.map((c) => `\`${c.path}\``).join(", ");

  return `_Files: ${label}. **${missing.length} ${verb} not exist anywhere in the tree**: ${names}. Treat the claims that describe them as invented._`;
}
