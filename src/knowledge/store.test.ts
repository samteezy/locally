import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, type ChunkInput } from "./store.js";

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "locally-store-"));
  return { path: join(dir, "knowledge.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function chunk(content: string, embedding: number[], i = 0): ChunkInput {
  return { relPath: "notes/a.md", chunkIndex: i, heading: "H", content, startLine: 1, embedding };
}

test("upsert then search returns the nearest chunk", () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const store = KnowledgeStore.open(path);
    store.upsertFile("/abs/notes/a.md", "/abs", "notes/a.md", { mtimeMs: 1, size: 10, hash: "h1" }, [
      chunk("apples", [1, 0, 0, 0], 0),
      chunk("oranges", [0, 1, 0, 0], 1),
    ]);

    const res = store.search([0.9, 0.1, 0, 0], 1);
    assert.equal(res.length, 1);
    assert.equal(res[0].content, "apples");
    assert.equal(res[0].relPath, "notes/a.md");
    assert.equal(res[0].filePath, "/abs/notes/a.md");
    assert.equal(store.dimensions, 4);
    store.close();
  } finally {
    cleanup();
  }
});

test("re-upsert replaces previous chunks (no duplicates)", () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const store = KnowledgeStore.open(path);
    const meta = { mtimeMs: 1, size: 10, hash: "h1" };
    store.upsertFile("/abs/a.md", "/abs", "a.md", meta, [chunk("v1", [1, 0, 0, 0])]);
    store.upsertFile("/abs/a.md", "/abs", "a.md", { ...meta, hash: "h2" }, [chunk("v2", [1, 0, 0, 0])]);

    assert.equal(store.getStats().chunks, 1);
    assert.equal(store.search([1, 0, 0, 0], 5)[0].content, "v2");
    store.close();
  } finally {
    cleanup();
  }
});

test("deleteFile removes chunks and vectors", () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const store = KnowledgeStore.open(path);
    store.upsertFile("/abs/a.md", "/abs", "a.md", { mtimeMs: 1, size: 1, hash: "h" }, [
      chunk("gone", [1, 0, 0, 0]),
    ]);
    store.deleteFile("/abs/a.md");

    const stats = store.getStats();
    assert.equal(stats.files, 0);
    assert.equal(stats.chunks, 0);
    assert.equal(store.search([1, 0, 0, 0], 5).length, 0);
    store.close();
  } finally {
    cleanup();
  }
});

test("getFileMeta round-trips for incremental skip", () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const store = KnowledgeStore.open(path);
    assert.equal(store.getFileMeta("/abs/a.md"), null);
    store.upsertFile("/abs/a.md", "/abs", "a.md", { mtimeMs: 42, size: 99, hash: "abc" }, [
      chunk("x", [1, 0, 0, 0]),
    ]);
    assert.deepEqual({ ...store.getFileMeta("/abs/a.md") }, { mtimeMs: 42, size: 99, hash: "abc" });
    assert.deepEqual(store.listIndexedPaths(), ["/abs/a.md"]);
    store.close();
  } finally {
    cleanup();
  }
});

test("dimension persists across reopen and mismatches are rejected", () => {
  const { path, cleanup } = tmpDbPath();
  try {
    let store = KnowledgeStore.open(path);
    store.upsertFile("/abs/a.md", "/abs", "a.md", { mtimeMs: 1, size: 1, hash: "h" }, [
      chunk("x", [1, 0, 0, 0]),
    ]);
    store.close();

    // Reopen with a conflicting configured dimension -> error.
    assert.throws(() => KnowledgeStore.open(path, 8), /do not match/);

    // Reopen with the matching dimension is fine and data survives.
    store = KnowledgeStore.open(path, 4);
    assert.equal(store.getStats().chunks, 1);
    store.close();
  } finally {
    cleanup();
  }
});
