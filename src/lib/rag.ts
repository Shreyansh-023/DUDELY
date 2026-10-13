import { readFile } from "node:fs/promises";
import path from "node:path";
import { OLLAMA_BASE_URL } from "./llm";
import type { HistoryMessage } from "./schema";

/**
 * Retrieval over the student's NCERT textbook (server-only; used by /api/tutor).
 *
 * The index is built offline by rag/build_index.py into
 *   rag/data/index/<textbook key>/<edition>/{meta.json, chunks.json, vectors.f32}
 * where <textbook key> is textbookKey(grade, subject), e.g. "ncert-class-10-maths",
 * and <edition> is the book's language ("english", "hindi").
 *
 * Search is hybrid: bge-m3 embeddings via Ollama (meaning) fused with BM25 (exact
 * terms) by weighted Reciprocal Rank Fusion. Every failure (no index for this book,
 * Ollama down, embedding model missing) degrades to fewer or no passages; it never
 * breaks a tutor turn.
 */

export type Passage = {
  label: string; // "Chapter 4: Quadratic Equations › 4.3 Solution of a Quadratic Equation…"
  pages: [number, number];
  kind: string; // "chapter" | "exercise" | "appendix" | "answers"
  text: string;
};

type Chunk = Passage & { id: number; stem: string; chapter: number | null };
type Meta = { book: string; edition: string; embedModel: string; dim: number; count: number };
type Index = { meta: Meta; chunks: Chunk[]; vectors: Float32Array; bm25: Bm25 };

const INDEX_DIR = process.env.RAG_INDEX_DIR || path.join(process.cwd(), "rag", "data", "index");
const TOP_K = Number(process.env.RAG_TOP_K || 3);
const CANDIDATES = 30;
const RRF_K = 60;
const BM25_WEIGHT = 0.5; // BM25 cannot match an English question to Devanagari text; weight it below meaning
// Every passage character is prompt a local model must read before it can speak, so passages
// are capped: 3 x 900 chars measurably shortened time-to-first-beat versus 4 x 1200.
const MAX_PASSAGE_CHARS = 900;
const EMBED_TIMEOUT_MS = 8000;

// ------------------------------------------------------------------ loading

const cache = new Map<string, Promise<Index | null>>();

function loadIndex(book: string, edition: string): Promise<Index | null> {
  const key = `${book}/${edition}`;
  let p = cache.get(key);
  if (!p) {
    p = readIndex(book, edition);
    cache.set(key, p);
    // A missing index is not cached forever: it may be built while the server runs.
    p.then((idx) => {
      if (!idx) setTimeout(() => cache.delete(key), 60_000);
    });
  }
  return p;
}

async function readIndex(book: string, edition: string): Promise<Index | null> {
  if (!/^[a-z0-9-]+$/.test(book) || !/^[a-z]+$/.test(edition)) return null; // keys only, no paths
  const dir = path.join(INDEX_DIR, book, edition);
  try {
    const [metaRaw, chunksRaw, vecBuf] = await Promise.all([
      readFile(path.join(dir, "meta.json"), "utf8"),
      readFile(path.join(dir, "chunks.json"), "utf8"),
      readFile(path.join(dir, "vectors.f32")),
    ]);
    const meta = JSON.parse(metaRaw) as Meta;
    const chunks = JSON.parse(chunksRaw) as Chunk[];
    // Copy into an aligned buffer: a Node Buffer's byteOffset need not be a multiple of 4.
    const vectors = new Float32Array(vecBuf.buffer.slice(vecBuf.byteOffset, vecBuf.byteOffset + vecBuf.byteLength));
    if (vectors.length !== meta.count * meta.dim || chunks.length !== meta.count) {
      console.warn(`[rag] index ${book}/${edition} is inconsistent; rebuild it`);
      return null;
    }
    return { meta, chunks, vectors, bm25: new Bm25(chunks.map((c) => tokenize(`${c.label} ${c.text}`))) };
  } catch {
    return null; // not built for this book/edition
  }
}

// ------------------------------------------------------------------ BM25

// Split on whitespace and punctuation, not on \w: \w drops Devanagari vowel signs and
// would cut Hindi words apart. Function words that occur everywhere are dropped.
const TOKEN = /[^\s.,!?।॥|"'()[\]{}:;\-–—/=+*^$\\<>]+/g;
const STOPWORDS = new Set(
  (
    "है हैं हो होता होती होते को का की के में से पर और या तो भी ही यह ये वह इस उस क्या कैसे कब क्यों कौन " +
    "कर करते करना करें किया जो कि ने नहीं हम आप एक " +
    "a an the of to in on for and or is are was were be by with as at it this that what how why which " +
    "do does find kya hai hain ka ki ke ko mein aur kaise hota hoti se par"
  ).split(" "),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).filter((t) => !STOPWORDS.has(t));
}

class Bm25 {
  private tfs: Map<string, number>[];
  private lens: number[];
  private avgdl: number;
  private idf = new Map<string, number>();

  constructor(docs: string[][], private k1 = 1.5, private b = 0.75) {
    this.tfs = docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      return tf;
    });
    this.lens = docs.map((d) => d.length);
    this.avgdl = this.lens.reduce((a, n) => a + n, 0) / Math.max(docs.length, 1);
    const df = new Map<string, number>();
    for (const tf of this.tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, f] of df) this.idf.set(t, Math.log(1 + (docs.length - f + 0.5) / (f + 0.5)));
  }

  scores(query: string[]): Float64Array {
    const out = new Float64Array(this.tfs.length);
    for (const term of new Set(query)) {
      const idf = this.idf.get(term);
      if (idf === undefined) continue;
      for (let i = 0; i < this.tfs.length; i++) {
        const tf = this.tfs[i].get(term);
        if (!tf) continue;
        const norm = this.k1 * (1 - this.b + (this.b * this.lens[i]) / this.avgdl);
        out[i] += (idf * tf * (this.k1 + 1)) / (tf + norm);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ search

async function embedQuery(model: string, text: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const v = Float32Array.from(((await res.json()) as { embeddings: number[][] }).embeddings[0]);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  } catch {
    return null; // Ollama not running or model not pulled: fall back to BM25 alone
  }
}

function topIndices(scores: ArrayLike<number>, n: number, keep: (s: number) => boolean): number[] {
  return Array.from({ length: scores.length }, (_, i) => i)
    .filter((i) => keep(scores[i]))
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n);
}

async function search(index: Index, query: string, k: number): Promise<Passage[]> {
  const { meta, chunks, vectors, bm25 } = index;
  const fused = new Map<number, number>();
  const add = (ranked: number[], weight: number) =>
    ranked.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + weight / (RRF_K + r + 1)));

  const q = await embedQuery(meta.embedModel, query);
  if (q && q.length === meta.dim) {
    const sims = new Float64Array(meta.count);
    for (let i = 0; i < meta.count; i++) {
      let s = 0;
      const off = i * meta.dim;
      for (let d = 0; d < meta.dim; d++) s += vectors[off + d] * q[d];
      sims[i] = s;
    }
    add(topIndices(sims, CANDIDATES, () => true), 1.0);
  }
  add(topIndices(bm25.scores(tokenize(query)), CANDIDATES, (s) => s > 0), q ? BM25_WEIGHT : 1.0);

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([i]) => {
      const c = chunks[i];
      const text = c.text.length > MAX_PASSAGE_CHARS ? c.text.slice(0, MAX_PASSAGE_CHARS) + " …" : c.text;
      return { label: c.label, pages: c.pages, kind: c.kind, text };
    });
}

// ------------------------------------------------------------------ public API

const DEVANAGARI = /[ऀ-ॿ]/g;

/**
 * Passages from the student's textbook for the latest question, or [] when there is
 * no index for this book or nothing usable. Devanagari questions search the Hindi
 * edition, everything else the English one (falling back to the other if missing).
 */
export async function retrieveTextbookContext(
  book: string,
  messages: HistoryMessage[],
): Promise<{ edition: string; passages: Passage[] }> {
  const userTurns = messages.filter((m) => m.role === "user").map((m) => m.text.trim());
  let query = userTurns.at(-1) ?? "";
  // Short follow-ups ("haan", "next step", "why?") carry no topic; add the previous question.
  if (query.split(/\s+/).length < 6 && userTurns.length > 1) query = `${userTurns.at(-2)} ${query}`;
  if (!query.trim()) return { edition: "", passages: [] };

  const letters = query.match(/\p{L}/gu)?.length ?? 0;
  const hindi = letters > 0 && (query.match(DEVANAGARI)?.length ?? 0) / letters >= 0.3;
  for (const edition of hindi ? ["hindi", "english"] : ["english", "hindi"]) {
    const index = await loadIndex(book, edition);
    if (index) return { edition, passages: await search(index, query, TOP_K) };
  }
  return { edition: "", passages: [] };
}
