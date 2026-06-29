import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";
import { IGNORED_DIRS } from "../tools/explore-files.js";
import { assertWithinRoots } from "../tools/sandbox.js";
import { LocallyError } from "../llm/errors.js";
import { embedTexts, type EmbeddingsClientConfig } from "../llm/embeddings.js";
import { chunkDocument, buildEmbedInput, type ChunkOptions } from "./chunk.js";
import { KnowledgeStore, type ChunkInput, type FileMeta } from "./store.js";

/**
 * Watches configured folders and keeps the vector store in sync: an initial scan on startup,
 * then debounced incremental re-indexing on file changes. Every path is confined to the
 * sandbox roots, and per-file failures are logged and skipped so one bad file can't take down
 * the watcher or the HTTP server.
 */

export interface IndexerOptions {
  store: KnowledgeStore;
  embeddings: EmbeddingsClientConfig;
  batchSize: number;
  /** Canonical, sandbox-checked watch roots. */
  watchRoots: string[];
  /** Allowed roots for per-file confinement. */
  allowedRoots: string[];
  fileTypes: Set<string>; // lowercased, no leading dot
  chunkOptions: ChunkOptions;
}

const DEBOUNCE_MS = 500;

function log(msg: string): void {
  process.stderr.write(`locally knowledge: ${msg}\n`);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class Indexer {
  private opts: IndexerOptions;
  private watchers: FSWatcher[] = [];
  private debounce = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(opts: IndexerOptions) {
    this.opts = opts;
  }

  private matchesType(path: string): boolean {
    return this.opts.fileTypes.has(extname(path).slice(1).toLowerCase());
  }

  /** Which watch root contains an absolute path (longest match), or null. */
  private rootFor(absPath: string): string | null {
    let best: string | null = null;
    for (const root of this.opts.watchRoots) {
      const rel = relative(root, absPath);
      if (rel === "" || (!rel.startsWith("..") && rel !== absPath)) {
        if (best === null || root.length > best.length) best = root;
      }
    }
    return best;
  }

  /** Recursively yield indexable file paths under a directory. */
  private async *walk(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        yield* this.walk(full);
      } else if (entry.isFile() && this.matchesType(entry.name)) {
        yield full;
      }
    }
  }

  /** Embed chunk inputs in batches, preserving order. */
  private async embedAll(inputs: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += this.opts.batchSize) {
      const batch = inputs.slice(i, i + this.opts.batchSize);
      out.push(...(await embedTexts(this.opts.embeddings, batch)));
    }
    return out;
  }

  /**
   * Index a single file: skip if unchanged, otherwise chunk → embed (with path+heading context)
   * → upsert. Returns true if it (re)indexed.
   */
  async indexFile(absPath: string): Promise<boolean> {
    const safePath = assertWithinRoots(absPath, this.opts.allowedRoots, { mustExist: true });
    const root = this.rootFor(safePath);
    if (!root) return false;

    const info = await stat(safePath);
    if (!info.isFile()) return false;

    const meta: FileMeta = { mtimeMs: Math.floor(info.mtimeMs), size: info.size, hash: "" };
    const prev = this.opts.store.getFileMeta(safePath);
    if (prev && prev.mtimeMs === meta.mtimeMs && prev.size === meta.size) {
      return false; // unchanged
    }

    const content = await readFile(safePath, "utf-8");
    meta.hash = hashContent(content);
    if (prev && prev.hash === meta.hash) {
      // mtime changed but content didn't — refresh the stored mtime to avoid re-reading next time.
      this.opts.store.touchFileMeta(safePath, meta);
      return false;
    }

    const relPath = relative(root, safePath);
    const chunks = chunkDocument(safePath, content, this.opts.chunkOptions);
    if (chunks.length === 0) {
      // File is empty/whitespace — drop any prior chunks but keep a file row so we don't rescan.
      this.opts.store.upsertFile(safePath, root, relPath, meta, []);
      return true;
    }

    const inputs = chunks.map((c) => buildEmbedInput(relPath, c.heading, c.content));
    const embeddings = await this.embedAll(inputs);

    const chunkInputs: ChunkInput[] = chunks.map((c, i) => ({
      relPath,
      chunkIndex: c.index,
      heading: c.heading,
      content: c.content,
      startLine: c.startLine,
      embedding: embeddings[i],
    }));

    this.opts.store.upsertFile(safePath, root, relPath, meta, chunkInputs);
    return true;
  }

  /** Full scan of all watch roots: index new/changed files, prune deleted ones. */
  async initialScan(): Promise<void> {
    const seen = new Set<string>();
    let indexed = 0;
    for (const root of this.opts.watchRoots) {
      for await (const file of this.walk(root)) {
        if (this.stopped) return;
        seen.add(file);
        try {
          if (await this.indexFile(file)) indexed++;
        } catch (err) {
          log(`skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Prune files that vanished while the server was down.
    let pruned = 0;
    for (const known of this.opts.store.listIndexedPaths()) {
      if (!seen.has(known)) {
        this.opts.store.deleteFile(known);
        pruned++;
      }
    }

    const stats = this.opts.store.getStats();
    log(`initial scan complete — ${indexed} indexed, ${pruned} pruned; ${stats.files} files / ${stats.chunks} chunks`);
  }

  /** Start recursive watchers on every root. */
  startWatching(): void {
    for (const root of this.opts.watchRoots) {
      try {
        const w = watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const abs = join(root, filename.toString());
          if (!this.matchesType(abs)) return;
          this.schedule(abs);
        });
        this.watchers.push(w);
      } catch (err) {
        log(`could not watch ${root}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private schedule(absPath: string): void {
    const existing = this.debounce.get(absPath);
    if (existing) clearTimeout(existing);
    this.debounce.set(
      absPath,
      setTimeout(() => {
        this.debounce.delete(absPath);
        void this.handleChange(absPath);
      }, DEBOUNCE_MS)
    );
  }

  private async handleChange(absPath: string): Promise<void> {
    if (this.stopped) return;
    try {
      let exists = true;
      try {
        await stat(absPath);
      } catch {
        exists = false;
      }

      if (!exists) {
        // Confinement check still applies; resolve lexically since the path is gone.
        try {
          assertWithinRoots(absPath, this.opts.allowedRoots);
        } catch {
          return;
        }
        this.opts.store.deleteFile(absPath);
        log(`removed ${absPath}`);
        return;
      }

      if (await this.indexFile(absPath)) log(`reindexed ${absPath}`);
    } catch (err) {
      if (err instanceof LocallyError && err.category === "constraint") return; // outside roots; ignore
      log(`failed to index ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
