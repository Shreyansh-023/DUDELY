/**
 * De-duplicate the solutions indexes in place (with a .bak alongside).
 *
 * WHY: a positional lookup ("exercise 4.2 question 2") filters the corpus by
 * exercise and question number and hands the model whatever comes back. When two
 * records share that key, it returns both - and the model answers the wrong one, or
 * the board prints a question the student is not looking at. Measured before this
 * ran: 36/326 ambiguous lookups in class-10-maths, 46/100 in class-10-science,
 * 60/163 in class-6-maths.
 *
 * Duplicates arise two ways, and only the first is a true duplicate:
 *
 *  1. CROSS-PDF. The same chapter was scraped twice - once as a whole-chapter sheet
 *     and once as per-exercise sheets ("... Exercise 4.2 - Free PDF.pdf"). The two
 *     disagree on numbering, so the same question appears under different numbers
 *     and different questions under the same number. One source per (book, chapter)
 *     is kept; the other's records are dropped.
 *
 *  2. SAME-PDF. One sheet genuinely contains several questions under one printed
 *     number (sub-parts the builder did not split, or - in class-6-maths - answer
 *     bullet points mis-parsed as questions). These are NOT duplicates of each
 *     other and must not be dropped: dropping them loses real content. They are
 *     left alone, and `scripts/exercise-drift.mts` keeps reporting them.
 *
 * Choosing which source wins, in order:
 *   - more questions covered for that chapter (a whole-chapter sheet beats one
 *     exercise's sheet);
 *   - then better math_quality (clean > degraded > poor);
 *   - then more answer text.
 *
 * Usage: npx tsx scripts/dedupe-solutions.mts [--apply] [--book <key>]
 *        Without --apply it only reports.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";

const SOLUTIONS = "rag/data/index/solutions";

type Chunk = {
  id: string;
  chapter: number | null;
  exercise: string | null;
  number: string | null;
  question: string;
  answer: string;
  mathQuality: string;
  sourcePdf: string;
};

const QUALITY: Record<string, number> = { clean: 3, degraded: 2, poor: 1 };

const apply = process.argv.includes("--apply");
// NB: indexOf returns -1 when the flag is absent, and argv[0] is the node binary -
// so this must be guarded, or every book is filtered out and the run does nothing.
const bookFlag = process.argv.indexOf("--book");
const onlyBook = bookFlag >= 0 ? process.argv[bookFlag + 1] : null;

/** Main part of a printed number: "3(ii)" -> "3". Mirrors lib/solutions. */
function mainNumber(n: string | null): string {
  if (!n) return "";
  const m = String(n).match(/^\s*(\d+|[A-Za-z])/);
  return (m?.[1] ?? n).toLowerCase();
}

/** The sub-part of a printed number: "3(ii)" -> "ii", "3" -> null. */
function partOf(n: string | null): string | null {
  return String(n ?? "").match(/^\s*(?:\d+|[A-Za-z])\s*\(([^)]+)\)/)?.[1]?.toLowerCase() ?? null;
}

/**
 * How ambiguous positional lookup actually is - the metric this script moves.
 *
 * "Exercise 5.1 question 3" is MEANT to return 3, 3(ii), 3(iii) ... together: the
 * sub-parts are the question. So only records that collide on the SAME sub-part
 * (two different "3", or two different "3(ii)") are a real ambiguity; counting a
 * bare number against its own sub-parts reports sub-part support as a defect.
 */
function ambiguity(chunks: Chunk[]): { ambiguous: number; total: number } {
  const byKey = new Map<string, Set<string>>();
  for (const c of chunks) {
    if (!c.exercise || c.number == null) continue;
    // Scope by chapter too: in science, `exercise` is a bare "1" per chapter.
    const key = `${c.chapter}|${c.exercise}|${mainNumber(c.number)}|${partOf(c.number) ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(c.question.replace(/\s+/g, " ").trim().slice(0, 70));
  }
  let ambiguous = 0;
  for (const qs of byKey.values()) if (qs.size > 1) ambiguous++;
  return { ambiguous, total: byKey.size };
}

const books = readdirSync(SOLUTIONS).filter((b) => (onlyBook ? b === onlyBook : true)).sort();

for (const book of books) {
  const file = `${SOLUTIONS}/${book}/chunks.json`;
  if (!existsSync(file)) continue;
  const chunks = JSON.parse(readFileSync(file, "utf8")) as Chunk[];

  // Which source PDFs feed each chapter?
  const byChapter = new Map<string, Map<string, Chunk[]>>();
  for (const c of chunks) {
    const ch = String(c.chapter ?? "?");
    if (!byChapter.has(ch)) byChapter.set(ch, new Map());
    const perPdf = byChapter.get(ch)!;
    const pdf = String(c.sourcePdf);
    if (!perPdf.has(pdf)) perPdf.set(pdf, []);
    perPdf.get(pdf)!.push(c);
  }

  const dropped = new Set<string>();
  const notes: string[] = [];
  for (const [ch, perPdf] of byChapter) {
    if (perPdf.size < 2) continue;
    // Rank the candidate sources and keep the best one for this chapter.
    const ranked = [...perPdf.entries()]
      .map(([pdf, cs]) => {
        const numbered = cs.filter((c) => c.exercise && c.number != null);
        const quality =
          numbered.reduce((a, c) => a + (QUALITY[c.mathQuality] ?? 0), 0) / Math.max(1, numbered.length);
        const text = cs.reduce((a, c) => a + c.answer.length, 0);
        return { pdf, cs, covered: numbered.length, quality, text };
      })
      .sort((a, b) => b.covered - a.covered || b.quality - a.quality || b.text - a.text);
    const [winner, ...losers] = ranked;
    // Drop only what the winner can actually REPLACE. A loser's record whose
    // (exercise, number) the winner does not carry is unique content - usually a
    // chapter sheet that labelled nothing, beside an exercise sheet that did - and
    // dropping it would lose a question the student can still ask for by name.
    const winnerKeys = new Set(
      winner.cs.filter((c) => c.exercise && c.number != null).map((c) => `${c.exercise}|${c.number}`),
    );
    for (const l of losers) {
      for (const c of l.cs) {
        if (!c.exercise || c.number == null) continue; // unlabelled: only reachable by search, keep it
        if (winnerKeys.has(`${c.exercise}|${c.number}`)) dropped.add(c.id);
      }
    }
    notes.push(
      `  ch${ch}: keep ${winner.pdf.split(/[\/]/).pop()} (${winner.covered} q) ` +
        `drop ${losers.map((l) => `${l.pdf.split(/[\/]/).pop()} (${l.covered} q)`).join(", ")}`,
    );
  }

  const before = ambiguity(chunks);
  const kept = chunks.filter((c) => !dropped.has(c.id));
  const after = ambiguity(kept);
  if (!dropped.size && before.ambiguous === 0) continue; // nothing to report

  console.log(`\n## ${book}`);
  if (notes.length) console.log(notes.join("\n"));
  console.log(
    `  chunks ${chunks.length} -> ${kept.length} (dropped ${dropped.size}) | ` +
      `ambiguous lookups ${before.ambiguous}/${before.total} -> ${after.ambiguous}/${after.total}`,
  );
  if (after.ambiguous > 0) {
    console.log(`  NOTE: ${after.ambiguous} remain - several questions under one printed number in a single sheet, not duplicates.`);
  }

  if (apply && dropped.size) {
    // vectors.f32 is POSITIONAL: row i belongs to chunks[i], and search() walks
    // meta.count rows. Rewriting chunks without the vectors and meta would pair
    // every later question with another question's embedding - silent, and far
    // worse than the duplicates this script removes. All three move together.
    const dir = `${SOLUTIONS}/${book}`;
    const metaFile = `${dir}/meta.json`;
    const vecFile = `${dir}/vectors.f32`;
    const keepIndex = chunks.map((c) => !dropped.has(c.id));

    copyFileSync(file, `${file}.bak`);
    writeFileSync(file, JSON.stringify(kept, null, 0));

    if (existsSync(vecFile) && existsSync(metaFile)) {
      const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { count: number; dim: number };
      const buf = readFileSync(vecFile);
      const rows = buf.byteLength / 4 / meta.dim;
      if (rows !== chunks.length) {
        console.log(`  WARNING: ${vecFile} has ${rows} rows for ${chunks.length} chunks; leaving vectors alone`);
      } else {
        copyFileSync(vecFile, `${vecFile}.bak`);
        copyFileSync(metaFile, `${metaFile}.bak`);
        const src = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const out = new Float32Array(kept.length * meta.dim);
        let w = 0;
        for (let i = 0; i < keepIndex.length; i++) {
          if (!keepIndex[i]) continue;
          out.set(src.subarray(i * meta.dim, (i + 1) * meta.dim), w * meta.dim);
          w++;
        }
        writeFileSync(vecFile, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
        writeFileSync(metaFile, JSON.stringify({ ...meta, count: kept.length }, null, 2) + "\n");
      }
    }
    console.log(`  wrote ${file}, vectors.f32 and meta.json (backups alongside as .bak)`);
  }
}

if (!apply) console.log("\n(dry run - pass --apply to write)");
