import { basename, extname } from "node:path";

/**
 * Structure-aware chunker for markdown & plain text. No external deps. It splits a document on
 * ATX headings, then merges blank-line-separated paragraphs within each section up to a size
 * budget (with overlap), hard-splitting any single oversized block. Plain text simply flows
 * through the same paragraph path with no heading.
 *
 * The chunker is intentionally path-agnostic: it knows nothing about where the file lives. The
 * indexer composes the final embedding input (path context + heading + content) — see
 * `formatPathContext` below and `buildEmbedInput`.
 */

export interface Chunk {
  index: number;
  /** Heading path within the document, e.g. "Q3 Planning > Budget". Empty when none. */
  heading: string;
  /** Raw chunk text, stored and displayed unchanged. */
  content: string;
  /** 1-based approximate start line in the source file. */
  startLine: number;
}

export interface ChunkOptions {
  maxChars?: number; // default 1000
  overlap?: number; // default 150
}

const DEFAULT_MAX_CHARS = 1000;
const DEFAULT_OVERLAP = 150;

const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

interface Section {
  headingPath: string;
  startLine: number;
  body: string;
}

/**
 * Split markdown into sections by ATX headings, tracking the nesting path of headings so a
 * chunk carries its full "H1 > H2 > H3" context. Content before the first heading becomes a
 * leading headingless section.
 */
function splitIntoSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  // Stack of { level, title } describing the current heading path.
  const stack: Array<{ level: number; title: string }> = [];
  let buf: string[] = [];
  let sectionStartLine = 1;

  const headingPath = () => stack.map((h) => h.title).join(" > ");

  const flush = (endLine: number) => {
    const body = buf.join("\n").trim();
    if (body) {
      sections.push({ headingPath: headingPath(), startLine: sectionStartLine, body });
    }
    buf = [];
    sectionStartLine = endLine;
  };

  for (let i = 0; i < lines.length; i++) {
    const m = ATX_HEADING.exec(lines[i]);
    if (m) {
      flush(i + 1);
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      sectionStartLine = i + 1;
    } else {
      buf.push(lines[i]);
    }
  }
  flush(lines.length);

  return sections;
}

/** Hard-split a single oversized block into ~maxChars windows with `overlap` carryover. */
function windowSplit(text: string, maxChars: number, overlap: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, maxChars - overlap);
  for (let start = 0; start < text.length; start += step) {
    out.push(text.slice(start, start + maxChars));
    if (start + maxChars >= text.length) break;
  }
  return out;
}

/**
 * Pack a section's paragraphs into chunks no larger than maxChars. Paragraphs are merged
 * greedily; an oversized paragraph is window-split on its own.
 */
function packSection(body: string, maxChars: number, overlap: number): string[] {
  const paragraphs = body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      push();
      chunks.push(...windowSplit(para, maxChars, overlap));
      continue;
    }
    if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= maxChars) {
      current += "\n\n" + para;
    } else {
      push();
      current = para;
    }
  }
  push();

  return chunks;
}

/**
 * Chunk a document. `filePath` is used only to decide markdown vs. plain text by extension;
 * non-markdown is treated as one headingless section.
 */
export function chunkDocument(filePath: string, text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  const ext = extname(filePath).toLowerCase();
  const isMarkdown = ext === ".md" || ext === ".markdown";

  const sections: Section[] = isMarkdown
    ? splitIntoSections(text)
    : (() => {
        const body = text.trim();
        return body ? [{ headingPath: "", startLine: 1, body }] : [];
      })();

  const chunks: Chunk[] = [];
  let index = 0;
  for (const section of sections) {
    for (const content of packSection(section.body, maxChars, overlap)) {
      chunks.push({ index: index++, heading: section.headingPath, content, startLine: section.startLine });
    }
  }
  return chunks;
}

/**
 * Humanize a file's path-relative-to-watch-root into words an embedding model can latch onto:
 * drop the extension, split on path separators, turn `-`/`_` into spaces.
 * `projects/acme/meeting-notes.md` -> "projects / acme / meeting notes".
 */
export function formatPathContext(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const dir = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  const base = basename(normalized, extname(normalized));

  const humanize = (s: string) => s.replace(/[-_]+/g, " ").trim();

  const parts = dir
    .split("/")
    .filter(Boolean)
    .map(humanize)
    .filter(Boolean);
  parts.push(humanize(base));

  return parts.filter(Boolean).join(" / ");
}

/**
 * Compose the text actually sent to the embeddings endpoint: document location + in-document
 * heading + raw content. The path/heading prefix is *not* stored — only the raw `content` is.
 */
export function buildEmbedInput(relPath: string, heading: string, content: string): string {
  const lines = [`Source: ${formatPathContext(relPath)}`];
  if (heading) lines.push(`Section: ${heading}`);
  return `${lines.join("\n")}\n\n${content}`;
}
