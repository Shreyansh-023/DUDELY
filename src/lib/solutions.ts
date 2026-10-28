import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HistoryMessage } from "./schema";

/**
 * Retrieval over the NCERT *solution* corpus (server-only; used by /api/tutor in
 * "solve" mode).
 *
 * This is a second, separate index from the textbook one in lib/rag.ts. The textbook
 * index holds prose chunks for teaching a topic; this one holds one record per
 * question/answer pair, built offline by rag/build_solutions.py + rag/embed_solutions.py:
 *   rag/data/index/solutions/<textbook key>/{meta.json, chunks.json, vectors.f32}
 *
 * Why its own module rather than another edition of the textbook index: the unit of
 * retrieval is a *whole Q/A pair*, and the useful lookup is usually positional
 * ("exercise 5.2 question 3") rather than semantic. So the order here is reversed
 * from lib/rag.ts — exact reference first, question-text search only as a fallback.
 *
 * Every failure (no index, no NVIDIA key, embed API down) degrades to fewer or no
 * solutions; the solve turn then falls back to the model working the problem itself.
 */

/** One retrieved solution: the question, the book's worked answer, and where it came from. */
export type Solution = {
  /** "Exercise 5.2 · Q3" or "Chapter 5 · Q7" — shown to the model and in `sources`. */
  label: string;
  chapter: number | null;
  chapterTitle: string | null;
  exercise: string | null;
  /** The question number as printed, e.g. "3" or "3(ii)". */
  number: string | null;
  question: string;
  /** The book's worked solution. Empty when the printed answer was a diagram. */
  answer: string;
  /** True when the printed answer was a picture: the model must work it out itself. */
  hasImageAnswer: boolean;
  /** "clean" | "degraded" | "poor" — how much of the maths survived PDF extraction. */
  mathQuality: string;
  textbookPage: number | null;
};

type Chunk = {
  id: string;
  text: string;
  chapter: number | null;
  chapterTitle: string | null;
  section: string | null;
  exercise: string | null;
  number: string | null;
  question: string;
  answer: string;
  hasImageAnswer: boolean;
  mathQuality: string;
  textbookPage: number | null;
  sourcePdf: string;
};
type Meta = { book: string; kind: string; embedModel: string; dim: number; count: number };
type Index = { meta: Meta; chunks: Chunk[]; vectors: Float32Array | null; bm25: Bm25 };

const INDEX_DIR = process.env.RAG_INDEX_DIR || path.join(process.cwd(), "rag", "data", "index");
const SOLUTIONS_DIR = process.env.RAG_SOLUTIONS_DIR || path.join(INDEX_DIR, "solutions");

/** How many solutions to hand the model. A solve turn is about ONE question, so this
 *  is small on purpose: the named question, plus a little room for its neighbours
 *  (sub-parts of the same question, or the next one in the exercise). */
const TOP_K = Number(process.env.RAG_TOP_K_SOLVE || 3);
const CANDIDATES = 30;
const RRF_K = 60;
const BM25_WEIGHT = 0.5;
/** A solution can be long (a full derivation); keep more than a textbook passage. */
const MAX_ANSWER_CHARS = 1800;

const NVIDIA_EMBED_URL =
  process.env.NVIDIA_EMBED_URL || "https://integrate.api.nvidia.com/v1/embeddings";
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "nvidia/nemotron-3-embed-1b";
const EMBED_TIMEOUT_MS = Number(process.env.RAG_EMBED_TIMEOUT_MS || 2500);

// One load per book per process.
const cache = new Map<string, Promise<Index | null>>();

function loadIndex(book: string): Promise<Index | null> {
  const hit = cache.get(book);
  if (hit) return hit;
  const task = (async (): Promise<Index | null> => {
    const dir = path.join(SOLUTIONS_DIR, book);
    try {
      const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as Meta;
      const chunks = JSON.parse(await readFile(path.join(dir, "chunks.json"), "utf8")) as Chunk[];
      // vectors.f32 is optional: without it (or without an API key) search is BM25-only,
      // and positional lookup — the common case here — does not need vectors at all.
      const vectors = await readFile(path.join(dir, "vectors.f32"))
        .then((buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
        .catch(() => null);
      // Index the question text, not the answer: the student is searching for the
      // question they are stuck on.
      const bm25 = new Bm25(chunks.map((c) => tokenize(`${c.question} ${c.chapterTitle ?? ""}`)));
      return { meta, chunks, vectors, bm25 };
    } catch {
      return null; // no solutions index for this book
    }
  })();
  cache.set(book, task);
  return task;
}

// ------------------------------------------------------------------ text utils

const TOKEN = /[^\s.,!?।॥|"'()[\]{}:;\-–—/=+*^$\\<>]+/g;
const STOPWORDS = new Set(
  "a an the of in on at to for and or is are was were be been it its this that these those with as by from if then than so what which how why when do does did find".split(
    " ",
  ),
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

async function embedQuery(text: string): Promise<Float32Array | null> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(NVIDIA_EMBED_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: [text], input_type: "query" }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const v = Float32Array.from(((await res.json()) as { data: { embedding: number[] }[] }).data[0].embedding);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ positional lookup

/**
 * What the student named. Mirrors the keyword sets in lib/rag.ts (English, Hinglish,
 * Devanagari) so "exercise 5.2 q3", "abhyas 5.2 prashn 3" and "अभ्यास 5.2 प्रश्न 3"
 * all resolve the same way. Numbering is identical across editions, so a Hindi
 * request resolves straight into this (English) index.
 */
export type SolveRef = {
  exercise: string | null; // "5.2"
  chapter: number | null; // 5
  question: string | null; // "3"  (sub-parts matched loosely: 3 also hits 3(ii))
  example: string | null; // "2"
};

const SEP = "[\\s:#.\\-]*";
const kw = (...alts: string[]) => `(?<![a-z\\u0900-\\u097f])(?:${alts.join("|")})`;
const K_CHAPTER = kw("chapters?", "chap", "adhyaay", "adhyay", "अध्याय", "चैप्टर");
const K_EXERCISE = kw("exercises?", "prashnaavali", "prashnavali", "abhyaas", "abhyas", "प्रश्नावली", "अभ्यास");
const K_QUESTION = kw("questions?", "ques", "prashn", "sawaal", "sawal", "problem", "sum", "q", "प्रश्न", "सवाल");
const K_EXAMPLE = kw("examples?", "udaharan\\w*", "udhaaran\\w*", "उदाहरण");
const NUM = "(?:no\\.?\\s*|number\\s*|sankhya\\s*|संख्या\\s*)?";

function normalizeDigits(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

export function parseSolveRef(query: string): SolveRef {
  const q = normalizeDigits(query.toLowerCase());
  const exercise = q.match(new RegExp(`${K_EXERCISE}${SEP}(\\d+\\.\\d+)`, "i"))?.[1] ?? null;
  const chapterRaw = q.match(new RegExp(`${K_CHAPTER}${SEP}${NUM}(\\d+)`, "i"))?.[1];
  const question = q.match(new RegExp(`${K_QUESTION}${SEP}${NUM}(\\d+)`, "i"))?.[1] ?? null;
  const example = q.match(new RegExp(`${K_EXAMPLE}${SEP}${NUM}(\\d+)`, "i"))?.[1] ?? null;
  return {
    exercise,
    // "exercise 5.2" already carries its chapter; only trust a bare "chapter N" otherwise.
    chapter: exercise ? Number(exercise.split(".")[0]) : chapterRaw ? Number(chapterRaw) : null,
    question,
    example,
  };
}

/** Did the student name a specific item at all? Used to decide how hard to search. */
export function hasSolveRef(ref: SolveRef): boolean {
  return Boolean(ref.exercise || ref.question || ref.example);
}

/**
 * The question number as printed, split for comparison: "3(ii)" -> {main:"3", part:"ii"}.
 * A student who says "question 3" should get 3, 3(i), 3(ii) … — the sub-parts are the
 * question — so matching is on the main number and sub-parts sort after the bare one.
 */
function splitNumber(n: string | null): { main: string; part: string | null } {
  if (!n) return { main: "", part: null };
  const m = n.match(/^\s*(\d+|[A-Za-z])\s*(?:\(([^)]+)\))?/);
  return { main: (m?.[1] ?? n).toLowerCase(), part: m?.[2]?.toLowerCase() ?? null };
}

/**
 * Exact lookup by reference. Returns every record for the named question (its
 * sub-parts included, in order), so the model can work a multi-part question whole.
 * No embedding call at all — this is the fast, common path.
 */
function resolveByRef(index: Index, ref: SolveRef, limit: number): Chunk[] {
  if (!hasSolveRef(ref)) return [];
  const wanted = splitNumber(ref.question);
  const hits = index.chunks.filter((c) => {
    if (ref.exercise && c.exercise !== ref.exercise) return false;
    if (!ref.exercise && ref.chapter != null && c.chapter !== ref.chapter) return false;
    // "example 2" and "question 2" are the same positional ask in this corpus: the
    // solution sheets number everything as questions within a section.
    const num = ref.question ?? ref.example;
    if (num) {
      const got = splitNumber(c.number);
      if (got.main !== splitNumber(num).main) return false;
    }
    return true;
  });
  // Bare question before its sub-parts, then sub-parts in printed order.
  hits.sort((a, b) => {
    const pa = splitNumber(a.number).part;
    const pb = splitNumber(b.number).part;
    if (pa === pb) return 0;
    if (pa === null) return -1;
    if (pb === null) return 1;
    return pa.localeCompare(pb, undefined, { numeric: true });
  });
  // A whole exercise with no question number would flood the turn; keep it bounded.
  return hits.slice(0, wanted.main ? limit : Math.min(limit, 2));
}

// ------------------------------------------------------------------ semantic fallback

function topIndices(scores: ArrayLike<number>, n: number, keep: (s: number) => boolean): number[] {
  return Array.from({ length: scores.length }, (_, i) => i)
    .filter((i) => keep(scores[i]))
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n);
}

async function search(index: Index, query: string, k: number): Promise<Chunk[]> {
  const { meta, chunks, vectors, bm25 } = index;
  const fused = new Map<number, number>();
  const add = (ranked: number[], weight: number) =>
    ranked.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + weight / (RRF_K + r + 1)));

  const q = vectors ? await embedQuery(query) : null;
  if (q && vectors && q.length === meta.dim) {
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
    .map(([i]) => chunks[i]);
}

// ------------------------------------------------------------------ public API

function label(c: Chunk): string {
  const where = c.exercise
    ? `Exercise ${c.exercise}`
    : c.section
      ? c.section
      : c.chapter != null
        ? `Chapter ${c.chapter}`
        : "Solutions";
  return c.number ? `${where} · Q${c.number}` : where;
}

function toSolution(c: Chunk): Solution {
  const answer = c.answer.length > MAX_ANSWER_CHARS ? `${c.answer.slice(0, MAX_ANSWER_CHARS)} …` : c.answer;
  return {
    label: label(c),
    chapter: c.chapter,
    chapterTitle: c.chapterTitle,
    exercise: c.exercise,
    number: c.number,
    question: c.question,
    answer,
    hasImageAnswer: c.hasImageAnswer,
    mathQuality: c.mathQuality,
    textbookPage: c.textbookPage,
  };
}

/**
 * Find the solution(s) for what the student asked.
 *
 * Positional first ("exercise 5.2 q3" → exact records, no API call), then hybrid
 * search over question text. An empty result is normal and fine: the solve turn
 * then has the model work the problem out itself, grounded on textbook passages.
 */
export async function retrieveSolutions(
  book: string,
  messages: HistoryMessage[],
  opts?: { k?: number },
): Promise<{ solutions: Solution[]; ref: SolveRef; exactSolution: boolean }> {
  const userTurns = messages.filter((m) => m.role === "user").map((m) => m.text.trim());
  let query = userTurns.at(-1) ?? "";
  // A follow-up ("and part ii?", "next one") carries no question text of its own;
  // the previous turn names the exercise it belongs to.
  if (query.split(/\s+/).length < 6 && userTurns.length > 1) query = `${userTurns.at(-2)} ${query}`;
  const ref = parseSolveRef(query);
  if (!query.trim()) return { solutions: [], ref, exactSolution: false };

  const index = await loadIndex(book);
  if (!index) return { solutions: [], ref, exactSolution: false };
  const k = opts?.k ?? TOP_K;

  const byRef = resolveByRef(index, ref, k);
  if (byRef.length > 0) return { solutions: byRef.map(toSolution), ref, exactSolution: true };

  // A semantic hit is a *related* question, not necessarily the one asked, so it is
  // returned flagged: the caller must not present it to the student as their question.
  const found = await search(index, query, k);
  return { solutions: found.map(toSolution), ref, exactSolution: false };
}
