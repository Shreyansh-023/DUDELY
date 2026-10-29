import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HistoryMessage } from "./schema";

/**
 * Retrieval over the student's NCERT textbook (server-only; used by /api/tutor).
 *
 * The index is built offline by rag/build_index.py into
 *   rag/data/index/<textbook key>/<edition>/{meta.json, chunks.json, vectors.f32}
 * where <textbook key> is textbookKey(grade, subject), e.g. "ncert-class-10-maths",
 * and <edition> is the book's language ("english", "hindi").
 *
 * Search is hybrid: NVIDIA Nemotron-3-Embed-1B embeddings (meaning, over the hosted
 * NIM API — so nothing runs locally) fused with BM25 (exact terms) by weighted
 * Reciprocal Rank Fusion. Nemotron is multilingual/cross-lingual, so an English or
 * Hindi or Hinglish question retrieves from the English (or Hindi) edition alike.
 *
 * Every failure (no index for this book, no NVIDIA key, the embed API down) degrades
 * to fewer or no passages; it never breaks a tutor turn.
 */

export type Passage = {
  label: string; // "Chapter 4: Quadratic Equations"
  pages: [number, number];
  kind: string; // "chapter" | "exercise" | "answers"
  text: string;
};

type Chunk = Passage & { id: number; stem: string; chapter: number | null; printedPage?: number };
type Meta = { book: string; edition: string; embedModel: string; dim: number; count: number };

/** A referenceable unit of the book (Example/Theorem/Exercise), from rag/build_index.py. */
type Unit = { text: string; pdfPage: number; printedPage: number };
type ExerciseUnit = Unit & { questions: Record<string, { text: string }> };
type Section = { ref: string; title: string; intro: string; pdfPage: number; printedPage: number };
type Structure = {
  examples: Record<string, Record<string, Unit>>; // chapter -> number -> unit
  theorems: Record<string, Unit>; // "1.2" -> unit
  exercises: Record<string, ExerciseUnit>; // "1.1" -> unit
  sections: Record<string, Section[]>; // chapter -> ordered sections
  outlines: Record<string, string>; // chapter -> "8.1 Introduction · 8.2 …"
};
type Index = { meta: Meta; chunks: Chunk[]; vectors: Float32Array; bm25: Bm25; structure: Structure | null };

const INDEX_DIR = process.env.RAG_INDEX_DIR || path.join(process.cwd(), "rag", "data", "index");
// Per-mode retrieval depth. The planner designs the whole lesson in one shot and
// benefits from seeing more of the chapter (outline + several related chunks);
// a teach step is one idea and K=3 keeps it focused; a doubt is narrow but may
// touch two sub-topics. ask/explain reuse the default.
const TOP_K = Number(process.env.RAG_TOP_K || 3);
const TOP_K_BY_MODE: Record<string, number> = {
  plan: Number(process.env.RAG_TOP_K_PLAN || 7),
  teach: Number(process.env.RAG_TOP_K_TEACH || 3),
  doubt: Number(process.env.RAG_TOP_K_DOUBT || 5),
  explain: Number(process.env.RAG_TOP_K_EXPLAIN || TOP_K),
  ask: Number(process.env.RAG_TOP_K_ASK || TOP_K),
  // Solving is grounded mainly by the solutions index (lib/solutions), but the
  // textbook passages matter more than "theory for a step": where a question's data
  // was a figure the solution sheet lost, the chapter text is usually the only place
  // the real values survive. Worth a few extra passages.
  solve: Number(process.env.RAG_TOP_K_SOLVE_BOOK || 4),
  solvedoubt: Number(process.env.RAG_TOP_K_SOLVEDOUBT || 3),
};
const CANDIDATES = 30;
const RRF_K = 60;
// BM25 cannot match an English question to Devanagari text (or vice versa); weight it
// below meaning, which Nemotron handles cross-lingually.
const BM25_WEIGHT = 0.5;
// Every passage character is a token the tutor LLM must read before it can speak, so
// passages are capped: 3 x 900 chars keeps time-to-first-beat down.
const MAX_PASSAGE_CHARS = 900;

// NVIDIA NIM embeddings (OpenAI-compatible). Nemotron needs input_type query|passage;
// the build script embeds passages, we embed the query here.
const NVIDIA_EMBED_URL =
  process.env.NVIDIA_EMBED_URL || "https://integrate.api.nvidia.com/v1/embeddings";
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "nvidia/nemotron-3-embed-1b";
const EMBED_TIMEOUT_MS = Number(process.env.RAG_EMBED_TIMEOUT_MS || 2500);

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
    // structure.json is optional: an older index without it still works (semantic only).
    const structure = await readFile(path.join(dir, "structure.json"), "utf8")
      .then((raw) => JSON.parse(raw) as Structure)
      .catch(() => null);
    return {
      meta,
      chunks,
      vectors,
      bm25: new Bm25(chunks.map((c) => tokenize(`${c.label} ${c.text}`))),
      structure,
    };
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
  // Written out rather than declared as constructor parameter properties, which
  // need a full TS transform: this file is imported directly by
  // scripts/qa-regress.mjs under `node --experimental-strip-types`.
  private k1 = 1.5;
  private b = 0.75;

  constructor(docs: string[][]) {
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

async function embedQuery(text: string): Promise<Float32Array | null> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return null; // no key: fall back to BM25 alone
  try {
    const res = await fetch(NVIDIA_EMBED_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      // input_type "query" is NOT optional for Nemotron: query and passage vectors live
      // in asymmetric spaces, and the build script embeds chunks as "passage".
      body: JSON.stringify({ model: EMBED_MODEL, input: [text], input_type: "query" }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const v = Float32Array.from(((await res.json()) as { data: { embedding: number[] }[] }).data[0].embedding);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  } catch {
    return null; // API down / timeout / bad key: fall back to BM25 alone
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

  const q = await embedQuery(query);
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

// ------------------------------------------------------------------ structural lookup

// A student references a unit by POSITION ("example 2 of chapter 1", "theorem 1.2",
// "exercise 1.1 question 3", "page 45"). Semantic search cannot find a position — an
// ordinal carries no meaning — so these are resolved by exact lookup in structure.json,
// which also skips the embedding API call entirely (faster and cheaper than search).
const MAX_STRUCTURAL_PASSAGES = 4;

type Refs = {
  examples: { chapter: string | null; num: string }[];
  theorems: string[]; // "1.2"
  exercises: { ref: string; question: string | null }[]; // "1.1"
  sections: string[]; // "8.2"
  pages: number[]; // printed page numbers
};

// Structural keywords in English, Hinglish (romanized) and Hindi (Devanagari). A reference
// is NUMERIC and the numbering is identical across editions, so a Hindi/Hinglish request
// ("अध्याय 1 का उदाहरण 2", "chapter 1 ka example 2") resolves straight into the (English)
// structure index; the tutor then teaches that unit in the student's language.
const SEP = String.raw`[\s:#.\-]*`; // optional separators between a keyword and its number
// Negative lookbehind: not preceded by a letter (Latin or Devanagari) so short aliases
// ("q", "chap") never fire inside a word ("each 1", "quadratic 2").
const kw = (...alts: string[]) =>
  String.raw`(?<![a-z\u0900-\u097f])` + `(?:${alts.join("|")})`;
const K_CHAPTER = kw("chapters?", "chap", "adhyaay", "adhyay", "अध्याय", "चैप्टर");
const K_EXAMPLE = kw("examples?", String.raw`udaharan\w*`, String.raw`udhaaran\w*`, "उदाहरण");
const K_THEOREM = kw("theorems?", "prameya?", "प्रमेय");
const K_EXERCISE = kw("exercises?", "prashnaavali", "prashnavali", "abhyaas", "abhyas", "प्रश्नावली", "अभ्यास");
const K_SECTION = kw("sections?", "anubhag", "अनुभाग", "खंड", "भाग");
const K_PAGE = kw("page", "pej", "prishtha?", "पृष्ठ", "पेज");
const K_QUESTION = kw("questions?", "ques", "prashn", "sawaal", "sawal", "problem", "q", "प्रश्न", "सवाल");
const NUM = String.raw`(?:no\.?\s*|number\s*|sankhya\s*|संख्या\s*)?`; // optional "no."/"number"/"संख्या"

// Devanagari digits ०-९ -> 0-9, so "उदाहरण २" is read like "example 2".
function normalizeDigits(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

function parseStructuralRefs(query: string): Refs {
  const q = normalizeDigits(query.toLowerCase());
  const refs: Refs = { examples: [], theorems: [], exercises: [], sections: [], pages: [] };
  // "chapter N" scopes examples (numbered per chapter). Theorems/exercises/sections carry
  // their chapter in the "N.N" ref, so they need no separate chapter.
  const chapter = q.match(new RegExp(`${K_CHAPTER}${SEP}${NUM}` + String.raw`(\d+)`, "i"))?.[1] ?? null;
  for (const m of q.matchAll(new RegExp(`${K_EXAMPLE}${SEP}${NUM}` + String.raw`(\d+)`, "gi"))) refs.examples.push({ chapter, num: m[1] });
  for (const m of q.matchAll(new RegExp(`${K_THEOREM}${SEP}` + String.raw`(\d+\.\d+)`, "gi"))) refs.theorems.push(m[1]);
  const question = q.match(new RegExp(`${K_QUESTION}${SEP}${NUM}` + String.raw`(\d+)`, "i"))?.[1] ?? null;
  for (const m of q.matchAll(new RegExp(`${K_EXERCISE}${SEP}` + String.raw`(\d+\.\d+)`, "gi"))) refs.exercises.push({ ref: m[1], question });
  for (const m of q.matchAll(new RegExp(`${K_SECTION}${SEP}` + String.raw`(\d+\.\d+)`, "gi"))) refs.sections.push(m[1]);
  for (const m of q.matchAll(new RegExp(`${K_PAGE}${SEP}${NUM}` + String.raw`(\d+)`, "gi"))) refs.pages.push(Number(m[1]));
  return refs;
}

// Opening a topic is a pedagogical need, not a similarity match: the book's intro/analogy
// and the chapter's teaching sequence must be surfaced on purpose. These words — English,
// Hinglish and Hindi — flag that intent ("teach me X", "mujhe X sikhao", "X समझाओ").
const OPENER =
  /(teach|start|learn|begin|introduc|intro|basics?|overview|explain|understand|samjha|sikha|padha|parichay|shuru|bata|seekh|समझा|सिखा|पढ़ा|पढा|परिचय|शुरू|बता|सीख)/i;

/** The chapter most of these passages belong to (parsed from their labels), or null. */
function dominantChapter(passages: Passage[]): string | null {
  const counts = new Map<string, number>();
  for (const p of passages) {
    const m = p.label.match(/Chapter (\d+)/) || p.label.match(/(?:Theorem|Exercise|Section) (\d+)\./);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  let max = 0;
  for (const [ch, n] of counts) if (n > max) ((max = n), (best = ch));
  return best;
}

/** Resolve named units to exact passages. [] when nothing in the query names a unit we hold. */
function resolveStructural(index: Index, query: string): Passage[] {
  const { structure, chunks } = index;
  const refs = parseStructuralRefs(query);
  const out: Passage[] = [];
  const unit = (label: string, u: Unit, kind: string) =>
    out.push({ label, pages: [u.pdfPage, u.pdfPage], kind, text: u.text });

  if (structure) {
    for (const { chapter, num } of refs.examples) {
      if (!chapter) continue; // examples restart per chapter; without one we cannot disambiguate
      const u = structure.examples?.[chapter]?.[num];
      if (u) unit(`Chapter ${chapter} · Example ${num}`, u, "example");
    }
    for (const ref of refs.theorems) {
      const u = structure.theorems?.[ref];
      if (u) unit(`Theorem ${ref}`, u, "theorem");
    }
    for (const { ref, question } of refs.exercises) {
      const u = structure.exercises?.[ref];
      if (!u) continue;
      const qText = question ? u.questions?.[question]?.text : undefined;
      if (qText) out.push({ label: `Exercise ${ref} · Q${question}`, pages: [u.pdfPage, u.pdfPage], kind: "exercise", text: qText });
      else unit(`Exercise ${ref}`, u, "exercise");
    }
    for (const ref of refs.sections) {
      const ch = ref.split(".")[0];
      const s = structure.sections?.[ch]?.find((x) => x.ref === ref);
      if (s) out.push({ label: `Section ${ref} ${s.title}`, pages: [s.pdfPage, s.pdfPage], kind: "section", text: s.intro });
    }
  }
  for (const page of refs.pages) {
    for (const c of chunks.filter((c) => c.printedPage === page).slice(0, 2)) {
      out.push({ label: `Printed page ${page} (${c.label})`, pages: c.pages, kind: "page", text: c.text });
    }
  }
  return out.slice(0, MAX_STRUCTURAL_PASSAGES);
}

// ------------------------------------------------------------------ public API

const DEVANAGARI = /[ऀ-ॿ]/g;

/**
 * What the lesson is about, for turns whose own words do not say.
 *
 * A teaching turn's last user message is a synthetic nudge ("Continue to the next
 * step.") pushed by the client, not something the student typed — so the history
 * carries no topic at all and search would match the nudge itself. The plan does
 * carry the topic, so teach/doubt/explain turns pass it here.
 */
export type LessonContext = {
  /** `plan.topic`, e.g. "Quadratic Equations". */
  topic?: string;
  /** The step being taught, when there is one: its title and teaching note. */
  step?: { title?: string; teach?: string } | null;
};

/** Words the client puts in the student's mouth to drive the lesson forward. */
const SYNTHETIC_TURN = /^(continue to the next step\.?|begin the lesson\.?)$/i;

/**
 * The text search should match for this turn.
 *
 * Normally that is what the student last said. During a lesson it is the plan's
 * topic plus the current step, because the "student turn" is a synthetic nudge
 * with no topic in it: matching on that retrieves whatever the nudge happens to
 * be nearest to (the same wrong chapter every step).
 */
function buildQuery(userTurns: string[], lesson?: LessonContext | null): string {
  const real = userTurns.filter((t) => !SYNTHETIC_TURN.test(t));
  const planned = [lesson?.topic, lesson?.step?.title, lesson?.step?.teach]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join(" ");
  // A step of a planned lesson: the plan says what this turn teaches. The student's
  // own opening question comes along too — it is how they framed the topic, and it
  // is what makes an opener an opener (see OPENER / addChapterFraming).
  if (planned) return real.length > 0 ? `${real[0]} ${planned}` : planned;

  let query = real.at(-1) ?? userTurns.at(-1) ?? "";
  // Short follow-ups ("haan", "next step", "why?") carry no topic; add the previous question.
  if (query.split(/\s+/).length < 6 && real.length > 1) query = `${real.at(-2)} ${query}`;
  return query;
}

/**
 * Passages from the student's textbook for the latest question, or [] when there is
 * no index for this book or nothing usable. Devanagari questions search the Hindi
 * edition, everything else the English one (falling back to the other if missing).
 */
export async function retrieveTextbookContext(
  book: string,
  messages: HistoryMessage[],
  opts?: { mode?: string; lesson?: LessonContext | null },
): Promise<{ edition: string; passages: Passage[] }> {
  const userTurns = messages.filter((m) => m.role === "user").map((m) => m.text.trim());
  const query = buildQuery(userTurns, opts?.lesson);
  if (!query.trim()) return { edition: "", passages: [] };

  const k = (opts?.mode && TOP_K_BY_MODE[opts.mode]) || TOP_K;
  const letters = query.match(/\p{L}/gu)?.length ?? 0;
  const hindi = letters > 0 && (query.match(DEVANAGARI)?.length ?? 0) / letters >= 0.3;
  for (const edition of hindi ? ["hindi", "english"] : ["english", "hindi"]) {
    const index = await loadIndex(book, edition);
    if (!index) continue;
    // Deterministic first: if the student named a unit by position ("example 2 of
    // chapter 1", "theorem 1.2", "exercise 1.1 q3", "section 8.2", "page 45"), return
    // exactly it and skip the embedding call. Otherwise fall back to hybrid semantic.
    const structural = resolveStructural(index, query);
    const base = structural.length > 0 ? structural : await search(index, query, k);
    return { edition, passages: addChapterFraming(index, query, base, structural.length > 0, k) };
  }
  return { edition: "", passages: [] };
}

/**
 * Prepend teaching context from the chapter the passages belong to: the section outline
 * (so the tutor knows the sequence / where this concept sits) always, and — when the
 * student is OPENING a topic rather than naming a specific unit — the Introduction
 * section (the book's motivating analogy / hook for how to start the topic).
 */
function addChapterFraming(index: Index, query: string, base: Passage[], structural: boolean, k = TOP_K): Passage[] {
  const ch = dominantChapter(base);
  const outline = ch ? index.structure?.outlines?.[ch] : undefined;
  if (!outline) return base;

  // The outline spans the whole chapter; point it at the chapter's first section page.
  const firstPage = index.structure?.sections?.[ch!]?.[0]?.pdfPage ?? 1;
  const framing: Passage[] = [{ label: `Chapter ${ch} · Outline`, pages: [firstPage, firstPage], kind: "outline", text: outline }];
  // An opener that is NOT a specific-unit lookup also gets the chapter's intro/analogy.
  if (!structural && OPENER.test(query)) {
    const sections = index.structure?.sections?.[ch!] ?? [];
    const intro = sections.find((s) => /introduction/i.test(s.title)) ?? sections[0];
    if (intro) framing.push({ label: `Chapter ${ch} · ${intro.title}`, pages: [intro.pdfPage, intro.pdfPage], kind: "section", text: intro.intro });
  }
  const limit = k + framing.length;
  return [...framing, ...base].slice(0, limit);
}
