/* eslint-disable */
/**
 * Offline regression suite for the findings in qa-report/INDICA_QA_FINDINGS.md.
 *
 * No server, no API key, no cost: it searches the real on-disk textbook index
 * (BM25 only — `embedQuery` returns null without NVIDIA_API_KEY), parses plans
 * through the real zod schema, and expands draw ops through the real canvas
 * primitives. Those three cover every finding that is code rather than prompt
 * wording, so a regression shows up here instead of in a live lesson.
 *
 *   node scripts/qa-regress.mjs
 *
 * Exits non-zero if anything fails. Prompt-side findings (P1-4 "the board is
 * prose", P2-7 "unspoken board text", P3-11 placement) are model behaviour and
 * cannot be asserted here; what IS asserted is that every diagram those lessons
 * failed to draw renders correctly when the model does reach for it.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

// BM25-only retrieval: no embedding API call, so this runs free and offline.
delete process.env.NVIDIA_API_KEY;
process.env.RAG_INDEX_DIR = process.env.RAG_INDEX_DIR || path.join(ROOT, "rag", "data", "index");

let pass = 0;
const failures = [];
function check(ok, name, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
}
const section = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------- P0-1 grounding

const { retrieveTextbookContext } = await import(mod("src/lib/rag.ts"));

const NUDGE = "Continue to the next step.";
/** The history a teach turn really sends from step 3 on: two synthetic nudges. */
const teachHistory = (topic) => [
  { role: "user", text: topic },
  { role: "assistant", text: "..." },
  { role: "user", text: NUDGE },
  { role: "assistant", text: "..." },
  { role: "user", text: NUDGE },
];
const chaptersOf = (passages) => [
  ...new Set(passages.map((p) => (p.label.match(/Chapter (\d+)/) || [])[1]).filter(Boolean)),
];

section("P0-1  textbook grounding follows the plan, not the nudge");
for (const [name, book, topic, lesson, want] of [
  [
    "C10 Maths quadratics, teach step 3 -> Ch 4",
    "ncert-class-10-maths",
    "Teach me quadratic equations",
    { topic: "Quadratic Equations", step: { title: "Derivation by completing the square", teach: "Derive the formula." } },
    "4",
  ],
  [
    "C10 Maths quadratics, last step -> Ch 4",
    "ncert-class-10-maths",
    "Teach me quadratic equations",
    { topic: "Quadratic Equations", step: { title: "Quick check", teach: "A practice question." } },
    "4",
  ],
  [
    "C8 Science reflection -> Ch 10",
    "ncert-class-8-science",
    "Teach me about reflection of light",
    { topic: "Reflection of Light", step: { title: "Regular vs diffuse reflection", teach: "Mirror versus paper." } },
    "10",
  ],
]) {
  const { passages } = await retrieveTextbookContext(book, teachHistory(topic), { mode: "teach", lesson });
  const got = chaptersOf(passages);
  check(got.includes(want), name, `wanted Ch ${want}, got Ch ${got.join(", ") || "none"}`);
}
{
  // Without a plan nothing changes: a real student doubt still drives the query.
  const { passages } = await retrieveTextbookContext(
    "ncert-class-10-maths",
    [
      { role: "user", text: "Teach me quadratic equations" },
      { role: "assistant", text: "..." },
      { role: "user", text: "why do we complete the square?" },
    ],
    { mode: "doubt", lesson: null },
  );
  const got = chaptersOf(passages);
  check(got.includes("4"), "no plan (doubt): student's own words still used", `got Ch ${got.join(", ")}`);
}
{
  // The regression itself: nudge-only history with no plan must NOT be trusted.
  const { passages } = await retrieveTextbookContext(
    "ncert-class-10-maths",
    teachHistory("Teach me quadratic equations"),
    { mode: "teach", lesson: null },
  );
  const got = chaptersOf(passages);
  check(got.includes("4"), "nudges are ignored, the real question is used instead", `got Ch ${got.join(", ")}`);
}

// ---------------------------------------------------------------- P1-5 titles

section("P1-5  bilingual step titles never reach the board");
const { LessonPlanSchema, LessonStepSchema, BeatSchema } = await import(mod("src/lib/schema.ts"));
const title = (t) => LessonStepSchema.parse({ title: t }).title;
for (const [input, want, note] of [
  ["Real-life hook / Quadratic Equations in daily life", "Real-life hook", "observed L1 step 1"],
  ["Standard form / Standard form", "Standard form", "observed L1 degenerate duplicate"],
  ["Real-life hook: Mirror / Mirror image", "Real-life hook: Mirror", "observed L3 step 1"],
  ["Quick check / Quick practice", "Quick check", "observed L1 step 7"],
  ["Derivation by completing the square", "Derivation by completing the square", "clean title untouched"],
  ["Speed in cm/s", "Speed in cm/s", "unit slash kept"],
  ["Regular / diffuse", "Regular / diffuse", "two-word listing kept"],
]) {
  const got = title(input);
  check(got === want, `${note}`, `${JSON.stringify(input)} -> ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
{
  const plan = LessonPlanSchema.parse({ topic: "x", steps: [{ title: "A / A long second half" }] });
  check(plan.steps[0].title === "A", "the transform runs on the whole-plan parse too");
}

// ---------------------------------------------------------------- canvas primitives

section("P2-6 / P3-10 / P1-4  draw ops render correctly");
const { PRIMITIVES } = await import(mod("src/lib/canvas/primitives/index.ts"));
const CONTENT = { x1: 80, y1: 80, x2: 1200, y2: 660 };

/** Expand one op and report what is wrong with the result, or null if it is fine. */
function diagnose(op) {
  const fn = PRIMITIVES[op.op];
  if (!fn) return `no primitive registered for "${op.op}"`;
  const { ops, bbox } = fn(op);
  if (ops.length === 0) return "expanded to nothing";
  const texts = ops.filter((o) => o.op === "text");
  // A duplicate is the same text at (nearly) the same place — the P2-6 bug. The
  // same word elsewhere is correct: both axes tick "-4", four equal pie slices
  // all read "25%", a number line labels 1/3 as a tick AND as a mark above it.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.text === b.text && Math.abs(a.x - b.x) < 8 && Math.abs(a.y - b.y) < 8) {
        return `label ${JSON.stringify(a.text)} drawn twice at (${Math.round(a.x)},${Math.round(a.y)})`;
      }
    }
  }
  const zero = ops.filter((o) => (o.op === "line" || o.op === "arrow") && o.x === o.x2 && o.y === o.y2);
  if (zero.length) return `${zero.length} zero-length line(s)`;
  const pad = 40;
  if (
    bbox.x < CONTENT.x1 - pad ||
    bbox.y < CONTENT.y1 - pad ||
    bbox.x + bbox.w > CONTENT.x2 + pad ||
    bbox.y + bbox.h > CONTENT.y2 + pad
  ) {
    return `bbox ${Math.round(bbox.x)},${Math.round(bbox.y)} ${Math.round(bbox.w)}x${Math.round(bbox.h)} leaves the page`;
  }
  return null;
}
const draws = (name, op) => check(diagnose(op) === null, name, diagnose(op) ?? undefined);

// P2-6: the exact op from the report — a square sent as 5 points, every vertex "surface".
{
  const op = {
    op: "polygon",
    id: "topview",
    points: [
      { x: 680, y: 200, label: "surface" },
      { x: 880, y: 200, label: "surface" },
      { x: 880, y: 400, label: "surface" },
      { x: 680, y: 400, label: "surface" },
      { x: 680, y: 200, label: "surface" },
    ],
  };
  draws("P2-6  one name for the whole polygon, not one per vertex", op);
  const { ops, label } = PRIMITIVES.polygon(op);
  const said = ops.filter((o) => o.op === "text" && o.text === "surface").length;
  check(said === 1, "P2-6  'surface' is written exactly once", `written ${said}x`);
  check(label === "polygon (4 pts)", "P2-6  the repeated closing vertex is dropped", `got ${label}`);
}
// P2-6 regression: distinct labels must still be placed per vertex.
{
  const { ops } = PRIMITIVES.polygon({
    op: "polygon",
    id: "t",
    points: [
      { x: 180, y: 400, label: "A" },
      { x: 420, y: 400, label: "B" },
      { x: 420, y: 180, label: "C" },
    ],
    sides: ["c", "a", "b"],
  });
  const labels = ops.filter((o) => o.op === "text").map((o) => o.text).sort().join("");
  check(labels === "ABCabc", "P2-6  triangle ABC still labels every vertex and side", `got ${labels}`);
}

// P3-10: fraction ticks, both ways the model can ask for them.
const tickLabels = (op) =>
  PRIMITIVES.numberline(op)
    .ops.filter((o) => o.op === "text" && /\.l\d+$/.test(o.id))
    .map((o) => o.text)
    .join(" ");
for (const [name, op, want] of [
  [
    "P3-10  inferred from fraction marks (what L2 actually sent)",
    { op: "numberline", id: "nl", x: 120, y: 400, w: 520, min: 0, max: 1, marks: [{ at: 1 / 3, label: "1/3" }, { at: 2 / 3, label: "2/3" }] },
    "0 1/3 2/3 1",
  ],
  ["P3-10  explicit denominator:3", { op: "numberline", id: "nl", min: 0, max: 1, denominator: 3 }, "0 1/3 2/3 1"],
  ["P3-10  quarters reduce to lowest terms", { op: "numberline", id: "nl", min: 0, max: 1, denominator: 4 }, "0 1/4 1/2 3/4 1"],
  ["P3-10  a plain line is untouched", { op: "numberline", id: "nl", min: -5, max: 5, step: 1 }, "-5 -4 -3 -2 -1 0 1 2 3 4 5"],
  [
    "P3-10  a plain 0..1 line stays decimal",
    { op: "numberline", id: "nl", min: 0, max: 1 },
    "0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1",
  ],
  [
    "P3-10  integer marks do not trigger fraction mode",
    { op: "numberline", id: "nl", min: -5, max: 5, marks: [{ at: -2, label: "A" }, { at: 3, label: "B" }] },
    "-5 -4 -3 -2 -1 0 1 2 3 4 5",
  ],
  [
    "P3-10  an explicit step wins over fraction marks",
    { op: "numberline", id: "nl", min: 0, max: 1, step: 0.5, marks: [{ at: 1 / 3, label: "1/3" }] },
    "0 0.5 1",
  ],
]) {
  const got = tickLabels(op);
  check(got === want, name, `ticks "${got}", wanted "${want}"`);
}

// P1-4: every diagram the three lessons should have drawn, and didn't.
draws("P1-4  L1 parabola via `axes` (the board was 98% plain text)", {
  op: "axes", id: "p", x: 620, y: 160, w: 440, h: 380, xmin: -4, xmax: 4, ymin: -4, ymax: 12,
  text: "y = x^2 - 2x - 3",
  points: [{ x: -1, y: 0, label: "x=-1" }, { x: 3, y: 0, label: "x=3" }, { x: 1, y: -4, label: "vertex" }],
});
draws("P1-4  L2 roti via `pie` (the board showed only text)", {
  op: "pie", id: "roti", x: 820, y: 360, w: 280,
  data: [{ label: "1/4", value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }],
  text: "Ek roti, 4 barabar hisse",
});
draws("P1-4  L2 one quarter via `fraction`", { op: "fraction", id: "f1", x: 120, y: 300, w: 420, parts: 4, shaded: 1, text: "1/4" });
draws("P1-4  L2 equivalence via `fraction` (was hand-built from ellipse+line+line)", {
  op: "fraction", id: "f2", x: 120, y: 440, w: 420, parts: 8, shaded: 2, text: "2/8 = 1/4",
});
draws("P1-4  L3 rays via `optics` (was 12 raw lines, two byte-identical)", {
  op: "optics", id: "o", x: 620, y: 400, device: "concave-mirror", f: 10, objectAt: 25, objectH: 6, scale: 12,
  text: "Concave mirror",
});

// A draw op has to survive BeatSchema too: DrawOpSchema silently drops ops that
// fail validation, so a new field that is not in the schema would vanish here
// rather than erroring, and the board would simply stay decimal.
{
  const beat = BeatSchema.parse({
    say: "dekho",
    lang: "en-IN",
    draw: [{ op: "numberline", id: "nl", x: 120, y: 400, w: 520, min: 0, max: 1, denominator: 3 }],
  });
  check(beat.draw.length === 1 && beat.draw[0].denominator === 3, "P3-10  `denominator` survives BeatSchema parsing");
}

// ---------------------------------------------------------------- P3-8 fonts

section("P3-8  one board, one typeface");
const { boardFontFamily, needsMathFont, needsHandToMathSwitch, MATH_FONT_FAMILY } = await import(mod("src/lib/canvas/ops.ts"));
/** Replays a page the way the player does: draw in order, latch, restyle. */
function drawPage(lines) {
  let mathFont = false;
  const page = [];
  for (const text of lines) {
    if (!mathFont && needsMathFont(text)) {
      mathFont = true;
      for (const e of page) if (needsHandToMathSwitch(e.text)) e.font = MATH_FONT_FAMILY;
    }
    page.push({ text, font: boardFontFamily(text, mathFont) });
  }
  return page;
}
{
  // The observed L1 board: the glyph that forces the fallback is on line 3.
  const page = drawPage([
    "Quadratic Formula",
    "x = [-b +/- sqrt(b^2-4ac)] / 2a",
    "x = [5 ± √49] / 4",
    "x = [5 ± 7] / 4",
    "So x = 3 or x = -1/2",
  ]);
  check(new Set(page.map((e) => e.font)).size === 1, "P3-8  the whole board ends in one font");
}
{
  const page = drawPage(["Fractions", "Cut the roti into 4 equal parts", "1/2 = 2/4"]);
  check(page.every((e) => e.font !== MATH_FONT_FAMILY), "P3-8  a board with no math glyph stays hand-drawn");
}
{
  // The fallback font has no Devanagari: switching it would drop the letters.
  const page = drawPage(["x = √49", "यह है उत्तर"]);
  check(page[1].font !== MATH_FONT_FAMILY, "P3-8  Devanagari is never switched, even on a latched page");
}

// ---------------------------------------------------------------- P1-3 filler

section("P1-3  the planning wait is never silent");
const { planningLines, planningHolds, planningStepLead } = await import(mod("src/lib/languages.ts"));
const { LANGUAGES } = await import(mod("src/lib/languages.ts"));
const SEC_PER_LINE = 5; // ~5s of speech at TTS_PACE 0.8 (the report measured 2 lines ~ 10s)
/** Replays speakLines(): written lines, then step titles, then holds, cycling. */
function cover(lang, waitSecs, stepTitles, titlesAtSec = 2) {
  let t = 0;
  const written = planningLines(lang);
  const holds = planningHolds(lang);
  for (let i = 0; i < written.length && t < waitSecs; i++) t += SEC_PER_LINE;
  let steps = 0;
  while (t < waitSecs) {
    const available = t >= titlesAtSec ? stepTitles : 0;
    if (steps < available) steps++;
    else if (holds.length === 0) break;
    t += SEC_PER_LINE;
  }
  return Math.max(0, waitSecs - t);
}
// Every plan latency the report measured, in the session default language.
for (const [name, secs, steps] of [
  ["L1 26.8s", 26.8, 7],
  ["L2 127.1s (the worst case)", 127.1, 6],
  ["L3 39.9s", 39.9, 8],
  ["C7 photosynthesis 41.6s", 41.6, 6],
  ["C10 trigonometry 64.8s", 64.8, 6],
]) {
  check(cover("en-IN", secs, steps) === 0, `P1-3  ${name} is fully covered`, `${cover("en-IN", secs, steps)}s of silence`);
}
// The worst case made worse: the planner reasons for 99s before publishing a title.
check(cover("en-IN", 127.1, 6, 99) === 0, "P1-3  covered even when step titles arrive very late");
// Every language must survive the worst case, not just the three with long scripts.
for (const { code } of LANGUAGES) {
  check(cover(code, 127.1, 6) === 0, `P1-3  ${code} covers the 127s worst case`);
  check(planningStepLead(code, 2, "Standard form").includes("Standard form"), `P1-3  ${code} has a step lead`);
}

// ---------------------------------------------------------------- done

console.log(`\n================ ${pass} passed, ${failures.length} failed ================`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
