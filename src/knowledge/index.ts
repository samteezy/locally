import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveEmbeddingsConfig,
  type LocallyConfig,
  type ResolvedEmbeddingsConfig,
} from "../config.js";
import { effectiveRoots, assertWithinRoots } from "../tools/sandbox.js";
import { embedTexts } from "../llm/embeddings.js";
import { LocallyError } from "../llm/errors.js";
import { KnowledgeStore, type SearchResult, type BrowseChunk, type Stats } from "./store.js";
import { Indexer } from "./indexer.js";

/**
 * Process-level singleton for the knowledge base. The HTTP transport creates a fresh MCP server
 * per request, so the long-lived store + watcher can't live inside it — they're initialized once
 * here (from startHttp) and read by both the HTTP routes and the `knowledge_search` MCP tool.
 */

let store: KnowledgeStore | null = null;
let indexer: Indexer | null = null;
let embeddingsConfig: ResolvedEmbeddingsConfig | null = null;

export function isKnowledgeEnabled(config: LocallyConfig): boolean {
  return config.knowledge?.enabled === true;
}

export function getKnowledgeStore(): KnowledgeStore | null {
  return store;
}

function defaultStorePath(): string {
  return join(homedir(), ".locally", "knowledge.db");
}

/**
 * Open the store, validate watch folders against the sandbox, start the watcher, and kick off
 * the initial scan in the background (so it doesn't block the HTTP listener). Idempotent: a
 * second call is a no-op. Returns a short status line for the startup banner.
 */
export async function initKnowledge(config: LocallyConfig): Promise<string> {
  if (store) return "knowledge base already initialized";

  const kc = config.knowledge ?? {};
  embeddingsConfig = resolveEmbeddingsConfig(config);

  const roots = effectiveRoots(config);
  const watchInput = kc.watch ?? [];
  if (watchInput.length === 0) {
    throw new LocallyError("Knowledge base is enabled but no watch folders are configured.", {
      category: "config",
      origin: "local",
      retriable: false,
      fix: "set knowledge.watch to one or more directories (inside allowedRoots) in locally.config.json, then reconnect the server.",
    });
  }

  // Confine every watch folder to the sandbox roots — fails fast on a misconfigured path.
  const watchRoots = watchInput.map((dir) => assertWithinRoots(dir, roots, { mustExist: true }));

  const fileTypes = new Set(
    (kc.fileTypes ?? ["md", "markdown", "txt"]).map((t) => t.replace(/^\./, "").toLowerCase())
  );

  store = KnowledgeStore.open(kc.storePath ?? defaultStorePath(), kc.embeddings?.dimensions);

  indexer = new Indexer({
    store,
    embeddings: embeddingsConfig,
    batchSize: embeddingsConfig.batchSize,
    watchRoots,
    allowedRoots: roots,
    fileTypes,
    chunkOptions: { maxChars: kc.chunk?.maxChars, overlap: kc.chunk?.overlap },
  });

  indexer.startWatching();
  // Fire-and-forget: the scan logs its own progress/errors to stderr.
  void indexer.initialScan().catch((err) => {
    process.stderr.write(
      `locally knowledge: initial scan failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  });

  return `knowledge base watching ${watchRoots.length} folder(s): ${watchRoots.join(", ")}`;
}

export function shutdownKnowledge(): void {
  indexer?.stop();
  store?.close();
  indexer = null;
  store = null;
  embeddingsConfig = null;
}

export interface KnowledgeSearchHit {
  relPath: string;
  filePath: string;
  heading: string;
  content: string;
  chunkIndex: number;
  startLine: number;
  score: number; // 1 / (1 + distance), higher = closer
}

/** Embed a query and return the top-k chunks. Throws if the store isn't initialized. */
export async function searchKnowledge(query: string, limit = 5): Promise<KnowledgeSearchHit[]> {
  if (!store || !embeddingsConfig) {
    throw new LocallyError("Knowledge base is not initialized.", {
      category: "config",
      origin: "local",
      retriable: false,
      fix: "enable knowledge.enabled and run the server in HTTP mode, then reconnect.",
    });
  }
  const [vector] = await embedTexts(embeddingsConfig, [query]);
  const results: SearchResult[] = store.search(vector, limit);
  return results.map((r) => ({
    relPath: r.relPath,
    filePath: r.filePath,
    heading: r.heading,
    content: r.content,
    chunkIndex: r.chunkIndex,
    startLine: r.startLine,
    score: 1 / (1 + r.distance),
  }));
}

export function browseChunks(limit: number, offset: number): BrowseChunk[] {
  if (!store) return [];
  return store.listChunks(limit, offset);
}

export function knowledgeStats(): Stats | null {
  return store?.getStats() ?? null;
}
