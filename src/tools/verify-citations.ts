import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertWithinRoots } from "./sandbox.js";

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

async function lineCount(path: string): Promise<number> {
  const content = await readFile(path, "utf-8");
  return content.split("\n").length;
}

async function checkOne(
  rawPath: string,
  line: number,
  roots: string[],
  lineCache: Map<string, number | null>
): Promise<CitationCheck> {
  const citation = `${rawPath}:${line}`;

  // A relative citation is resolved against each root in turn — the model is told it may
  // range across all of them, so it has no single base directory to cite relative to.
  const candidates = isAbsolute(rawPath) ? [rawPath] : roots.map((r) => resolve(r, rawPath));

  for (const candidate of candidates) {
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
    if (total === null) continue;

    return line >= 1 && line <= total
      ? { citation, ok: true }
      : { citation, ok: false, reason: `file has ${total} lines` };
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
  const checks: CitationCheck[] = [];
  for (const { path, line } of found) {
    checks.push(await checkOne(path, line, roots, lineCache));
  }
  return checks;
}

/** One-line summary for the caller. Empty when the answer cited nothing. */
export function formatCitationReport(checks: CitationCheck[]): string {
  if (checks.length === 0) return "";

  const bad = checks.filter((c) => !c.ok);
  const label = `${checks.length} citation${checks.length === 1 ? "" : "s"} checked`;

  if (bad.length === 0) {
    return `_Citations: ${label}, all resolve to a real file and line._`;
  }

  const details = bad.map((c) => `${c.citation} (${c.reason})`).join("; ");
  return `_Citations: ${label}, **${bad.length} did not resolve** — ${details}. Treat the surrounding claims as unverified._`;
}
