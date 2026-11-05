/**
 * Cross-encoder reranking — the second stage of retrieval, shared by the textbook
 * index (lib/rag) and the solutions index (lib/solutions).
 *
 * Hybrid search (embeddings + BM25) is good at deciding which ~30 chunks are
 * plausibly about the question, and weaker at ordering them, because it compares two
 * vectors that were made independently and never saw each other. A cross-encoder
 * reads the query and one passage TOGETHER and scores that pair, which is slower per
 * candidate but far better at ranking — so the shape is: retrieve wide and cheap,
 * then rerank a shortlist and keep the top few.
 *
 * This matters more here than in a typical RAG app because k is small (3-7). At k=3
 * one off-topic passage is a third of the tutor's grounding, and the prompt tells the
 * model to take its definitions, notation and depth from exactly these passages — so
 * a wrong-chapter hit does not dilute the lesson, it misdirects it.
 *
 * Every failure path returns null and the caller keeps its hybrid order: reranking
 * improves retrieval and is never a dependency of it, the same contract as the
 * embedding call it sits behind.
 */

// Reranking lives on ai.api.nvidia.com, NOT the integrate.* host used for chat and
// embeddings; the per-model /v1/retrieval/.../reranking paths on integrate.* answer
// 404, and so does /v1/ranking. The older llama-3_2-nv-rerankqa-1b-v2 path now
// returns 410 Gone ("end of life 2026-05-18"), so the model below is the current
// free endpoint. Both are env-overridable so a future retirement is a config change,
// and until it is made, retrieval degrades to unreranked hybrid instead of breaking.
const RERANK_URL =
  process.env.NVIDIA_RERANK_URL ||
  "https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-rerank-8b/reranking";
const RERANK_MODEL = process.env.RAG_RERANK_MODEL || "nvidia/nemotron-3.5-rerank-8b";
/** Off switch: RAG_RERANK=0 disables the second stage in both pipelines. */
const RERANK_ENABLED = process.env.RAG_RERANK !== "0";
/**
 * How many fused candidates to score. Measured against the hosted endpoint: 20
 * passages ≈ 0.6s, 40 ≈ 1.7s — superlinear, so this stays well below the 30
 * candidates hybrid search produces. The reranker only has to surface the right few
 * from a shortlist that is already filtered.
 */
const RERANK_CANDIDATES = Number(process.env.RAG_RERANK_CANDIDATES || 20);
/**
 * Chars of each candidate sent for scoring. These are latency-bearing tokens, and
 * the slice the tutor will eventually read is enough to judge relevance.
 */
const RERANK_PASSAGE_CHARS = Number(process.env.RAG_RERANK_PASSAGE_CHARS || 900);
const RERANK_TIMEOUT_MS = Number(process.env.RAG_RERANK_TIMEOUT_MS || 2500);

/**
 * Reorders `candidates` by cross-encoder relevance to `query`, best first.
 *
 * `candidates` are opaque ids (chunk indices); `textOf` renders one for scoring.
 * Include whatever identifies the chunk to a reader — the label
 * ("Exercise 5.2 · Q3") is often the clearest signal that a chunk is or is not the
 * item the student named by position.
 *
 * Returns null when reranking is off, unavailable or failed, meaning "keep your own
 * order". Never throws.
 */
export async function rerank<T>(
  query: string,
  candidates: T[],
  textOf: (candidate: T) => string,
): Promise<T[] | null> {
  const key = process.env.NVIDIA_API_KEY;
  if (!RERANK_ENABLED || !key || candidates.length < 2 || !query.trim()) return null;
  const shortlist = candidates.slice(0, RERANK_CANDIDATES);
  try {
    const res = await fetch(RERANK_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query: { text: query },
        passages: shortlist.map((c) => ({ text: textOf(c).slice(0, RERANK_PASSAGE_CHARS) })),
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { rankings } = (await res.json()) as { rankings?: { index: number }[] };
    if (!rankings?.length) return null;
    // `index` is the position in the passages array we sent, not an id of ours, so it
    // has to be mapped back through `shortlist`. An out-of-range index is dropped
    // rather than trusted.
    const ordered = rankings.map((r) => shortlist[r.index]).filter((c): c is T => c !== undefined);
    if (ordered.length === 0) return null;
    // Candidates the shortlist held but the response did not mention keep their
    // original order behind the reranked ones, so nothing is silently lost.
    const seen = new Set(ordered);
    return [...ordered, ...candidates.filter((c) => !seen.has(c))];
  } catch {
    return null; // API down / timeout / retired endpoint: caller keeps hybrid order
  }
}
