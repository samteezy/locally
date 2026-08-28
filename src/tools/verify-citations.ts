import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { assertWithinRoots } from "./sandbox.js";
import { listTreeFiles, IGNORED_DIRS } from "./explore-files.js";

/**
 * `path:line` citations are the reason to reach for explore_task over a chat window, so
 * they are worth checking rather than trusting. The server already has filesystem access:
 * re-open each cited file and confirm the line exists.
 *
 * This verifies that the file is real and the line is in range — enough to catch an
 * invented file or a number pulled out of the air. It deliberately does not try to match
 * the named symbol: that needs a parser per language, and a wrong "unverified" tag on a
 * correct citation is worse than no tag at all. Citations are annotated, never rewritten;
 * silently "correcting" a line number would hide exactly the failure worth seeing.
 */

/**
 * A path-looking token with a real extension, followed by `:line`.
 *
 * The lookbehind rejects any candidate preceded by a word character, `:` or `/`, which
 * is what keeps URLs out: in `https://example.com:8080` every possible starting point is
 * preceded by one of those. It also drops version strings like `v1.2:3`, since the
 * extension must begin with a letter.
 */
const CITATION_RE = /(?<![\w:/])(\/?(?:[\w.@+~-]+\/)*[\w.@+~-]+\.[A-Za-z][\w]*):(\d+)/g;

export interface CitationCheck {
  citation: string;
  ok: boolean;
  reason?: string;
}

/** Bounds the index for a citation that needs a tree-wide lookup. */
const MAX_INDEXED_FILES = 20_000;

/**
 * Files under the roots, listed once per verification run and only if some citation actually
 * needs them. Most answers cite paths that resolve directly and never touch this.
 */
class TreeIndex {
  private files: string[] | null = null;

  constructor(private readonly roots: string[]) {}

  private async load(): Promise<string[]> {
    if (this.files) return this.files;
    const all: string[] = [];
    for (const root of this.roots) {
      try {
        all.push(...(await listTreeFiles(root, IGNORED_DIRS, MAX_INDEXED_FILES)));
      } catch {
        // An unlistable root simply contributes nothing.
      }
    }
    this.files = all;
    return all;
  }

  /**
   * Files whose path ends with the cited one at a segment boundary, so `agent-loop.ts` finds
   * `src/llm/agent-loop.ts` but `loop.ts` does not.
   */
  async suffixMatches(citedPath: string): Promise<string[]> {
    const needle = sep + citedPath.split("/").join(sep);
    return (await this.load()).filter((f) => f.endsWith(needle));
  }
}

async function lineCount(path: string): Promise<number> {
  const content = await readFile(path, "utf-8");
  return content.split("\n").length;
}

async function resolvedLineCount(
  candidate: string,
  roots: string[],
  lineCache: Map<string, number | null>
): Promise<number | null> {
  let total = lineCache.get(candidate);
  if (total === undefined) {
    try {
      assertWithinRoots(candidate, roots, { mustExist: true });
      total = await lineCount(candidate);
    } catch {
      total = null;
    }
    lineCache.set(candidate, total);
  }
  return total;
}

async function checkOne(
  rawPath: string,
  line: number,
  roots: string[],
  lineCache: Map<string, number | null>,
  index: TreeIndex
): Promise<CitationCheck> {
  const citation = `${rawPath}:${line}`;

  // A relative citation is resolved against each root in turn — the model is told it may
  // range across all of them, so it has no single base directory to cite relative to.
  const candidates = isAbsolute(rawPath) ? [rawPath] : roots.map((r) => resolve(r, rawPath));

  for (const candidate of candidates) {
    const total = await resolvedLineCount(candidate, roots, lineCache);
    if (total === null) continue;

    return line >= 1 && line <= total
      ? { citation, ok: true }
      : { citation, ok: false, reason: `file has ${total} lines` };
  }

  // Nothing resolved against a root, which usually means the path was written short —
  // `agent-loop.ts:107` rather than `src/llm/agent-loop.ts:107`. A short path is a formatting
  // slip, not a fabrication, and calling it "file not found" buries the citations that really
  // are wrong: one eval run flagged 49 of 68 correct citations this way. So fall back to a
  // tree-wide lookup for a file whose path ends with the cited one.
  if (!isAbsolute(rawPath)) {
    const matches = await index.suffixMatches(rawPath);
    // With several files sharing a name there is no way to tell which was meant, so accept the
    // citation if the line lands in any of them — silence beats a warning we cannot stand behind.
    let sawFile = false;
    for (const match of matches) {
      const total = await resolvedLineCount(match, roots, lineCache);
      if (total === null) continue;
      sawFile = true;
      if (line >= 1 && line <= total) return { citation, ok: true };
    }
    if (sawFile) return { citation, ok: false, reason: "line out of range" };
  }

  return { citation, ok: false, reason: "file not found" };
}

export async function verifyCitations(text: string, roots: string[]): Promise<CitationCheck[]> {
  const seen = new Set<string>();
  const found: Array<{ path: string; line: number }> = [];

  for (const match of text.matchAll(CITATION_RE)) {
    const [, path, lineStr] = match;
    const key = `${path}:${lineStr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path, line: Number(lineStr) });
  }

  const lineCache = new Map<string, number | null>();
  const index = new TreeIndex(roots);
  const checks: CitationCheck[] = [];
  for (const { path, line } of found) {
    checks.push(await checkOne(path, line, roots, lineCache, index));
  }
  return checks;
}

/**
 * One-line summary for the caller.
 *
 * An answer that cites nothing at all gets the loudest note, not silence. Citations are the
 * reason to reach for explore_task over a chat window, so an uncited answer has failed the
 * contract — and until this it was indistinguishable from a well-cited one (issue #13).
 */
export function formatCitationReport(checks: CitationCheck[]): string {
  if (checks.length === 0) {
    return "_Citations: **none** — this answer names no path:line, so nothing in it is anchored to a file. Treat it as unverified._";
  }

  const bad = checks.filter((c) => !c.ok);
  const label = `${checks.length} citation${checks.length === 1 ? "" : "s"} checked`;

  if (bad.length === 0) {
    return `_Citations: ${label}, all resolve to a real file and line._`;
  }

  const details = bad.map((c) => `${c.citation} (${c.reason})`).join("; ");
  return `_Citations: ${label}, **${bad.length} did not resolve** — ${details}. Treat the surrounding claims as unverified._`;
}
