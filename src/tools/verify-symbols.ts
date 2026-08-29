import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import {
  hasRipgrep,
  rgIgnoreArgs,
  grepIgnoreArgs,
  listAllFiles,
  IGNORED_DIRS,
  UNFILTERED_RG_ARGS,
} from "./explore-files.js";
import { codeSpans, stripFences } from "./answer-text.js";

/**
 * A small model is accurate about structure it actually read and confabulates the rest, and the
 * confabulations are usually *names* — a table, an env var, a constant that sounds right for the
 * codebase but exists nowhere in it (issue #13). Every one of those is decidable with one grep,
 * so the server does it before handing the answer back.
 *
 * The test is deliberately asymmetric, and only the "missing" half means anything:
 *
 * - zero hits anywhere in the tree → the model invented the name. No innocent reading.
 * - one or more hits → nothing is proven. Not that it is a table, not that it is an env var,
 *   not that the surrounding claim is true. A name in an unrelated comment passes.
 *
 * So this catches fabrications, not mistakes. It would not have caught the fourth error in
 * issue #13 ("all routes are `endpointFree`"), because that name is real and only the claim
 * about it was inverted.
 *
 * This reverses the call recorded in verify-citations.ts, which declined to match symbols on the
 * grounds that a wrong "unverified" tag is worse than no tag. It survives that objection only by
 * asking a much weaker question — "does this string occur at all" rather than "is this symbol at
 * this line" — and by being extremely picky about which tokens it asks it of. Everything below is
 * biased toward a false pass over a false warning.
 */

const execFileAsync = promisify(execFile);

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTERNAL_CASE_CHANGE_RE = /[a-z][A-Z]/;

/** Below this, a name is too generic for absence to mean anything ("id", "ok"). */
const MIN_SYMBOL_LENGTH = 4;
/** Bounds the argument list and the work; an answer naming more than this is not the common case. */
const MAX_SYMBOLS = 100;

/**
 * Budget for the Node backstop below. It only runs when a name is about to be called invented, so
 * in the ordinary run it costs nothing; these bound the pathological case.
 *
 * The per-file cap is the one filter this check tolerates. A name that occurs only inside a 4 MB
 * file is not a name an answer is describing, and refusing to conclude anything in every repository
 * that contains one lockfile would silence the check everywhere.
 */
const BACKSTOP_MAX_FILES = 20_000;
const BACKSTOP_MAX_BYTES = 128 * 1024 * 1024;
const BACKSTOP_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface SymbolCheck {
  symbol: string;
  found: boolean;
}

export interface SymbolReport {
  /** One per name actually decided. A name the checks could not settle is absent, not guessed at. */
  checks: SymbolCheck[];
  /** Distinct candidate names the answer held, before the MAX_SYMBOLS cap. */
  named: number;
}

/**
 * Identifier-shaped *and* distinctive. The second half is what keeps the check quiet: a token
 * has to carry an underscore or an internal case change to be worth searching for. That admits
 * `rka_corpus_reports`, `RACKORMI_ANALYSIS_PROMPT_VERSION` and `endpointFree` while rejecting
 * ordinary prose and generic names like `path` or `query`, which match in every tree and so
 * prove nothing when they do.
 */
export function isCandidate(token: string): boolean {
  if (token.length < MIN_SYMBOL_LENGTH) return false;
  if (!IDENTIFIER_RE.test(token)) return false;
  return token.includes("_") || INTERNAL_CASE_CHANGE_RE.test(token);
}

/** Distinctive identifiers named in inline code spans, in order of appearance, deduped. */
export function extractSymbols(text: string): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];

  // Fenced blocks hold examples the model wrote itself; searching them manufactures misses.
  for (const token of codeSpans(stripFences(text))) {
    if (!isCandidate(token) || seen.has(token)) continue;
    seen.add(token);
    symbols.push(token);
  }

  return symbols;
}

/**
 * One search per root for all names at once, rather than one per name.
 *
 * `--only-matching` makes stdout the set of names that matched, so a single pass answers
 * found-vs-missing for the whole list.
 *
 * Matching is a fixed-string substring search — no `--word-regexp` — and case-insensitive. Both
 * choices trade recall for safety, because the only outcome that costs anything here is warning
 * about a name that is really there. Substring lets `rka_corpus` match inside
 * `rka_corpus_reports`; case-insensitivity catches the camelCase concatenation, where an answer
 * naming `endpointFree` is describing a real `isEndpointFree` in the source. A fabricated name
 * survives both relaxations, which is the only thing this needs to detect.
 *
 * The one-pass result is a *lower bound*, never proof of absence: `--only-matching` reports one
 * match per position, so a short pattern shadows a longer one it prefixes. With case-insensitive
 * substring matching, `read_file` swallows `READ_FILE_SCHEMA` and the longer name never appears
 * in the output at all. Anything this pass does not find is therefore re-checked on its own by
 * confirmMissing below, where nothing can shadow it.
 *
 * Returns null when the search could not be trusted to be complete, which suppresses the whole
 * report. A truncated search would read as a list of missing names, and inventing a warning is
 * the one failure mode this check cannot afford.
 */
async function searchRoot(symbols: string[], root: string, useRg: boolean): Promise<string | null> {
  const args = useRg
    ? [
        "--fixed-strings",
        "--ignore-case",
        "--only-matching",
        "--no-filename",
        "--no-messages",
        ...rgIgnoreArgs(IGNORED_DIRS),
      ]
    : ["-r", "-o", "-h", "-I", "-F", "-i", "--no-messages", ...grepIgnoreArgs(IGNORED_DIRS)];

  for (const symbol of symbols) {
    args.push("-e", symbol);
  }
  args.push("--", root);

  try {
    const { stdout } = await execFileAsync(useRg ? "rg" : "grep", args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    // Exit 1 is "no matches" — a real, complete answer: every name is missing.
    if (e.code === 1) return e.stdout ?? "";
    // Exit 2 with output means some paths failed but the search still ran (e.g. an unreadable
    // directory). Partial output would understate what exists, so treat it as inconclusive.
    return null;
  }
}

/**
 * Lowercased names present somewhere under the roots, or null if any root's search was
 * inconclusive. Lowercased because the search is case-insensitive, so `--only-matching` emits
 * the casing found in the source rather than the casing that was asked for.
 */
async function findPresent(symbols: string[], roots: string[]): Promise<Set<string> | null> {
  const useRg = await hasRipgrep();
  const present = new Set<string>();

  for (const root of roots) {
    const stdout = await searchRoot(symbols, root, useRg);
    // One unusable root is enough to bail: a name could live in exactly the tree that failed.
    if (stdout === null) return null;
    for (const line of stdout.split("\n")) {
      const token = line.trim().toLowerCase();
      if (token) present.add(token);
    }
  }

  return present;
}

/**
 * Second opinion on one name, searched alone so no other pattern can shadow it — and searched
 * *unfiltered*, which is the part that matters.
 *
 * The bulk pass runs at ripgrep's defaults, which skip gitignored and hidden files. `buildTree`
 * hands the model a map built by walking the filesystem, and `Read` opens anything under the roots,
 * so an answer can correctly describe a file that no default rg search can see. Issue #17 is what
 * that costs: seven real names, one of them with 122 occurrences, reported as appearing nowhere in
 * the tree. This step used to re-run the same filtered search, so it confirmed the miss instead of
 * catching it.
 *
 * grep needs no widening — it never applied .gitignore or hidden-file filtering in the first place.
 */
async function existsAlone(symbol: string, roots: string[], useRg: boolean): Promise<boolean> {
  for (const root of roots) {
    const args = useRg
      ? ["--fixed-strings", "--ignore-case", "--quiet", ...UNFILTERED_RG_ARGS, ...rgIgnoreArgs(IGNORED_DIRS)]
      : ["-r", "-I", "-F", "-i", "-q", "--no-messages", ...grepIgnoreArgs(IGNORED_DIRS)];
    args.push("--", symbol, root);
    try {
      await execFileAsync(useRg ? "rg" : "grep", args, { maxBuffer: 1024 });
      return true; // exit 0 — found
    } catch (err) {
      // Exit 1 is a clean "not in this root"; anything else is an unusable answer, and an
      // unusable answer must not become a warning.
      if ((err as { code?: number }).code !== 1) return true;
    }
  }
  return false;
}

/**
 * The backstop: read the tree in-process and look for the names ourselves.
 *
 * Reached only by a name that two searches failed to find — the handful about to be reported as
 * fabricated — so its cost is paid in the case that actually matters and nowhere else. It exists
 * because issue #17 arrived from a private repository whose exact trigger cannot be replayed: the
 * gitignore/hidden gap above is a confirmed cause, but a fix that assumes it is the *only* one is a
 * guess. This depends on no external tool and no flag semantics, so it closes the class.
 *
 * `conclusive` is false when the budget ran out before every remaining name was found. A name left
 * undecided is dropped from the report rather than warned about — the report may be incomplete, but
 * it must never be wrong.
 */
async function scanTree(
  symbols: string[],
  roots: string[]
): Promise<{ present: Set<string>; conclusive: boolean }> {
  const needles = symbols.map((s) => s.toLowerCase());
  const present = new Set<string>();
  let files = 0;
  let bytes = 0;

  for (const root of roots) {
    let paths: string[];
    try {
      paths = await listAllFiles(root, BACKSTOP_MAX_FILES);
    } catch {
      return { present, conclusive: false };
    }
    // A full listing may itself have been truncated, and the name could be in what was cut.
    if (paths.length >= BACKSTOP_MAX_FILES) return { present, conclusive: false };

    for (const path of paths) {
      if (present.size === needles.length) return { present, conclusive: true };
      if (files >= BACKSTOP_MAX_FILES || bytes >= BACKSTOP_MAX_BYTES) {
        return { present, conclusive: false };
      }
      let text: string;
      try {
        const info = await stat(path);
        if (info.size > BACKSTOP_MAX_FILE_BYTES) continue;
        text = (await readFile(path, "utf-8")).toLowerCase();
      } catch {
        continue; // unreadable or not valid UTF-8; neither is evidence of absence
      }
      files += 1;
      bytes += text.length;
      for (const needle of needles) {
        if (!present.has(needle) && text.includes(needle)) present.add(needle);
      }
    }
  }

  return { present, conclusive: true };
}

/**
 * Three passes, each strictly wider than the last, and a name only reaches the footer once all
 * three have failed to find it. Every pass but the first runs on the leftovers of the one before,
 * so the ordinary answer — where every name is real — costs exactly one search.
 */
export async function verifySymbols(text: string, roots: string[]): Promise<SymbolReport> {
  const named = extractSymbols(text);
  const symbols = named.slice(0, MAX_SYMBOLS);
  if (symbols.length === 0) return { checks: [], named: named.length };

  const present = await findPresent(symbols, roots);
  if (present === null) return { checks: [], named: named.length };

  const useRg = await hasRipgrep();
  // symbol -> found, or absent for "no pass could settle it". Filled in over three rounds and read
  // back in the answer's own order, so the report lists names as the reader met them.
  const verdicts = new Map<string, boolean>();
  const unresolved: string[] = [];

  for (const symbol of symbols) {
    // A hit in the bulk pass is conclusive; a miss is not — it ran filtered, and it shadows a
    // longer name behind a shorter one it prefixes — so re-check it alone and unfiltered.
    if (present.has(symbol.toLowerCase()) || (await existsAlone(symbol, roots, useRg))) {
      verdicts.set(symbol, true);
    } else {
      unresolved.push(symbol);
    }
  }

  if (unresolved.length > 0) {
    const { present: seen, conclusive } = await scanTree(unresolved, roots);
    for (const symbol of unresolved) {
      if (seen.has(symbol.toLowerCase())) verdicts.set(symbol, true);
      // Undecided, not absent: say nothing about it at all rather than count it either way.
      else if (conclusive) verdicts.set(symbol, false);
    }
  }

  const checks: SymbolCheck[] = [];
  for (const symbol of symbols) {
    const found = verdicts.get(symbol);
    if (found !== undefined) checks.push({ symbol, found });
  }

  return { checks, named: named.length };
}

/**
 * One line for the caller, and only when there is something to say. A clean run stays silent:
 * the answer already carries a Citations: line, and a second all-clear on every response is the
 * kind of noise that gets both of them skipped.
 *
 * The line states its own coverage and its own matcher. Issue #17 read a footer saying
 * "60 names checked" and took it for a count; 60 is the cap, and the answer had named more. A
 * checker that will not say what it looked at cannot be argued with when it is wrong.
 */
export function formatSymbolReport(report: SymbolReport): string {
  const { checks, named } = report;
  const missing = checks.filter((c) => !c.found);
  if (missing.length === 0) return "";

  const capped = named > checks.length;
  const label = capped
    ? `${checks.length} of ${named} names checked`
    : `${checks.length} name${checks.length === 1 ? "" : "s"} checked`;
  const verb = missing.length === 1 ? "does" : "do";
  const names = missing.map((c) => `\`${c.symbol}\``).join(", ");

  return `_Symbols: ${label}. This check is a substring match, case-insensitive, across every file under the allowed roots. **${missing.length} ${verb} not appear anywhere in the tree**: ${names}. Treat the claims that name them as unverified._`;
}
