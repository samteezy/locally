import { FileResolver, type ResolvedFile } from "./resolve-path.js";
import { stripFences, tableRows } from "./answer-text.js";

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
 *
 * Both halves of that bargain failed in issue #16 — one run's citations were not read at all
 * (they were in table cells) and another's were all called missing (they were bare basenames from
 * a mapped subdirectory). Extraction below therefore reads four forms, and resolution is handled
 * by FileResolver, which tries the task's own path before the roots.
 */

/**
 * A path-looking token with a real extension.
 *
 * The lookbehind rejects any candidate preceded by a word character, `:` or `/`, which
 * is what keeps URLs out: in `https://example.com:8080` every possible starting point is
 * preceded by one of those. It also drops version strings like `v1.2:3`, since the
 * extension must begin with a letter.
 */
const PATH_TOKEN = String.raw`(?<![\w:/])(\/?(?:[\w.@+~-]+\/)*[\w.@+~-]+\.[A-Za-z][\w]*)`;

/** `src/app.ts:12`, and the range form `src/app.ts:12-40`. */
const CITATION_RE = new RegExp(`${PATH_TOKEN}:(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, "g");

/**
 * A path and a line number written apart from each other: `src/app.ts … lines 26-450`. Bounded to
 * one line and a short gap, so a path in one sentence cannot capture a number from the next.
 */
const PROSE_RANGE_RE = new RegExp(`${PATH_TOKEN}[^\\n]{0,40}?\\blines?\\s+(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, "g");

/** A cell holding a line number and nothing else — `47`, `26-450`, `lines 26-450`. */
const LINE_CELL_RE = /^(?:lines?\s+)?(\d+)(?:\s*[-–]\s*(\d+))?$/i;

/** A cell holding a path and nothing else, once markdown decoration is stripped. */
const PATH_CELL_RE = /^\/?(?:[\w.@+~-]+\/)*[\w.@+~-]+\.[A-Za-z][\w]*$/;

/**
 * The answer's own citation block.
 *
 * Everything else in this file reverse-engineers where a model put its locations, across four
 * shapes, because we never asked for one. Asking for a block makes the common case exact instead of
 * inferred, and the heuristics stay as the fallback for a model that ignores the instruction.
 *
 * `<final_answer>` is accepted as the same thing: it is what models trained against the FastContext
 * exploration harness emit, and one alternation here is the entire cost of running one of them.
 */
const CITATION_BLOCK_RE = /<(citations|final_answer)>([\s\S]*?)<\/\1>/i;

/** `src/app.ts:12`, `src/app.ts:12-40`, either optionally followed by a note. One per line. */
const BLOCK_ENTRY_RE = /^\s*[-*]?\s*`?(\S+?)`?:(\d+)(?:\s*[-–]\s*(\d+))?`?\s*(.*)$/;

export interface Citation {
  path: string;
  line: number;
  /** Present for a range citation; the last line claimed. */
  endLine?: number;
}

export interface CitationCheck {
  citation: string;
  ok: boolean;
  reason?: string;
  /** Canonical path this citation resolved to, when it resolved to exactly one file. */
  resolvedPath?: string;
}

function citationLabel(c: Citation): string {
  return c.endLine ? `${c.path}:${c.line}-${c.endLine}` : `${c.path}:${c.line}`;
}

/**
 * Rows of a markdown table that pair a path cell with a line-number cell.
 *
 * Issue #16's run A wrote every one of its citations this way — a two-column `| File | Line |`
 * table — and the inline-only extractor read none of them, so a heavily-cited answer was reported
 * as naming no location at all. Requiring the number cell to hold *nothing but* a number is what
 * stops a "12 tables" column from manufacturing citations out of a summary table.
 */
function tableCitations(text: string): Citation[] {
  const found: Citation[] = [];

  for (const cells of tableRows(text)) {
    const paths = cells.filter((c) => PATH_CELL_RE.test(c));
    if (paths.length !== 1) continue;

    for (const cell of cells) {
      const m = LINE_CELL_RE.exec(cell);
      if (!m) continue;
      found.push({ path: paths[0], line: Number(m[1]), ...(m[2] ? { endLine: Number(m[2]) } : {}) });
      break;
    }
  }

  return found;
}

function matchCitations(text: string, re: RegExp): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(re)) {
    const [, path, start, end] = match;
    found.push({ path, line: Number(start), ...(end ? { endLine: Number(end) } : {}) });
  }
  return found;
}

/**
 * Every location the answer names, in the four forms a model actually writes them: inline
 * `path:line`, inline `path:start-end`, a markdown table row, and prose ("…, lines 26-450").
 *
 * Only the inline forms are read inside fenced blocks. Inline `path:line` inside a fence is almost
 * always a real citation pasted from tool output; a bare path near a number is not, so the looser
 * two forms stay outside.
 */
/**
 * Citations the answer stated outright, or null when it wrote no block. Entries that are not
 * `path:line` shaped are skipped rather than guessed at — a block with prose in it should degrade
 * to "these lines parsed", not to a manufactured citation.
 */
export function readCitationBlock(text: string): Citation[] | null {
  const block = CITATION_BLOCK_RE.exec(text);
  if (!block) return null;

  const found: Citation[] = [];
  for (const line of block[2].split("\n")) {
    const m = BLOCK_ENTRY_RE.exec(line);
    if (!m) continue;
    found.push({ path: m[1], line: Number(m[2]), ...(m[3] ? { endLine: Number(m[3]) } : {}) });
  }
  return found;
}

/**
 * Replace the block with the same citations as ordinary markdown, so the caller reads an answer
 * rather than a tagged one. Returns the text unchanged when there is no block.
 */
export function renderCitationBlock(text: string): string {
  const block = CITATION_BLOCK_RE.exec(text);
  if (!block) return text;

  const rows: string[] = [];
  for (const line of block[2].split("\n")) {
    const m = BLOCK_ENTRY_RE.exec(line);
    if (!m) continue;
    const range = m[3] ? `${m[2]}-${m[3]}` : m[2];
    const note = m[4]?.trim();
    rows.push(`- \`${m[1]}:${range}\`${note ? ` — ${note}` : ""}`);
  }

  const rendered = rows.length > 0 ? `**Citations**\n\n${rows.join("\n")}` : "";
  return `${text.slice(0, block.index)}${rendered}${text.slice(block.index + block[0].length)}`.trim();
}

export function extractCitations(text: string): Citation[] {
  // An explicit block is the answer telling us where it looked; take it at its word rather than
  // also scanning the prose, which would re-add the guessing the block exists to remove.
  const stated = readCitationBlock(text);
  if (stated) return dedupe(stated);

  const prose = stripFences(text);

  const all = [
    ...matchCitations(text, CITATION_RE),
    ...tableCitations(prose),
    ...matchCitations(prose, PROSE_RANGE_RE),
  ];

  return dedupe(all);
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const unique: Citation[] = [];
  for (const c of citations) {
    const key = citationLabel(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  return unique;
}

function inRange(c: Citation, file: ResolvedFile): boolean {
  const last = c.endLine ?? c.line;
  return c.line >= 1 && c.line <= last && last <= file.lines;
}

async function checkOne(c: Citation, resolver: FileResolver): Promise<CitationCheck> {
  const citation = citationLabel(c);
  const files = await resolver.candidates(c.path);

  if (files.length === 0) return { citation, ok: false, reason: "file not found" };

  // With several files sharing a name there is no way to tell which was meant, so accept the
  // citation if the line lands in any of them — silence beats a warning we cannot stand behind.
  const hit = files.find((f) => inRange(c, f));
  if (hit) return { citation, ok: true, resolvedPath: hit.path };

  const reason = files.length === 1 ? `file has ${files[0].lines} lines` : "line out of range";
  return { citation, ok: false, reason, ...(files.length === 1 ? { resolvedPath: files[0].path } : {}) };
}

/**
 * @param taskPath the directory the caller asked to be mapped, tried before the roots when a
 * relative citation is resolved.
 */
export async function verifyCitations(
  text: string,
  roots: string[],
  taskPath?: string
): Promise<CitationCheck[]> {
  const resolver = new FileResolver(roots, taskPath);
  const checks: CitationCheck[] = [];
  for (const citation of extractCitations(text)) {
    checks.push(await checkOne(citation, resolver));
  }
  return checks;
}

/**
 * One-line summary for the caller.
 *
 * "I could not parse any citations" and "I parsed citations and they are wrong" are different
 * messages and used to read the same (issue #16). The empty case now reports on the *checker* —
 * it found nothing it could read — rather than asserting the answer names no location, which was
 * false for an answer whose citations were all in table cells. Failures are grouped by kind for
 * the same reason: an invented file and a number two lines past the end are not the same problem.
 */
export function formatCitationReport(checks: CitationCheck[]): string {
  if (checks.length === 0) {
    return "_Citations: **none parsed** — no path:line, path:start-end, prose line reference, or File/Line table row was found, so nothing in this answer was checked against the filesystem._";
  }

  const bad = checks.filter((c) => !c.ok);
  const label = `${checks.length} citation${checks.length === 1 ? "" : "s"} checked`;

  if (bad.length === 0) {
    return `_Citations: ${label}, all resolve to a real file and line._`;
  }

  const missing = bad.filter((c) => c.reason === "file not found");
  const outOfRange = bad.filter((c) => c.reason !== "file not found");
  const groups: string[] = [];
  if (missing.length > 0) {
    const phrase =
      missing.length === 1 ? "1 names a file that does not exist" : `${missing.length} name files that do not exist`;
    groups.push(`**${phrase}** — ${missing.map((c) => c.citation).join("; ")}`);
  }
  if (outOfRange.length > 0) {
    const phrase =
      outOfRange.length === 1 ? "1 points past the end of its file" : `${outOfRange.length} point past the end of their file`;
    groups.push(`**${phrase}** — ${outOfRange.map((c) => `${c.citation} (${c.reason})`).join("; ")}`);
  }

  return `_Citations: ${label}, ${groups.join(", and ")}. Treat the surrounding claims as unverified._`;
}
