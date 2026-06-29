import { searchKnowledge } from "../knowledge/index.js";

export interface KnowledgeSearchParams {
  query: string;
  limit?: number;
}

/**
 * Semantic search over the user's indexed notes/knowledge folders. Embeds the query and returns
 * the closest chunks, each tagged with its source path and heading so the caller can cite it.
 */
export async function knowledgeSearch(params: KnowledgeSearchParams): Promise<string> {
  const query = (params.query ?? "").trim();
  if (!query) return "Provide a non-empty query.";

  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 5)), 25);
  const hits = await searchKnowledge(query, limit);

  if (hits.length === 0) {
    return `No matching chunks found for "${query}". The index may still be building, or nothing has been indexed yet.`;
  }

  const blocks = hits.map((h, i) => {
    const loc = h.heading ? `${h.relPath} › ${h.heading}` : h.relPath;
    return `### ${i + 1}. ${loc}  (score ${h.score.toFixed(3)})\n${h.content}`;
  });

  return `Top ${hits.length} result(s) for "${query}":\n\n${blocks.join("\n\n")}`;
}
