/**
 * Reading the shapes a model writes an answer in.
 *
 * The three server-side checks all have to find the same things in the same prose — code spans,
 * table cells, and the fenced blocks that must be left alone — and they were each finding them
 * differently. The citation checker read only inline `path:line` and so reported an answer whose
 * citations were all in table cells as citing nothing at all (issue #16).
 */

/** Fenced blocks hold examples and pasted output the model wrote itself. */
export const FENCED_BLOCK_RE = /```[\s\S]*?```/g;
export const INLINE_CODE_RE = /`([^`\n]+)`/g;

/**
 * The answer with fenced blocks removed. Replaced with a newline rather than a space so a fence
 * cannot join the line above it to the line below and let a looser pattern read across the gap.
 */
export function stripFences(text: string): string {
  return text.replace(FENCED_BLOCK_RE, "\n");
}

/** Contents of every inline code span, in order, duplicates included. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(INLINE_CODE_RE)].map((m) => m[1].trim());
}

/** Strip the markdown a model wraps a table cell in — backticks, bold, links. */
export function bareCell(cell: string): string {
  return cell
    .trim()
    .replace(/^[`*_]+|[`*_]+$/g, "")
    .replace(/^\[(.+)\]\(.*\)$/, "$1")
    .trim();
}

/**
 * Markdown table rows as arrays of undecorated cells. A row is any line containing a pipe, which
 * over-reads slightly — a sentence with a pipe in it becomes a one-cell row — and callers all
 * require at least two cells, so the over-read costs nothing.
 */
export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(bareCell).filter(Boolean);
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}
