import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, formatPathContext, buildEmbedInput } from "./chunk.js";

test("markdown splits on headings and carries the heading path", () => {
  const md = [
    "intro paragraph",
    "",
    "# Q3 Planning",
    "",
    "some planning text",
    "",
    "## Budget",
    "",
    "budget details here",
  ].join("\n");

  const chunks = chunkDocument("notes.md", md);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].heading, "");
  assert.equal(chunks[0].content, "intro paragraph");
  assert.equal(chunks[1].heading, "Q3 Planning");
  assert.equal(chunks[2].heading, "Q3 Planning > Budget");
  assert.equal(chunks[2].content, "budget details here");
  // indexes are sequential
  assert.deepEqual(chunks.map((c) => c.index), [0, 1, 2]);
});

test("plain text is one headingless section", () => {
  const chunks = chunkDocument("note.txt", "# not a heading in txt\n\njust text");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "");
  assert.ok(chunks[0].content.includes("# not a heading in txt"));
});

test("paragraphs merge up to maxChars", () => {
  const md = "aaa\n\nbbb\n\nccc";
  const chunks = chunkDocument("x.md", md, { maxChars: 100, overlap: 0 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, "aaa\n\nbbb\n\nccc");
});

test("oversized block is hard-split with overlap", () => {
  const para = "x".repeat(2500);
  const chunks = chunkDocument("x.md", para, { maxChars: 1000, overlap: 150 });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.content.length <= 1000);
  // overlap: consecutive windows share their boundary characters
  const step = 1000 - 150;
  assert.equal(chunks[1].content[0], para[step]);
});

test("empty document yields no chunks", () => {
  assert.equal(chunkDocument("x.md", "   \n\n  ").length, 0);
});

test("formatPathContext humanizes directories and filename", () => {
  assert.equal(
    formatPathContext("projects/acme/meeting-notes.md"),
    "projects / acme / meeting notes"
  );
  assert.equal(formatPathContext("ideas.txt"), "ideas");
  assert.equal(formatPathContext("a_b/c-d/e_f-g.markdown"), "a b / c d / e f g");
});

test("buildEmbedInput includes path and heading, omits empty heading", () => {
  const withHeading = buildEmbedInput("docs/guide.md", "Setup > Install", "run npm i");
  assert.equal(withHeading, "Source: docs / guide\nSection: Setup > Install\n\nrun npm i");

  const noHeading = buildEmbedInput("docs/guide.md", "", "body");
  assert.equal(noHeading, "Source: docs / guide\n\nbody");
});
