/**
 * Audit the two indexes against each other, book by book.
 *
 * The textbook index is built from current-edition NCERT PDFs; the solutions index
 * from third-party solution sheets that may still follow an older edition. Where the
 * editions disagree, a positional lookup ("exercise 1.2 question 1") resolves to the
 * right slot in the WRONG book — a confidently-labelled answer to a question the
 * student is not looking at. That is invisible at runtime, so it is checked here.
 *
 * Nothing is trusted by label. Chapters are matched by TITLE and exercises by the
 * TEXT of their first question, so the report says what the two corpora actually
 * contain rather than what they claim.
 *
 * Usage:  npx tsx scripts/exercise-drift.mts [--write]
 *   --write  emit rag/data/index/exercise-aliases.json, the map lib/solutions uses
 *            to translate a student's (current-edition) reference into the
 *            solutions index's own numbering.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";

const INDEX = "rag/data/index";
const SOLUTIONS = `${INDEX}/solutions`;
/** Below this, a pairing is reported but never written into the alias map. */
const CONFIDENT = 0.85;

type SolChunk = {
  exercise: string | null;
  number: string | null;
  question: string;
  chapter: number | null;
  chapterTitle: string | null;
};
type TbChunk = { text?: string; label?: string };

/** Content words only: shared scaffolding ("find the following") carries no signal. */
const words = (s: string) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 3));

/** Overlap against the SMALLER set, so a terse question still matches its verbose twin. */
function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

/**
 * Chapter titles differ in punctuation and subtitle between editions, so compare on
 * letters and digits alone - but compare the WHOLE string. Truncating to a prefix
 * silently paired "Proportional Reasoning-1" with "Proportional Reasoning 2", which
 * are different chapters; a trailing digit is exactly the part that must survive.
 * A title that is a strict prefix of the other (a dropped subtitle) still counts.
 */
const titleKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^chapter\d+/, "");

function sameChapter(a: string, b: string): boolean {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One side may carry a subtitle the other drops ("Measuring Space" vs "Measuring
  // Space: Perimeter and Area"). Allow a prefix match, but only when neither title
  // ends in a part number: "We the Travellers I" and "We the Travellers II" are
  // different chapters, and so are "Proportional Reasoning 1" and "... 2".
  const part = /(?:[0-9]+|i{1,3}v?|iv|vi{0,3})$/;
  if (part.test(x) || part.test(y)) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 10 && long.startsWith(short);
}

/**
 * Exercise headings as the CURRENT textbook prints them, with the first question.
 * Class 10 uses "EXERCISE 1.1"; Class 9 uses "Exercise Set 1.1"; the primary books
 * and the new-syllabus middle books use named blocks ("Figure it Out", "Let us Do")
 * that carry no number at all — those simply yield nothing, which is correct.
 */
function currentExercises(book: string): Map<string, string> {
  const out = new Map<string, string>();
  const f = `${INDEX}/${book}/english/chunks.json`;
  if (!existsSync(f)) return out;
  for (const chunk of JSON.parse(readFileSync(f, "utf8")) as TbChunk[]) {
    const text = chunk.text ?? "";
    for (const m of text.matchAll(/(?:EXERCISE|Exercise)(?:\s+Set)?\s+(\d+\.\d+)/g)) {
      if (out.has(m[1])) continue;
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 320);
      const q1 = after.match(/1\s*[.)]\s*([\s\S]{0,180})/);
      if (q1) out.set(m[1], q1[1].replace(/\s+/g, " ").trim());
    }
  }
  return out;
}

function chapterTitles(book: string): Map<number, string> {
  const out = new Map<number, string>();
  const f = `${INDEX}/${book}/english/chunks.json`;
  if (!existsSync(f)) return out;
  for (const c of JSON.parse(readFileSync(f, "utf8")) as TbChunk[]) {
    const m = (c.label ?? "").match(/Chapter (\d+):\s*(.+)/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

function loadSolutions(book: string): SolChunk[] {
  const f = `${SOLUTIONS}/${book}/chunks.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as SolChunk[]) : [];
}

const books = readdirSync(INDEX).filter((b) => b !== "solutions").sort();
const aliases: Record<string, { exercises?: Record<string, string>; chapters?: Record<string, string> }> = {};
const summary: string[] = [];

for (const book of books) {
  const hasTb = existsSync(`${INDEX}/${book}/english/chunks.json`);
  const sol = loadSolutions(book);
  if (!hasTb || !sol.length) {
    summary.push(`${book.padEnd(24)} ${!hasTb ? "no textbook index" : "no solutions index"}`);
    continue;
  }

  const lines: string[] = [];
  const exMap: Record<string, string> = {};
  const chMap: Record<string, string> = {};

  // --- chapters, matched by title -------------------------------------------
  const tbCh = chapterTitles(book);
  const solCh = new Map<number, string>();
  for (const s of sol) if (s.chapter != null && s.chapterTitle) solCh.set(Number(s.chapter), s.chapterTitle);
  for (const [n, title] of [...tbCh].sort((a, b) => a[0] - b[0])) {
    let found: number | null = null;
    for (const [sn, st] of solCh) if (sameChapter(st, title)) found = sn;
    if (found != null && found !== n) {
      lines.push(`  chapter ${n} "${title}" is chapter ${found} in solutions   SHIFTED`);
      chMap[String(n)] = String(found);
    }
  }
  const orphanCh = [...solCh].filter(([, st]) => ![...tbCh.values()].some((t) => sameChapter(t, st)));
  for (const [sn, st] of orphanCh) lines.push(`  solutions chapter ${sn} "${st}" is not in the current textbook`);

  // --- exercises, matched by first-question text -----------------------------
  const cur = currentExercises(book);
  const solEx = new Map<string, string>();
  for (const s of sol) if (s.exercise && s.number === "1" && !solEx.has(s.exercise)) solEx.set(s.exercise, s.question);

  let aligned = 0;
  let shifted = 0;
  let weak = 0;
  for (const [ex, q] of [...cur].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    const chapter = ex.split(".")[0];
    let best = "";
    let score = 0;
    // An exercise never migrates across chapters, so only compare within one —
    // unless the chapter itself moved, in which case follow it there.
    const target = chMap[chapter] ?? chapter;
    for (const [se, sq] of solEx) {
      if (se.split(".")[0] !== target) continue;
      const v = similarity(q, sq);
      if (v > score) { score = v; best = se; }
    }
    if (!best) { weak++; continue; }
    if (score < CONFIDENT) { lines.push(`  exercise ${ex} -> ${best} (${score.toFixed(2)}) too weak to alias`); weak++; continue; }
    if (best === ex) { aligned++; continue; }
    lines.push(`  exercise ${ex} -> ${best} (${score.toFixed(2)})   SHIFTED`);
    exMap[ex] = best;
    shifted++;
  }

  if (Object.keys(exMap).length || Object.keys(chMap).length) {
    aliases[book] = {};
    if (Object.keys(exMap).length) aliases[book].exercises = exMap;
    if (Object.keys(chMap).length) aliases[book].chapters = chMap;
  }

  const numbered = cur.size > 0 && solEx.size > 0;
  summary.push(
    `${book.padEnd(24)} ${
      numbered
        ? `exercises: ${aligned} aligned, ${shifted} shifted, ${weak} unmatched`
        : `no numbered exercises on ${cur.size ? "the solutions" : "the textbook"} side`
    }${orphanCh.length ? ` | ${orphanCh.length} orphan chapter(s)` : ""}`,
  );
  if (lines.length) {
    console.log(`\n## ${book}`);
    console.log(lines.join("\n"));
  }
}

console.log("\n=== SUMMARY ===");
console.log(summary.join("\n"));

if (process.argv.includes("--write")) {
  const out = `${INDEX}/exercise-aliases.json`;
  writeFileSync(out, JSON.stringify(aliases, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
}
