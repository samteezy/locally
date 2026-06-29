import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { LocallyError } from "../llm/errors.js";

// node:sqlite is only resolvable *with* the node: prefix, and the bundler (esbuild) rewrites a
// static `import ... from "node:sqlite"` to bare "sqlite", which Node can't load. Requiring it
// through a runtime-computed specifier keeps the prefix intact in both dev (tsx) and the bundle.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire(["node", "sqlite"].join(":")) as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/**
 * Vector store over node:sqlite + the sqlite-vec extension. Holds one row per file (for
 * incremental skip-if-unchanged) and one row per chunk, with embeddings in a vec0 virtual
 * table keyed by chunk id. Brute-force KNN via sqlite-vec is plenty for individual/notes-scale
 * corpora.
 *
 * vec0 quirks learned the hard way: rowids must be bound as BigInt, and embeddings as the raw
 * bytes of a Float32Array.
 */

export interface ChunkInput {
  relPath: string;
  chunkIndex: number;
  heading: string;
  content: string;
  startLine: number;
  embedding: number[];
}

export interface FileMeta {
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface SearchResult {
  filePath: string;
  relPath: string;
  heading: string;
  content: string;
  chunkIndex: number;
  startLine: number;
  distance: number;
}

export interface BrowseChunk {
  filePath: string;
  relPath: string;
  heading: string;
  content: string;
  chunkIndex: number;
}

export interface Stats {
  files: number;
  chunks: number;
  dimensions: number | null;
  lastIndexed: number | null;
}

function f32(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

export class KnowledgeStore {
  private db: DatabaseSync;
  private dim: number | null = null;

  private constructor(db: DatabaseSync, dim: number | null) {
    this.db = db;
    this.dim = dim;
  }

  /**
   * Open (or create) the store at `path`. If `dimensions` is provided the vec table is created
   * eagerly; otherwise it is created lazily on the first upsert from the embedding length.
   */
  static open(path: string, dimensions?: number): KnowledgeStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { allowExtension: true });
      sqliteVec.load(db);
    } catch (err) {
      throw new LocallyError(
        `Failed to open knowledge store at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        {
          category: "config",
          origin: "local",
          retriable: false,
          fix: "ensure knowledge.storePath is writable and the sqlite-vec prebuilt binary is installed for this platform, then reconnect the server.",
        }
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        watch_root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading TEXT NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_by_file ON chunks(file_path);
    `);

    const row = db.prepare("SELECT value FROM meta WHERE key = 'dimensions'").get() as
      | { value: string }
      | undefined;
    let dim: number | null = row ? Number(row.value) : null;

    if (dimensions !== undefined) {
      if (dim !== null && dim !== dimensions) {
        throw new LocallyError(
          `Configured embedding dimensions (${dimensions}) do not match the existing store (${dim}).`,
          {
            category: "config",
            origin: "local",
            retriable: false,
            fix: "either set knowledge.embeddings.dimensions to match the existing store, or delete the store file to re-index from scratch, then reconnect the server.",
          }
        );
      }
      dim = dimensions;
    }

    const store = new KnowledgeStore(db, dim);
    if (dim !== null) store.ensureVecTable(dim);
    return store;
  }

  private ensureVecTable(dim: number): void {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}])`);
    if (this.dim === null) {
      this.dim = dim;
      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('dimensions', ?)")
        .run(String(dim));
    }
  }

  get dimensions(): number | null {
    return this.dim;
  }

  getFileMeta(path: string): FileMeta | null {
    const row = this.db
      .prepare("SELECT mtime_ms AS mtimeMs, size, hash FROM files WHERE path = ?")
      .get(path) as FileMeta | undefined;
    return row ?? null;
  }

  listIndexedPaths(): string[] {
    const rows = this.db.prepare("SELECT path FROM files").all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Replace all chunks for a file in a single transaction: delete old chunks + their vectors,
   * insert the new ones, and upsert the file row. The first upsert fixes the vector dimension.
   */
  upsertFile(
    absPath: string,
    watchRoot: string,
    relPath: string,
    meta: FileMeta,
    chunks: ChunkInput[]
  ): void {
    if (chunks.length > 0) {
      const dim = chunks[0].embedding.length;
      if (this.dim !== null && dim !== this.dim) {
        throw new LocallyError(
          `Embedding length ${dim} does not match the store dimension ${this.dim}.`,
          {
            category: "upstream",
            origin: "upstream",
            retriable: false,
            fix: "the embeddings endpoint returned a vector of unexpected length — verify the configured embeddings model is stable, or delete the store to re-index.",
          }
        );
      }
      this.ensureVecTable(dim);
    }

    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      this.deleteFileChunks(absPath);

      const insChunk = this.db.prepare(
        `INSERT INTO chunks(file_path, rel_path, chunk_index, heading, content, start_line)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insVec = this.db.prepare("INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)");

      for (const c of chunks) {
        const res = insChunk.run(absPath, relPath, c.chunkIndex, c.heading, c.content, c.startLine);
        const rowid = res.lastInsertRowid as number;
        insVec.run(BigInt(rowid), f32(c.embedding));
      }

      this.db
        .prepare(
          `INSERT INTO files(path, watch_root, rel_path, mtime_ms, size, hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             watch_root = excluded.watch_root, rel_path = excluded.rel_path,
             mtime_ms = excluded.mtime_ms, size = excluded.size,
             hash = excluded.hash, indexed_at = excluded.indexed_at`
        )
        .run(absPath, watchRoot, relPath, meta.mtimeMs, meta.size, meta.hash, Date.now());

      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  private deleteFileChunks(absPath: string): void {
    if (this.dim !== null) {
      // Remove vectors first (vec_chunks only exists once dimensions are known).
      this.db
        .prepare(
          "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)"
        )
        .run(absPath);
    }
    this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(absPath);
  }

  /**
   * Update only a file's stored metadata (mtime/size/hash) without touching its chunks. Used
   * when a file's mtime changed but its content hash didn't, to avoid re-reading it next scan.
   */
  touchFileMeta(absPath: string, meta: FileMeta): void {
    this.db
      .prepare("UPDATE files SET mtime_ms = ?, size = ?, hash = ?, indexed_at = ? WHERE path = ?")
      .run(meta.mtimeMs, meta.size, meta.hash, Date.now(), absPath);
  }

  /** Remove a file and its chunks entirely (used when a watched file is deleted). */
  deleteFile(absPath: string): void {
    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      this.deleteFileChunks(absPath);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(absPath);
      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  search(queryEmbedding: number[], k: number): SearchResult[] {
    if (this.dim === null) return [];
    // KNN over an empty vec0 table throws "LIMIT required" (a sqlite-vec quirk), so short-circuit.
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number }).n;
    if (count === 0) return [];
    // vec0 KNN requires `k` to be visible to the query planner, so it must be a literal LIMIT
    // (a bound `LIMIT ?` isn't recognized). `k` is an internal integer — coerce it defensively.
    const limit = Math.max(1, Math.floor(k));
    // Isolate the KNN in a subquery so the LIMIT binds to the vec0 scan; joining vec_chunks to
    // chunks directly lets the planner scan chunks first and detach the LIMIT (vec0 then errors).
    const rows = this.db
      .prepare(
        `SELECT c.file_path AS filePath, c.rel_path AS relPath, c.heading, c.content,
                c.chunk_index AS chunkIndex, c.start_line AS startLine, knn.distance
         FROM (
           SELECT rowid, distance FROM vec_chunks
           WHERE embedding MATCH ? ORDER BY distance LIMIT ${limit}
         ) AS knn
         JOIN chunks c ON c.id = knn.rowid
         ORDER BY knn.distance`
      )
      .all(f32(queryEmbedding)) as unknown as SearchResult[];
    return rows;
  }

  listChunks(limit: number, offset: number): BrowseChunk[] {
    return this.db
      .prepare(
        `SELECT file_path AS filePath, rel_path AS relPath, heading, content, chunk_index AS chunkIndex
         FROM chunks ORDER BY rel_path, chunk_index LIMIT ? OFFSET ?`
      )
      .all(BigInt(limit), BigInt(offset)) as unknown as BrowseChunk[];
  }

  getStats(): Stats {
    const files = (this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    const chunks = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const last = this.db.prepare("SELECT MAX(indexed_at) AS t FROM files").get() as { t: number | null };
    return { files, chunks, dimensions: this.dim, lastIndexed: last.t ?? null };
  }

  close(): void {
    this.db.close();
  }
}
