import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { assertWithinRoots } from "./sandbox.js";
import { findFilesNamed } from "./explore-files.js";

/**
 * Turning a path the model wrote into the file it meant.
 *
 * Shared by the two checks that need it: `verify-citations.ts` (does this path:line exist?) and
 * `verify-paths.ts` (does this file exist at all?). Both have the same failure cost — calling a
 * real file missing teaches the caller to skip the footer — so the resolution is deliberately
 * generous, and only an empty result means anything.
 *
 * Three tries, nearest base first:
 *
 * 1. An absolute path is taken as written.
 * 2. A relative path is resolved against the task's own `path` first, then each root. The task path
 *    matters: a run mapped at `apps/web/src/features` writes `ChunkSetPage.tsx:47`, and resolving
 *    that against the repository root finds nothing while the answer is entirely correct (issue #16).
 * 3. Failing both, one targeted search for files with that basename, kept only where the whole cited
 *    suffix matches at a segment boundary — so `agent-loop.ts` finds `src/llm/agent-loop.ts` and
 *    `pp.ts` still does not find `app.ts`.
 *
 * Containment is unchanged: every candidate goes through `assertWithinRoots`, so a path that escapes
 * the roots resolves to nothing however it was written.
 */

export interface ResolvedFile {
  /** Canonical absolute path. */
  path: string;
  lines: number;
}

export class FileResolver {
  /** Canonical path → line count, or null for "not a readable file inside the roots". */
  private readonly lineCache = new Map<string, number | null>();
  /** Candidate path → its canonical spelling, filled in alongside lineCache. */
  private readonly canonical = new Map<string, string>();
  /** Raw cited path → what it resolved to, so a repeated citation costs nothing. */
  private readonly resolved = new Map<string, ResolvedFile[]>();
  private readonly bases: string[];

  constructor(
    private readonly roots: string[],
    taskPath?: string
  ) {
    this.bases = taskPath ? [resolve(taskPath), ...roots] : [...roots];
  }

  /**
   * Every existing file the cited path could mean, nearest base first. An empty array is the only
   * conclusive answer this class gives: nothing under the roots is named that.
   */
  async candidates(rawPath: string): Promise<ResolvedFile[]> {
    const cached = this.resolved.get(rawPath);
    if (cached) return cached;

    const found = await this.lookUp(rawPath);
    this.resolved.set(rawPath, found);
    return found;
  }

  private async lookUp(rawPath: string): Promise<ResolvedFile[]> {
    if (isAbsolute(rawPath)) {
      const file = await this.describe(rawPath);
      return file ? [file] : [];
    }

    for (const base of this.bases) {
      const file = await this.describe(resolve(base, rawPath));
      if (file) return [file];
    }

    // Written short — `agent-loop.ts:107` rather than `src/llm/agent-loop.ts:107`. A short path is
    // a formatting slip, not a fabrication, and calling it "file not found" buries the citations
    // that really are wrong: one eval run flagged 49 of 68 correct citations that way.
    const segments = rawPath.split("/").filter(Boolean);
    const name = segments[segments.length - 1];
    if (!name) return [];

    const needle = sep + segments.join(sep);
    const matches = new Set<string>();
    for (const root of this.roots) {
      try {
        for (const match of await findFilesNamed(root, name)) {
          if (match.endsWith(needle)) matches.add(match);
        }
      } catch {
        // An unsearchable root simply contributes nothing.
      }
    }

    const files: ResolvedFile[] = [];
    for (const match of matches) {
      const file = await this.describe(match);
      if (file) files.push(file);
    }
    return files;
  }

  /**
   * The canonical path and its length, or null if it is not a readable file inside the roots.
   * Canonical because the coverage note compares these against the paths `read_file` recorded,
   * which are canonicalised the same way — two spellings of one file must compare equal.
   */
  private async describe(candidate: string): Promise<ResolvedFile | null> {
    const cached = this.lineCache.get(candidate);
    if (cached !== undefined) {
      return cached === null ? null : { path: this.canonical.get(candidate)!, lines: cached };
    }

    let lines: number | null = null;
    try {
      const canonical = assertWithinRoots(candidate, this.roots, { mustExist: true });
      lines = (await readFile(canonical, "utf-8")).split("\n").length;
      this.canonical.set(candidate, canonical);
    } catch {
      lines = null;
    }
    this.lineCache.set(candidate, lines);
    return lines === null ? null : { path: this.canonical.get(candidate)!, lines };
  }
}
