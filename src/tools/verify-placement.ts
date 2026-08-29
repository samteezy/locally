import { FileResolver } from "./resolve-path.js";
import { readCitationBlock, inlineCitations, type Citation } from "./verify-citations.js";
import { isCandidate } from "./verify-symbols.js";
import { codeSpans, stripFences } from "./answer-text.js";

/**
 * The answer named a distinctive identifier and a `path:line` as one assertion. That file really
 * does contain that identifier — but only a long way from the line cited.
 *
 * That is the whole question, and the narrowness is what makes it safe. Issue #17's footer found
 * nothing wrong with an answer that cited `widgetRollupSchema` at `moduleA.ts:130` when the symbol
 * lives at 199: line 130 exists, so `verify-citations.ts` passed it, and the name exists, so
 * `verify-symbols.ts` passed it too. Neither check relates the two, and the error lives exactly in
 * the relation.
 *
 * This reverses the standing decision in verify-citations.ts (line 11) not to match a symbol
 * against its cited line — "that needs a parser per language, and a wrong 'unverified' tag on a
 * correct citation is worse than no tag at all". It survives that objection the same way
 * verify-symbols.ts survived it: by asking a much weaker question. Not "is this symbol declared at
 * this line", which needs the parser, but "does this file mention this name anywhere near here",
 * which needs no grammar at all.
 *
 * **The load-bearing rule: a symbol absent from its cited file makes this check silent, always.**
 * One rule absorbs call sites, re-exports, imports, barrel files, behavioural claims, misspellings
 * and every cross-file relationship — the whole population that verify-symbols.ts already owns or
 * that nothing can safely own. What is left is only the "right file, wrong line" residue, where the
 * cited file has already vouched for the name and only the number is in dispute.
 *
 * Measured before shipping, over the four answers in `eval-runs/` whose commit is recorded — two
 * from locally and two from the native Explore agent, each resolved against its own commit rather
 * than against HEAD, so line drift cannot manufacture a result:
 *
 * - **0 fires on 36 decided pairs.** The widest gap any correct citation showed was 20 lines,
 *   against a floor of 30 — and that is measured before the structural window widens it further.
 * - **19 of 24 caught** when every citation in the same corpus is shifted 70 lines, the shape of
 *   issue #17's Error A. A check that never fires is not a check, and this is the evidence that it
 *   is not one.
 *
 * The same corpus contains five citations naming `LOCALY_CONFIG` and friends (one `L`) against
 * perfectly correct line numbers. The absent-from-file rule silences all five; without it this
 * would have emitted five warnings about five correct claims, which is issue #17 happening again
 * inside its own fix.
 *
 * It is blind to line errors under about 35 lines. That is the price of the window below, and it is
 * the right price: this catches the class, it does not solve it.
 */

/** Bounds the work. Each pair can cost a file read, though the resolver has usually cached it. */
const MAX_PAIRS = 40;

/**
 * The floor on the window, in lines above and below.
 *
 * Chosen by measurement, not intuition. Across the `eval-runs/` corpus the widest gap between a
 * correct citation and its symbol's nearest occurrence is 20 lines, so 30 clears every real answer
 * available with ten lines to spare — and the structural window above only widens from there. Below
 * about 35 lines this check is blind, which is the cost of that clearance and the reason it is
 * described as catching a class rather than solving it.
 */
const WINDOW_FLOOR = 30;

/** However much structure says, the window stops here on each side. */
const MAX_WINDOW_REACH = 200;

/** Past this the name is too common in the file for its absence from a window to mean anything. */
const MAX_OCCURRENCES = 20;

/** A file this long is not one a model is citing a line of. */
const MAX_FILE_LINES = 20_000;

/** A range covering this much of its file is the "I mean this file" idiom, not a line claim. */
const WHOLE_FILE_RATIO = 0.6;

/** Below this a file is too short for its blank-line ratio to say anything about generation. */
const MIN_LINES_FOR_SHAPE_TEST = 50;

const COMMENT_RE = /^\s*(\/\/|\/\*|\*|#)/;
const LIKELY_RE = /\bLIKELY:/;
const NOTE_TOKEN_RE = /[^A-Za-z0-9_]+/;

export interface PlacementPair {
  symbol: string;
  citation: Citation;
  /** `path:line`, the spelling the footer and the skip set both use. */
  label: string;
}

export interface PlacementCheck {
  symbol: string;
  label: string;
  agrees: boolean;
  /** The occurrence nearest the cited line, when the answer and the file disagree. */
  nearestLine?: number;
}

export interface PlacementReport {
  /** One per pair actually decided. A pair the rules declined to judge is absent, not guessed at. */
  checks: PlacementCheck[];
  /** Pairs the answer stated, before the MAX_PAIRS cap. */
  named: number;
}

function citationLabel(c: Citation): string {
  return c.endLine ? `${c.path}:${c.line}-${c.endLine}` : `${c.path}:${c.line}`;
}

/**
 * The first distinctive token of a citation-block note — "`widgetRollupSchema` definition" gives
 * `widgetRollupSchema`.
 *
 * At most one, and the first, on purpose. A note's leading distinctive token is the subject being
 * located; the ones after it are context — "…built from `LocallyConfig`", "…read by
 * `symbolCheckEnabled`" — whose own locations are elsewhere *by design*. Checking those is exactly
 * the invented-relationship trap, approached from the other side.
 *
 * Bare tokens count here, where they would not in prose, because a block entry is a structured
 * assertion rather than a sentence.
 */
function noteSubject(note: string): string | null {
  for (const token of note.split(NOTE_TOKEN_RE)) {
    if (isCandidate(token)) return token;
  }
  return null;
}

/**
 * Every place the answer put a name and a location together, from the two shapes where that pairing
 * is unambiguous.
 *
 * The `<citations>` block is the primary source: one path, one line, one note, co-asserted about
 * one thing by construction, and the explore contract already asks for it. The secondary source is
 * a single line of prose or a table row carrying exactly one citation and exactly one backticked
 * distinctive name — which is what issue #17's own run produced, since it predates the block.
 *
 * Everything ambiguous yields no pair at all: two candidate names on a line, two citations on a
 * line, a hedged claim. A pairing this check cannot be sure of is a pairing it must not warn about.
 */
export function extractPairs(text: string): PlacementPair[] {
  const pairs: PlacementPair[] = [];
  const seen = new Set<string>();

  const add = (symbol: string, citation: Citation): void => {
    const label = citationLabel(citation);
    const key = `${symbol}@${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ symbol, citation, label });
  };

  for (const entry of readCitationBlock(text) ?? []) {
    if (!entry.note || LIKELY_RE.test(entry.note)) continue;
    const symbol = noteSubject(entry.note);
    if (symbol) add(symbol, entry);
  }

  for (const line of stripFences(text).split("\n")) {
    if (LIKELY_RE.test(line)) continue;
    const cited = inlineCitations(line);
    if (cited.length !== 1) continue;
    const candidates = [...new Set(codeSpans(line).filter(isCandidate))];
    if (candidates.length !== 1) continue;
    add(candidates[0], cited[0]);
  }

  return pairs;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * A file whose shape says it was generated rather than written. Its blank lines mean nothing, which
 * would make the structural window below degenerate, and nobody cites a line of it by hand.
 */
function looksGenerated(lines: string[]): boolean {
  if (lines.slice(0, 5).some((l) => l.includes("@generated"))) return true;
  if (lines.length < MIN_LINES_FOR_SHAPE_TEST) return false;
  const blanks = lines.filter((l) => l.trim() === "").length;
  if (blanks / lines.length < 0.02) return true;
  const total = lines.reduce((n, l) => n + l.length, 0);
  return total / lines.length > 200;
}

/**
 * How far from the cited line a match still counts, taken from the file's own structure rather than
 * a flat count.
 *
 * Up: to the top of the paragraph, then across any blank lines to absorb a contiguous comment
 * header — the JSDoc case, which in this repository runs to twenty lines and more. Down: to the
 * bottom of the paragraph, then onward while lines are blank or more deeply indented, which absorbs
 * the body of the function or block whose `export` line was cited.
 *
 * Then widened to the floor, and finally clamped: structure must not run away in a file that has
 * neither blank lines nor indentation.
 */
export function placementWindow(lines: string[], start: number, end: number): [number, number] {
  let top = start;
  while (top > 1 && lines[top - 2].trim() !== "") top -= 1;

  let probe = top - 1;
  while (probe >= 1 && lines[probe - 1].trim() === "") probe -= 1;
  if (probe >= 1 && COMMENT_RE.test(lines[probe - 1])) {
    while (probe >= 1 && (COMMENT_RE.test(lines[probe - 1]) || lines[probe - 1].trim() === "")) probe -= 1;
    top = probe + 1;
  }

  let bottom = end;
  const baseIndent = indentOf(lines[start - 1] ?? "");
  while (bottom < lines.length && lines[bottom].trim() !== "") bottom += 1;
  while (bottom < lines.length && (lines[bottom].trim() === "" || indentOf(lines[bottom]) > baseIndent)) {
    bottom += 1;
  }

  top = Math.max(1, Math.min(top, start - WINDOW_FLOOR), start - MAX_WINDOW_REACH);
  bottom = Math.min(lines.length, Math.max(bottom, end + WINDOW_FLOOR), end + MAX_WINDOW_REACH);
  return [Math.max(1, top), bottom];
}

/**
 * @param skip citations another check already reported, so one bad citation is named once.
 * @param resolver shared with the citation and path checks, which have already read these files.
 */
export async function verifyPlacement(
  text: string,
  roots: string[],
  taskPath?: string,
  skip?: ReadonlySet<string>,
  resolver: FileResolver = new FileResolver(roots, taskPath)
): Promise<PlacementReport> {
  const named = extractPairs(text);
  const checks: PlacementCheck[] = [];

  for (const pair of named.slice(0, MAX_PAIRS)) {
    if (skip?.has(pair.label)) continue;

    // Line 1 is the "I mean this file" idiom, and a range covering most of a file is the same
    // gesture written longer. Neither is a claim about a line.
    const { line, endLine } = pair.citation;
    if (line <= 1) continue;

    let lines: string[] | null;
    try {
      lines = await resolver.lines(pair.citation.path);
    } catch {
      continue; // an unusable read is not evidence of anything
    }
    if (!lines || lines.length > MAX_FILE_LINES) continue;

    const end = Math.min(endLine ?? line, lines.length);
    if (line > lines.length) continue; // out of range; the citation check owns that
    if ((end - line + 1) / lines.length >= WHOLE_FILE_RATIO) continue;
    if (looksGenerated(lines)) continue;

    // Substring and case-insensitive, the same relaxations verify-symbols.ts argues for: every one
    // of them can only turn a warning back into a pass.
    const needle = pair.symbol.toLowerCase();
    const at: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) at.push(i + 1);
    }

    // The load-bearing rule. The file has to vouch for the name before its line number can be
    // doubted; absent, this is a claim about somewhere else and none of our business.
    if (at.length === 0 || at.length > MAX_OCCURRENCES) continue;

    const [top, bottom] = placementWindow(lines, line, end);
    if (at.some((n) => n >= top && n <= bottom)) {
      checks.push({ symbol: pair.symbol, label: pair.label, agrees: true });
      continue;
    }

    const nearest = at.reduce((best, n) => (Math.abs(n - line) < Math.abs(best - line) ? n : best), at[0]);
    checks.push({ symbol: pair.symbol, label: pair.label, agrees: false, nearestLine: nearest });
  }

  return { checks, named: named.length };
}

/**
 * One line, and only on a miss — the rule its three siblings follow.
 *
 * It says the file is right out loud, so the caller does not read this as a second existence
 * failure, and it gives the line the name actually sits on. Doing the work in Node rather than
 * shelling out is what makes that last part possible, and it is the difference between a warning
 * the caller can act on and one that only tells them to look again.
 */
export function formatPlacementReport(report: PlacementReport): string {
  const { checks, named } = report;
  const wrong = checks.filter((c) => !c.agrees);
  if (wrong.length === 0) return "";

  const label =
    named > checks.length
      ? `${checks.length} of ${named} symbol/line pairs checked`
      : `${checks.length} symbol/line pair${checks.length === 1 ? "" : "s"} checked`;

  if (wrong.length === 1) {
    const c = wrong[0];
    return `_Placement: ${label}, **1 names a symbol that its cited file keeps elsewhere** — \`${c.symbol}\` is cited at \`${c.label}\`, but the nearest occurrence in that file is line ${c.nearestLine}. The file is right and the line is not; re-check it before trusting the claim._`;
  }

  const misses = wrong
    .map((c) => `\`${c.symbol}\` cited at \`${c.label}\`, nearest occurrence line ${c.nearestLine}`)
    .join("; ");
  return `_Placement: ${label}, **${wrong.length} name symbols their cited files keep elsewhere** — ${misses}. The files are right and the lines are not; re-check them before trusting the claims._`;
}
