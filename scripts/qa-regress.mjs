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

section("P3-8  the board stays hand-drawn: roots are drawn, not fonted");
const { boardFontFamily, MATH_FONT_FAMILY } = await import(mod("src/lib/canvas/ops.ts"));
const { layoutMathLine, hasMathNotation, flattenMath } = await import(mod("src/lib/canvas/mathtext.ts"));
{
  // The observed L1 board: the glyph that used to force a page-wide fallback.
  const laid = layoutMathLine("x = [5 ± √49] / 4", 24);
  check(laid && laid.strokes.length === 3, "P3-8  √49 is drawn as three strokes (tick, up-stroke, bar)");
  check(laid && laid.runs.every((r) => !r.text.includes("√")), "P3-8  no text run carries the √ glyph");
  check(laid && laid.runs.some((r) => r.text === "49"), "P3-8  the radicand is an ordinary hand-font run");
  check(boardFontFamily("x = [5 ± √49] / 4") !== MATH_FONT_FAMILY, "P3-8  a line with √ stays in the hand font");
}
{
  const laid = layoutMathLine("c = √(a^2 + b^2)", 24);
  const sups = laid ? laid.runs.filter((r) => r.level === "sup").map((r) => r.text) : [];
  check(laid && laid.strokes.length === 3 && sups.join("") === "22", "P3-8  √(a^2 + b^2) keeps its superscripts under the bar", `sups ${sups}`);
  const bar = laid?.strokes[2];
  const last = laid ? Math.max(...laid.runs.map((r) => r.dx)) : 0;
  check(bar && bar.x2 > last, "P3-8  the bar reaches past the last run of the radicand");
}
{
  check(boardFontFamily("x ≤ 5") === MATH_FONT_FAMILY, "P3-8  a line with ≤ falls back by itself");
  check(boardFontFamily("so x = 5") !== MATH_FONT_FAMILY, "P3-8  its neighbour stays hand-drawn (no page latch)");
  check(boardFontFamily("यह है √49") !== MATH_FONT_FAMILY, "P3-8  Devanagari never switches font");
}
check(hasMathNotation("√5") && hasMathNotation("√ 5") && !hasMathNotation("the roots"), "P3-8  hasMathNotation sees √ with its radicand");
check(flattenMath("√(a^2)") === "√(a2)", "P3-8  the summary keeps the √ sign and drops the caret");

// ---------------------------------------------------------------- L-1 layout

section("L-1  layout is deterministic: no overlap, no orphan heading, anchors on the figure");
const L = await import(mod("src/lib/canvas/layout.ts"));
const A = await import(mod("src/lib/canvas/anchors.ts"));
const PL = await import(mod("src/lib/canvas/primitives/place.ts"));
const { scaleOp } = await import(mod("src/lib/canvas/primitives/util.ts"));
const { CONTENT_LEFT, CONTENT_RIGHT, CONTENT_BOTTOM, CONTENT_TOP, STEP_BODY_TOP } = await import(mod("src/lib/canvas/page.ts"));
const { mockLesson } = await import(mod("src/lib/mock-lesson.ts"));

/** Node has no canvas: the same 0.6em-per-character estimate measure.ts falls back to. */
const measure = (t, px) => t.length * px * 0.6;
const headed = () => ({ cursorY: STEP_BODY_TOP, floats: [] });
const textBlocks = (lines) => lines.map((text, i) => L.textBlockOf({ op: "text", text }, i));
/** Model-coordinate bbox of free-form ops, the way the player measures a block. */
function bboxOfOps(ops) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const o of ops) {
    const w = o.op === "text" ? measure(o.text ?? "", 16) : Math.abs((o.x2 ?? o.x + (o.w ?? 0)) - o.x);
    const h = o.op === "text" ? 20 : Math.abs((o.y2 ?? o.y + (o.h ?? 0)) - o.y);
    x1 = Math.min(x1, o.x, o.x2 ?? o.x); y1 = Math.min(y1, o.y, o.y2 ?? o.y);
    x2 = Math.max(x2, o.x + (o.x2 != null ? 0 : w), o.x2 ?? -Infinity); y2 = Math.max(y2, o.y + (o.y2 != null ? 0 : h), o.y2 ?? -Infinity);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
const box = (kind, index, bbox, extra = {}) => ({ kind, index, ops: [], bbox, scalable: true, place: null, ...extra });
const textH = (p) => L.textBlockHeight(p.lines.length, p.fontPx, p.math);
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// 1. Fourteen md lines on a headed page: break after the tenth, nothing past the bottom, nothing overprinted.
{
  const res = L.layoutBeat(textBlocks(Array.from({ length: 14 }, (_, i) => `line ${i + 1}`)), headed(), null, measure, { startsFresh: true });
  const onPage = (n) => res.placements.filter((p) => p.page === n);
  check(res.pages.length === 2 && onPage(0).length === 10 && onPage(1).length === 4, "L-1  14 md lines break 10 + 4 across two pages", `${res.pages.length} pages, ${onPage(0).length}+${onPage(1).length}`);
  check(res.placements.every((p) => p.y + textH(p) <= CONTENT_BOTTOM), "L-1  no line runs past CONTENT_BOTTOM");
  const ys = onPage(0).map((p) => p.y);
  check(ys.every((y, i) => i === 0 || y - ys[i - 1] >= 30), "L-1  lines on one page are at least a line apart");
  check(onPage(1)[0].y === CONTENT_TOP, "L-1  the continuation starts at the top of the fresh page");
}
// 2. A figure too tall for the headed page is scaled to fit it: the heading is never orphaned.
{
  const res = L.layoutBeat([box("figure", 0, { x: 0, y: 0, w: 300, h: 600 })], headed(), null, measure, { startsFresh: true });
  const p = res.placements[0];
  check(res.pages.length === 1 && p.page === 0, "L-1  a 600px figure stays on the heading's page");
  check(p.scale < 1 && p.y + 600 * p.scale <= CONTENT_BOTTOM + 0.5, "L-1  ... scaled to fit the room under the heading", `scale ${p.scale}`);
}
// 3. Text + narrow figure in one beat: figure floats right, text flows left, no overlap.
{
  const blocks = [L.textBlockOf({ op: "text", text: "sin A = opposite / hypotenuse" }, 0), box("figure", 1, { x: 0, y: 0, w: 300, h: 250 })];
  const res = L.layoutBeat(blocks, headed(), null, measure, { startsFresh: true });
  const fig = res.placements.find((p) => p.kind === "box");
  const txt = res.placements.find((p) => p.kind === "text");
  check(fig.x === CONTENT_RIGHT - 300 && fig.y === STEP_BODY_TOP, "L-1  the figure floats to the right at the beat's top", `(${fig.x},${fig.y})`);
  check(txt.x === CONTENT_LEFT && txt.y === STEP_BODY_TOP, "L-1  the text flows at the left beside it");
  const tb = { x: txt.x, y: txt.y, w: measure(txt.lines.join(""), 24), h: textH(txt) };
  check(!overlaps(tb, { x: fig.x, y: fig.y, w: 300, h: 250 }), "L-1  text and figure do not overlap");
  check(res.pages[0].floats.length === 1, "L-1  the page remembers the float for the next beat");
}
// 4. Two narrow figures in one beat sit side by side.
{
  const res = L.layoutBeat([box("figure", 0, { x: 0, y: 0, w: 300, h: 250 }), box("figure", 1, { x: 0, y: 0, w: 300, h: 250 })], headed(), null, measure, { startsFresh: true });
  const [a, b] = res.placements;
  check(a.y === b.y && b.x > a.x + 300 * a.scale - 1 && res.placements.length === 2 && a.x > CONTENT_LEFT + 300, "L-1  two triangles share one row, floated right as a pair", `${JSON.stringify(res.placements)}`);
  // Two SMALL figures float together on the right, and the next text wraps beside the pair.
  const small = L.layoutBeat(
    [box("figure", 0, { x: 0, y: 0, w: 200, h: 260 }), box("figure", 1, { x: 0, y: 0, w: 120, h: 140 }), L.textBlockOf({ op: "text", text: "tree height = TB" }, 2)],
    headed(), null, measure, { startsFresh: true },
  );
  const [f1, f2, txt] = small.placements;
  check(f1.y === STEP_BODY_TOP && f2.y === f1.y && f2.x > f1.x && f1.x >= CONTENT_RIGHT - 560, "L-1  two small figures float right as a pair", JSON.stringify(small.placements));
  check(txt.kind === "text" && txt.x === CONTENT_LEFT && txt.y === STEP_BODY_TOP, "L-1  the notes flow at the left beside the pair");
  // A wide but shrinkable figure floats at 70% rather than taking the full width.
  const wide = L.layoutBeat([box("figure", 0, { x: 0, y: 0, w: 760, h: 300 }), L.textBlockOf({ op: "text", text: "beside it" }, 1)], headed(), null, measure, { startsFresh: true });
  const wf = wide.placements.find((p) => p.kind === "box");
  check(wf.scale < 1 && wf.x + 760 * wf.scale <= CONTENT_RIGHT + 0.5 && wf.x > CONTENT_LEFT + 400, "L-1  a 760px figure shrinks to float right instead of going full width", JSON.stringify(wf));
}
// 5-8. Anchors on a right triangle ABC (right angle at B).
const tri = PRIMITIVES.polygon({
  op: "polygon",
  id: "tri",
  points: [
    { x: 0, y: 0, label: "A" },
    { x: 0, y: 240, label: "B" },
    { x: 320, y: 240, label: "C" },
  ],
});
check(tri.label === "polygon ABC" && tri.anchors && Object.keys(tri.anchors.edgeIndex).includes("CA"), "L-1  a polygon names its vertices and sides", tri.label);
const figAt = (dx, dy) => ({ id: "tri", page: 0, anchors: A.transformAnchors(tri.anchors, 1, dx, dy), labelBoxes: [], markedVertices: [], segments: [] });
const edgesOf = (fig) => {
  const o = fig.anchors.outline;
  return o.map((p, i) => [p, o[(i + 1) % o.length]]);
};
{
  const fig = figAt(500, 300);
  const ex = A.anchoredAngle(fig, "A", { text: "θ" });
  const arc = ex.ops.filter((o) => o.op === "line");
  const r = Math.hypot(arc[0].x - 500, arc[0].y - 300);
  check(arc.length === 12 && Math.abs(r - Math.hypot(arc[5].x - 500, arc[5].y - 300)) < 0.01, "L-1  angle at A: an arc centred on the SHIFTED vertex, no rays", `r=${r.toFixed(1)}`);
  const lbl = ex.ops.find((o) => o.op === "text");
  const lb = { x: lbl.x, y: lbl.y, w: measure("θ", 16), h: 20 };
  check(!edgesOf(fig).some(([a, b]) => PL.segmentHitsRect(a, b, lb)), "L-1  the θ label crosses no side");
  check(lbl.x > 500 && lbl.y > 300 && lbl.y < 540, "L-1  the θ label sits inside the corner at A");
  const right = A.anchoredAngle(fig, "B", {});
  check(right.ops.filter((o) => o.op === "line").length === 0 && right.ops[0].text === "90°", "L-1  the right angle at B gets a label only (the square is already drawn)");
}
{
  const fig = figAt(500, 300);
  const hyp = A.anchoredLabel(fig, "AC", { text: "hypotenuse" });
  fig.labelBoxes.push(hyp.box);
  const opp = A.anchoredLabel(fig, "BC", { text: "opposite" });
  check(hyp && opp, "L-1  side labels resolve by name");
  check(!edgesOf(fig).some(([a, b]) => PL.segmentHitsRect(a, b, hyp.box) || PL.segmentHitsRect(a, b, opp.box)), "L-1  side labels cross no stroke");
  check(!overlaps(hyp.box, opp.box), "L-1  two side labels do not overlap each other");
  check(A.anchoredLabel(fig, "XY", { text: "nope" }) === null, "L-1  an unknown side is refused, never guessed");
}
{
  const fig = figAt(500, 300);
  const h = A.anchoredHighlight(fig, "AB", {});
  check(h.rot === Math.atan2(240, 0) && Math.abs(h.x + h.w / 2 - 500) < 0.01 && Math.abs(h.y + h.h / 2 - 420) < 0.01, "L-1  highlight at AB is a band centred on the side, rotated with it", JSON.stringify(h));
  const seg = A.anchoredSegment(fig, { op: "line", from: "B", to: "foot B AC", dash: true });
  const foot = A.footOfPerpendicular({ x: 500, y: 540 }, { x: 500, y: 300 }, { x: 820, y: 540 });
  check(seg && Math.abs(seg.x2 - foot.x) < 0.01 && Math.abs(seg.y2 - foot.y) < 0.01 && seg.temp === false, "L-1  altitude from B meets AC at the perpendicular foot, as permanent notes");
  const p = A.resolvePoint(fig, "mid BC");
  check(p && p.x === 660 && p.y === 540, "L-1  'mid BC' resolves to the midpoint");
}
// 8b. Diagonals, cross-figure points, fading highlights, wrapped tables (the first live run).
{
  const quad = PRIMITIVES.polygon({ op: "polygon", id: "q", points: [{ x: 0, y: 0, label: "A" }, { x: 260, y: 0, label: "B" }, { x: 260, y: 200, label: "C" }, { x: 0, y: 200, label: "D" }] });
  const fig = { id: "q", page: 0, anchors: A.transformAnchors(quad.anchors, 1, 300, 200), labelBoxes: [], markedVertices: [], segments: [] };
  const seg = A.segmentOf(fig, "AC");
  check(seg && seg.index === -1 && seg.b.x === 560 && seg.b.y === 400, "L-1  'AC' on a rectangle resolves to the diagonal");
  const lbl = A.anchoredLabel(fig, "AC", { text: "diagonal d" });
  const o = fig.anchors.outline;
  const edges = [...o.map((p, i) => [p, o[(i + 1) % o.length]]), [seg.a, seg.b]];
  check(lbl && !edges.some(([a, b]) => PL.segmentHitsRect(a, b, lbl.box)), "L-1  a diagonal's label crosses neither the sides nor the diagonal");
  const band = A.anchoredHighlight(fig, "AC", {});
  check(band && band.temp === true && Math.abs(band.rot - Math.atan2(200, 260)) < 1e-9, "L-1  a highlight along the diagonal fades by default and follows its angle");
  check(A.anchoredHighlight(fig, "AB", { temp: false }).temp === false, "L-1  temp:false keeps a highlight in the notes");
  const m = A.resolvePoint(fig, "mid AC");
  check(m && m.x === 430 && m.y === 300, "L-1  'mid AC' is the diagonal's midpoint");
}
{
  const tbl = PRIMITIVES.table({
    op: "table",
    id: "w",
    rows: [
      ["Core ratio", "Reciprocal ratio", "Memory aid"],
      ["sin theta = opposite / hypotenuse", "cosec theta = hypotenuse / opposite", "some old horses can always hear their owners approach"],
    ],
  });
  const vr = tbl.ops.filter((o) => /\.vr\d+$/.test(o.id)).map((o) => o.x).sort((a, b) => a - b);
  const colOf = (x) => vr.findIndex((v, i) => x >= v && x < (vr[i + 1] ?? Infinity));
  const texts = tbl.ops.filter((o) => o.op === "text" && /\.c\d/.test(o.id));
  const inside = texts.every((o) => {
    const c = colOf(o.x);
    return c >= 0 && o.x + measure(o.text, 16) <= vr[c + 1] + 0.5;
  });
  check(inside, "L-1  every table cell's text fits inside its own column (long cells wrap)");
  check(vr[vr.length - 1] - vr[0] <= CONTENT_RIGHT - CONTENT_LEFT, "L-1  the table never runs past the notes column");
  check(texts.some((o) => /\.c1_2_1$/.test(o.id)), "L-1  a long cell gained a second line");
}
// 8c. Role words land on the right side; spoken maths becomes symbols; thin figures open out; the left column is used.
{
  const fig = figAt(0, 0);
  fig.markedVertices = ["A"];
  check(A.retargetSide(fig, "AB", "hypotenuse") === "CA" || A.retargetSide(fig, "AB", "hypotenuse") === "AC", "L-1  'hypotenuse' on a leg moves to the side opposite the right angle", A.retargetSide(fig, "AB", "hypotenuse"));
  check(A.retargetSide(fig, "AC", "adjacent") === "AB", "L-1  'adjacent' on the hypotenuse moves to the leg at the marked angle", A.retargetSide(fig, "AC", "adjacent"));
  check(A.retargetSide(fig, "AB", "opposite") === "BC", "L-1  'opposite' follows the marked angle", A.retargetSide(fig, "AB", "opposite"));
  check(A.retargetSide(fig, "AB", "5 cm") === "AB", "L-1  a plain measurement stays where the model put it");
  check(A.retargetSide(fig, "AB", "BC") === "BC", "L-1  a label that is a side's name goes on that side");
  {
    // An altitude drawn across the corner: the angle label keeps clear of it.
    const f2 = figAt(500, 300);
    f2.segments = [[{ x: 500, y: 300 }, A.footOfPerpendicular({ x: 500, y: 300 }, { x: 500, y: 540 }, { x: 820, y: 540 })]];
    const ex = A.anchoredAngle(f2, "A", { text: "30°" });
    const lbl = ex.ops.find((o) => o.op === "text");
    const lb = { x: lbl.x, y: lbl.y, w: measure("30°", 16), h: 20 };
    check(!PL.segmentHitsRect(f2.segments[0][0], f2.segments[0][1], lb), "L-1  an angle label does not sit on a construction line");
    // Two angle labels at one corner, and a construction line's text: none of them overlap.
    const f3 = figAt(500, 300);
    const first = A.anchoredAngle(f3, "A", { text: "θ" });
    f3.labelBoxes.push(first.box);
    const second = A.anchoredAngle(f3, "A", { text: "0°" });
    check(second.box && !overlaps(first.box, second.box), "L-1  a second angle label at the same corner does not print over the first", JSON.stringify([first.box, second.box]));
    f3.labelBoxes.push(second.box);
    const segA = { x: 500, y: 420 }, segB = { x: 900, y: 380 };
    f3.segments.push([segA, segB]);
    const sl = A.segmentLabel(f3, segA, segB, { text: "hypotenuse → adjacent" });
    const slBox = { ...sl.box, w: measure("hypotenuse → adjacent", 16) };
    check(sl && !f3.labelBoxes.some((r) => overlaps(r, slBox)) && !PL.segmentHitsRect(segA, segB, sl.box), "L-1  a construction line's text clears the line and every other label");
  }
  {
    const { symbolsForWords } = await import(mod("src/lib/canvas/mathtext.ts"));
    const { readableSize } = await import(mod("src/lib/canvas/primitives/util.ts"));
    check(symbolsForWords("sin theta = root 3 / 2 at 30 degrees") === "sin θ = √3 / 2 at 30°", "L-1  'theta', 'root 3', '30 degrees' become θ, √3, 30°", symbolsForWords("sin theta = root 3 / 2 at 30 degrees"));
    check(symbolsForWords("the roots of a root") === "the roots of a root", "L-1  English 'roots'/'root' alone are left alone");
    check(symbolsForWords("square root of 5 and sqrt(2n+1)") === "√5 and √(2n+1)", "L-1  'square root of 5' and 'sqrt(2n+1)' become radicals", symbolsForWords("square root of 5 and sqrt(2n+1)"));
    const flat = readableSize({ op: "polygon", points: [{ x: 0, y: 0 }, { x: 280, y: 0 }, { x: 280, y: 10 }] });
    const ys = flat.points.map((p) => p.y);
    check(Math.max(...ys) - Math.min(...ys) >= 280 / 5 - 0.01, "L-1  a 280x10 'limiting case' triangle is opened out to a visible aspect", `h=${Math.max(...ys) - Math.min(...ys)}`);
    const tiny = readableSize({ op: "polygon", points: [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }] });
    check(Math.max(...tiny.points.map((p) => p.x)) >= 200, "L-1  a figure given in real units is drawn at a readable size");
  }
  // A float on the right, then a figure that does not fit under it: it goes in the empty left strip.
  const state = { cursorY: STEP_BODY_TOP, floats: [{ rect: { x: CONTENT_RIGHT - 450, y: STEP_BODY_TOP, w: 450, h: 320 }, ids: ["f"] }] };
  const res = L.layoutBeat([box("sketch", 0, { x: 0, y: 0, w: 420, h: 300 })], state, null, measure, { startsFresh: false });
  const p = res.placements[0];
  check(res.pages.length === 1 && p.x === CONTENT_LEFT && p.y === STEP_BODY_TOP, "L-1  a figure beside an existing float uses the empty left column, no new page", JSON.stringify(p));
}
// 9. Scaling a polygon keeps its labels' font size.
{
  const small = PRIMITIVES.polygon(scaleOp({ op: "polygon", id: "t", points: [{ x: 0, y: 0, label: "A" }, { x: 0, y: 240, label: "B" }, { x: 320, y: 240, label: "C" }] }, 0.5));
  check(small.anchors.outline[2].x === 160 && small.ops.filter((o) => o.op === "text").every((o) => o.size === "sm"), "L-1  scaleOp halves the geometry, labels stay sm");
}
// 10. The mock lesson: the highlight in beat 3 lands over the pizza drawn in beat 2 (sketch frame).
{
  const [, pizza, bite] = mockLesson("What is 2/4?", "en-IN", 1);
  const raw2 = L.groupBlocks(pizza.draw);
  check(raw2.length === 1 && raw2[0].kind === "sketch" && raw2[0].ops.length === 4, "L-1  the pizza beat is one sketch (shapes + its label)", JSON.stringify(raw2.map((b) => b.kind)));
  const b2 = [box("sketch", 0, bboxOfOps(raw2[0].ops))];
  const r2 = L.layoutBeat(b2, headed(), null, measure, { startsFresh: true });
  const placedPizza = r2.placements[0];
  check(r2.frame && placedPizza.x === CONTENT_RIGHT - b2[0].bbox.w, "L-1  the pizza floats right and leaves a sketch frame");
  const raw3 = L.groupBlocks(bite.draw);
  const kinds = raw3.map((b) => b.kind).sort().join(",");
  check(kinds === "anchored,sketch,text", "L-1  beat 3 = highlight (sketch), note (text), pointer (anchored)", kinds);
  const flow3 = raw3
    .map((b, i) => (b.kind === "text" ? L.textBlockOf(b.op, i) : b.kind === "sketch" ? box("sketch", i, bboxOfOps(b.ops)) : null))
    .filter(Boolean);
  const r3 = L.layoutBeat(flow3, r2.pages[0], r2.frame, measure, { startsFresh: false });
  const hl = r3.placements.find((p) => p.kind === "box");
  check(hl && hl.x === placedPizza.x && hl.y === placedPizza.y, "L-1  the highlight lands exactly on the pizza", `${JSON.stringify(hl)} vs ${JSON.stringify(placedPizza)}`);
  const note = r3.placements.find((p) => p.kind === "text");
  check(note && note.x === CONTENT_LEFT && note.y === STEP_BODY_TOP, "L-1  the note flows at the left beside the pizza");
}
// 11. Text with stray coordinates plus a bare temp arrow: the text flows, the gesture is dropped.
{
  const raw = L.groupBlocks([
    { op: "text", id: "t", x: 80, y: 500, text: "stray coords" },
    { op: "arrow", id: "a", x: 80, y: 500, x2: 300, y2: 500 },
  ]);
  const kinds = raw.map((b) => b.kind).sort().join(",");
  check(kinds === "sketch,text", "L-1  stray text is a flow line; the bare arrow is a gesture-only sketch", kinds);
  const blocks = raw.map((b, i) => (b.kind === "text" ? L.textBlockOf(b.op, i) : box("sketch", i, bboxOfOps(b.ops), { gestureOnly: true })));
  const res = L.layoutBeat(blocks, headed(), null, measure, { startsFresh: true });
  check(res.placements.length === 1 && res.placements[0].kind === "text" && res.placements[0].y === STEP_BODY_TOP, "L-1  only the text is placed, at the cursor", JSON.stringify(res.placements));
}
// 12. A long line is wrapped to the column; a float narrows it.
{
  const long = "a ".repeat(60).trim();
  const res = L.layoutBeat(textBlocks([long]), headed(), null, measure, { startsFresh: true });
  const p = res.placements[0];
  check(p.lines.length > 1 && p.lines.every((l) => measure(l, 24) <= CONTENT_RIGHT - CONTENT_LEFT), "L-1  a long line wraps inside the column", `${p.lines.length} lines`);
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
