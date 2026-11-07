import { z } from "zod";

/**
 * The wire format between the LLM and the whiteboard.
 *
 * A tutor turn is an ordered list of "beats". Each beat is one spoken sentence
 * (or two) plus the drawing operations that visualise it. The frontend plays the
 * speech of beat N while animating the draw ops of beat N, which is what keeps
 * voice and board in sync without any timestamps.
 *
 * The op schema is intentionally flat (one object type). The server parses the
 * model's NDJSON output and validates each beat with this schema itself (no
 * provider-native structured output), so fields are nullish: a field may be
 * omitted OR sent as null. Consumers coalesce with `?? default`.
 */

export const OPS = [
  "text",
  "rect",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "highlight",
  "numberline",
  "axes",
  "bars",
  "fraction",
  "polygon",
  "angle",
  "vector",
  "table",
  "circles",
  "circuit",
  "optics",
  "molecule",
  "solid",
  "labeled",
  "punnett",
  "net",
  "reaction",
  "tree",
  "venn",
  "graph",
  "apparatus",
  "curvearrow",
  "wave",
  "pie",
  "incline",
  "timeline",
  "erase",
  "clear",
] as const;
export type OpName = (typeof OPS)[number];

export const COLORS = [
  "black",
  "blue",
  "red",
  "green",
  "orange",
  "purple",
  "gray",
] as const;
export type ColorName = (typeof COLORS)[number];

export const SIZES = ["sm", "md", "lg"] as const;
export type SizeName = (typeof SIZES)[number];

export const DrawOpSchema = z.object({
  op: z.enum(OPS).describe("Operation type."),
  id: z
    .string()
    .nullish()
    .describe(
      "Short unique id (t1, box_force, arr3). Give one to every text/shape/arrow/highlight so it can be erased later.",
    ),
  x: z.number().nullish().describe("Left (text/shapes/highlight) or start x (arrow/line)."),
  y: z.number().nullish().describe("Top (text/shapes/highlight) or start y (arrow/line)."),
  w: z.number().nullish().describe("Width for rect/ellipse/diamond/highlight."),
  h: z.number().nullish().describe("Height for rect/ellipse/diamond/highlight."),
  x2: z.number().nullish().describe("End x for arrow/line."),
  y2: z.number().nullish().describe("End y for arrow/line."),
  text: z
    .string()
    .nullish()
    .describe("Text content (text op), centered label (shapes) or midpoint label (arrow/line)."),
  // .catch keeps an op alive when the model picks a word outside the enum
  // (e.g. "yellow", "small"): it falls back to null and the consumer defaults it.
  size: z.enum(SIZES).nullish().catch(null).describe("Text size: sm=16px, md=24px (default), lg=36px."),
  // Internal: set by the superscript/subscript expander, which needs the exact
  // reduced size of an exponent rather than one of the three named sizes. The
  // model never sets this; `size` stays the only text-size control it has.
  px: z.number().nullish().catch(null).optional(),
  color: z.enum(COLORS).nullish().catch(null).describe("Stroke/text colour. Default black."),
  temp: z
    .boolean()
    .nullish()
    .catch(null)
    .describe(
      "Transient pointing gesture: set true for an arrow/highlight/line you draw only to point at something while you talk. It fades away on its own after a moment. Leave false/omit for permanent structure (number lines, shapes, labels, formulas, answers).",
    ),
  dash: z.boolean().nullish().catch(null).describe("Draw an arrow/line dashed instead of solid (e.g. a construction or virtual ray)."),
  ids: z.array(z.string()).nullish().catch(null).describe("Ids to remove (erase op only)."),
  // --- numberline op: the model gives intent, the client lays it out perfectly ---
  min: z.number().nullish().catch(null).describe("numberline: smallest value on the line."),
  max: z.number().nullish().catch(null).describe("numberline: largest value on the line."),
  step: z.number().nullish().catch(null).describe("numberline: spacing between ticks (optional; auto-picked if omitted)."),
  denominator: z
    .number()
    .nullish()
    .catch(null)
    .describe(
      "numberline: teaching fractions? give the denominator (3 for thirds) and ticks land ON the fractions, labelled 1/3, 2/3 — instead of the default decimal 0.1…0.9 scale.",
    ),
  marks: z
    .array(
      z.object({
        at: z.number(),
        label: z.string().nullish().catch(null),
        color: z.enum(COLORS).nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("numberline: points to highlight on the line, each {at: value, label?, color?}."),
  // --- axes op ---
  xmin: z.number().nullish().catch(null).describe("axes: smallest x value."),
  xmax: z.number().nullish().catch(null).describe("axes: largest x value."),
  ymin: z.number().nullish().catch(null).describe("axes: smallest y value."),
  ymax: z.number().nullish().catch(null).describe("axes: largest y value."),
  xstep: z.number().nullish().catch(null).describe("axes: x tick spacing (optional, auto)."),
  ystep: z.number().nullish().catch(null).describe("axes: y tick spacing (optional, auto)."),
  xlabel: z.string().nullish().catch(null).describe("axes: x-axis title."),
  ylabel: z.string().nullish().catch(null).describe("axes: y-axis title."),
  points: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        label: z.string().nullish().catch(null),
        color: z.enum(COLORS).nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("axes: points to plot [{x, y, label?, color?}]; polygon: the ordered vertices."),
  // --- bars op ---
  data: z
    .array(
      z.object({
        label: z.string().nullish().catch(null),
        value: z.number(),
        color: z.enum(COLORS).nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("bars: the bars [{label?, value, color?}]."),
  // --- circles op (concentric) ---
  radii: z
    .array(z.number())
    .nullish()
    .catch(null)
    .describe("circles: radius of each circle in px, sharing one centre (e.g. [140, 90, 45])."),
  labels: z
    .array(z.string())
    .nullish()
    .catch(null)
    .describe("circles: label for each radius, in the same order as `radii`."),
  colors: z
    .array(z.enum(COLORS))
    .nullish()
    .catch(null)
    .describe("circles: colour for each circle, in the same order as `radii`."),
  radii_lines: z
    .boolean()
    .nullish()
    .catch(null)
    .describe("circles: draw a radius line from the centre to each circle (default false)."),
  centre: z
    .boolean()
    .nullish()
    .catch(null)
    .describe("circles: draw the centre dot (default true)."),
  // --- fraction op ---
  parts: z.number().nullish().catch(null).describe("fraction: how many equal parts (denominator)."),
  shaded: z.number().nullish().catch(null).describe("fraction: how many parts are filled (numerator)."),
  // --- polygon op ---
  sides: z.array(z.string()).nullish().catch(null).describe("polygon: label for each edge, in vertex order."),
  closed: z.boolean().nullish().catch(null).describe("polygon: close the shape back to the first vertex (default true)."),
  // --- axes curves (function graphs) ---
  curves: z
    .array(
      z.object({
        points: z.array(z.object({ x: z.number(), y: z.number() })),
        label: z.string().nullish().catch(null),
        color: z.enum(COLORS).nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("axes: curves to draw, each {points:[{x,y}...] in data coords, label?, color?}. Sample the function yourself."),
  // --- angle op ---
  a1: z.number().nullish().catch(null).describe("angle: first ray direction in degrees (0 = east, CCW)."),
  a2: z.number().nullish().catch(null).describe("angle: second ray direction in degrees."),
  r: z.number().nullish().catch(null).describe("angle/vector: ray length in px (optional)."),
  // --- vector / free-body op ---
  vectors: z
    .array(
      z.object({
        angle: z.number(),
        mag: z.number(),
        label: z.string().nullish().catch(null),
        color: z.enum(COLORS).nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("vector: force arrows from the origin, each {angle(deg), mag(relative length), label?, color?}."),
  // --- table op ---
  rows: z
    .array(z.array(z.string()))
    .nullish()
    .catch(null)
    .describe("table: rows of cell text; the first row is the header."),
  // --- circuit op ---
  components: z
    .array(
      z.object({
        type: z.string(),
        label: z.string().nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("circuit: components in series order, each {type, label?}. type = cell|battery|resistor|bulb|switch|ammeter|voltmeter|wire."),
  // --- optics op ---
  device: z.string().nullish().catch(null).describe("optics: convex-lens|concave-lens|concave-mirror|convex-mirror."),
  f: z.number().nullish().catch(null).describe("optics: focal length in diagram units (>0)."),
  objectAt: z.number().nullish().catch(null).describe("optics: object distance from the device in units (>0, object on the left)."),
  objectH: z.number().nullish().catch(null).describe("optics: object height in units (>0)."),
  scale: z.number().nullish().catch(null).describe("optics: pixels per unit (optional)."),
  // --- circuit: parallel branches ---
  branches: z
    .array(z.array(z.object({ type: z.string(), label: z.string().nullish().catch(null) })))
    .nullish()
    .catch(null)
    .describe("circuit: parallel branches, each an array of components; when present the circuit is drawn in parallel."),
  // --- molecule op ---
  atoms: z
    .array(z.object({ id: z.string(), el: z.string().nullish().catch(null), x: z.number(), y: z.number(), color: z.enum(COLORS).nullish().catch(null) }))
    .nullish()
    .catch(null)
    .describe("molecule: atoms [{id, el(element symbol), x, y, color?}]."),
  bonds: z
    .array(z.object({ from: z.string(), to: z.string(), order: z.number().nullish().catch(null) }))
    .nullish()
    .catch(null)
    .describe("molecule: bonds [{from, to, order?}] where order 1/2/3 = single/double/triple."),
  // --- solid / net op ---
  shape: z.string().nullish().catch(null).describe("solid: cube|cuboid|cylinder. net: cube|cuboid."),
  d: z.number().nullish().catch(null).describe("solid/net: depth in px (cuboid)."),
  // --- molecule aromatic ring ---
  ring: z.array(z.string()).nullish().catch(null).describe("molecule: atom ids forming an aromatic ring (draws the inner circle)."),
  // --- punnett square ---
  top: z.array(z.string()).nullish().catch(null).describe("punnett: the gametes across the top (e.g. [\"T\",\"t\"])."),
  side: z.array(z.string()).nullish().catch(null).describe("punnett: the gametes down the left side."),
  // --- reaction (chemical equation) ---
  reactants: z.array(z.string()).nullish().catch(null).describe("reaction: left-hand species, joined with +."),
  products: z.array(z.string()).nullish().catch(null).describe("reaction: right-hand species, joined with +."),
  over: z.string().nullish().catch(null).describe("reaction: condition written above the arrow (e.g. heat, catalyst)."),
  under: z.string().nullish().catch(null).describe("reaction: condition written below the arrow."),
  reversible: z.boolean().nullish().catch(null).describe("reaction: draw a reversible (two-way) arrow."),
  // --- tree (factor / probability / classification) & graph nodes ---
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().nullish().catch(null),
        parent: z.string().nullish().catch(null),
        edge: z.string().nullish().catch(null),
        color: z.enum(COLORS).nullish().catch(null),
        x: z.number().nullish().catch(null),
        y: z.number().nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null)
    .describe("tree: nodes [{id, label, parent?, edge?, color?}] (root has no parent). graph: nodes [{id, label, x, y, color?}]."),
  edges: z
    .array(z.object({ from: z.string(), to: z.string(), label: z.string().nullish().catch(null), color: z.enum(COLORS).nullish().catch(null) }))
    .nullish()
    .catch(null)
    .describe("graph: directed links [{from, to, label?, color?}]."),
  // --- apparatus (lab setup) ---
  items: z
    .array(z.object({ type: z.string(), x: z.number(), y: z.number(), label: z.string().nullish().catch(null) }))
    .nullish()
    .catch(null)
    .describe("apparatus: vessels [{type, x, y, label?}]; type = beaker|testtube|flask|roundflask|burner|funnel|thermometer|stand."),
  // --- extra solid sizes / curved arrow ---
  w2: z.number().nullish().catch(null).describe("solid frustum: top width (px)."),
  bow: z.number().nullish().catch(null).describe("curvearrow: sideways curvature in px (optional)."),
  // --- wave / incline ---
  amp: z.number().nullish().catch(null).describe("wave: amplitude in px."),
  waves: z.number().nullish().catch(null).describe("wave: number of full wavelengths across the width."),
  angle: z.number().nullish().catch(null).describe("incline: slope angle in degrees."),
  // --- venn (sets) ---
  sets: z
    .array(z.object({ label: z.string().nullish().catch(null), color: z.enum(COLORS).nullish().catch(null) }))
    .nullish()
    .catch(null)
    .describe("venn: 2 or 3 sets [{label, color?}]."),
  // --- placement by NAME (figure anchors; see lib/canvas/anchors.ts) ---
  // The board lays content out itself, so nothing the model draws on a figure
  // is placed by coordinates: an angle mark, a side label, a highlight or a
  // construction line names the part of the figure it belongs to instead.
  at: z
    .string()
    .nullish()
    .catch(null)
    .describe(
      'angle/text/highlight: the part of a figure this attaches to — a vertex ("A"), a side ("AB"), "mid AB", "foot A BC" — or, for highlight/arrow, the id of an earlier element.',
    ),
  of: z.string().nullish().catch(null).describe("Id of the figure that `at`/`from`/`to` name parts of. Omit for the most recent figure."),
  from: z.string().nullish().catch(null).describe('line/arrow: start point by name ("A", "mid AB", "foot A BC").'),
  to: z.string().nullish().catch(null).describe("line/arrow: end point by name, or the id of an element to point at."),
  place: z
    .enum(["right", "below"])
    .nullish()
    .catch(null)
    .describe("figure: beside the notes (right) or full-width under them (below). Omit to let the board decide."),
  // Internal: a run of a scripted line that is drawn in the math fallback font
  // (the line holds a glyph the hand font lacks). Set by the math layout so the
  // runs are measured and drawn in the same font; the model never sets it.
  font: z.enum(["math"]).nullish().catch(null).optional(),
  // Internal: rotation in radians of a highlight laid along a figure's side.
  // Set by the anchor expander; the model never sets it.
  rot: z.number().nullish().catch(null).optional(),
  // Internal: "fixed" ops are client-authored furniture (step heading, agenda,
  // question block) drawn at their own page-local coordinates, outside the flow
  // layout. The model never sets it.
  layout: z.enum(["fixed"]).nullish().catch(null).optional(),
});
export type DrawOp = z.infer<typeof DrawOpSchema>;

export const BeatSchema = z.object({
  say: z
    .string()
    .describe(
      "What the tutor says aloud during this beat. One or two short natural sentences, no markdown, no LaTeX.",
    ),
  lang: z
    .string()
    .nullish()
    .describe("BCP-47 code of the language of `say` (hi-IN, en-IN, ta-IN, ...). Used to pick the TTS voice."),
  // Validate ops individually and keep only the good ones, so one malformed op
  // (bad enum, wrong type, unknown "op") never invalidates the whole beat.
  draw: z
    .array(z.unknown())
    .transform((arr) => arr.flatMap((el) => {
      const r = DrawOpSchema.safeParse(el);
      return r.success ? [r.data] : [];
    }))
    .default([])
    .describe("Drawing operations performed while this beat is spoken. May be empty or omitted."),
});
export type Beat = z.infer<typeof BeatSchema>;

/** One message of the conversation history as the client keeps it. */
export const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/**
 * Drop the second half of a bilingual step title.
 *
 * Asked for a title in the student's language, the planner sometimes supplies both
 * languages joined by a slash — "Real-life hook / Quadratic Equations in daily life",
 * and in the degenerate case "Standard form / Standard form". That reaches the board
 * verbatim and reads as a bug to the student, so the first half is kept.
 *
 * Deliberately conservative: it fires only on a slash with spaces around it and only
 * when both halves read as titles (several words, no further slashes). A real title
 * with a slash in it — "and/or", "cm/s", "Regular vs diffuse / scattered" — keeps it.
 */
function stripTranslationPair(title: string): string {
  const t = title.trim();
  const parts = t.split(/\s+\/\s+/);
  if (parts.length !== 2) return t;
  const [first, second] = parts.map((p) => p.trim());
  if (!first || !second) return t;
  // The giveaway of a translation pair: both sides stand alone as a step title. A
  // one-word tail ("Regular / diffuse") is a real title listing two things, not a
  // translation — keep the whole thing.
  const words = (s: string) => s.split(/\s+/).length;
  if (words(second) < 2 && words(first) < 2) return t;
  return first;
}

/**
 * A single step of a lesson plan, designed up front by the planner model
 * (Nemotron Ultra). The teaching model later turns one step into spoken beats +
 * board drawings. `draw` is a hint about what the board should show for the step.
 */
export const LessonStepSchema = z.object({
  title: z
    .string()
    .transform(stripTranslationPair)
    .describe(
      "Short title of this step, in the student's language and ONE language only, e.g. 'Opening analogy' or 'Derive the quadratic formula'. Never give the same title twice separated by '/' — write it once.",
    ),
  teach: z.string().default("").describe("What to explain in this step, in a sentence or two."),
  draw: z.string().default("").describe("What the board should show for this step (a hint, not literal ops)."),
  roadmap: z
    .string()
    .default("")
    .describe(
      "One short line Indica SPEAKS up front to preview this step, in the student's language (e.g. 'First we'll see why a fraction is just a share of something'). Not the teaching itself — the promise of it.",
    ),
});
export type LessonStep = z.infer<typeof LessonStepSchema>;

/** The whole lesson plan Ultra produces once, then the client threads back each teaching turn. */
export const LessonPlanSchema = z.object({
  topic: z.string().default("").describe("The topic being taught."),
  level: z.string().default("").describe("Pitch/pace chosen from the student's stated familiarity."),
  intro: z
    .string()
    .default("")
    .describe(
      "One short line Indica SPEAKS before the roadmap, in the student's language (e.g. \"Great — here's how we'll learn this together\").",
    ),
  steps: z.array(LessonStepSchema).default([]),
});
export type LessonPlan = z.infer<typeof LessonPlanSchema>;

/**
 * What the current turn is for. The client drives a small state machine:
 *   plan    -> design the lesson (Ultra), no beats, returns a `plan` event
 *   teach   -> teach one plan step as beats (Ultra), guided by `plan` + `step`
 *   doubt   -> answer a conceptual question as beats (fast doubt model), drawn on its own page
 *   explain -> work a specific textbook item (example/exercise/theorem) the student
 *              named, as beats (Ultra), drawn on the MAIN canvas like normal teaching
 *   ask     -> legacy single-turn behaviour (no plan); the original tutor loop
 *
 * The SOLVE pipeline (track "solve") adds two more. It deliberately has no plan
 * stage and no familiarity question — the student named a question, so the first
 * turn already solves it:
 *   solve      -> explain the solution to the question the student named, as beats,
 *                 grounded on the solutions index. The question itself is written on
 *                 the board deterministically (lib/question-board), not by the model.
 *   solvedoubt -> a doubt raised mid-solution, on its own page, without restarting
 *
 * The between-step CHECKPOINT adds two more. Neither draws on the board — both
 * return one small JSON object, not beats:
 *   checkpoint -> decide what to do at the gap between two steps: let the lesson
 *                 run on, or put a real recall question to the student (and how
 *                 hard a one). Reads the running record of how the student has
 *                 been answering so far.
 *   grade      -> mark the answer the student gave to that question: right,
 *                 partly right or wrong, plus the one line to say back to them.
 */
export const TUTOR_MODES = [
  "plan",
  "teach",
  "doubt",
  "explain",
  "ask",
  "solve",
  "solvedoubt",
  "checkpoint",
  "grade",
] as const;
export type TutorMode = (typeof TUTOR_MODES)[number];

/**
 * Which pipeline the student is in, chosen before their first question.
 *   learn -> understand a topic: familiarity question, lesson plan, step-by-step teaching
 *   solve -> solve a question: straight into the worked solution, no plan stage
 */
export const TUTOR_TRACKS = ["learn", "solve"] as const;
export type TutorTrack = (typeof TUTOR_TRACKS)[number];

/**
 * What the student has done at the checkpoints so far. This is the whole basis
 * of the adaptive questioning: the model is given this record and decides from
 * it whether to ask anything at all, and how hard.
 *
 * Deliberately small and countable rather than a transcript. The decision has
 * to be made on every checkpoint of every lesson, and a model asked to re-read
 * the entire conversation to judge confidence both costs more and drifts; four
 * counters and the last few outcomes say the same thing and say it the same way
 * every time.
 */
export const LessonRecordSchema = z.object({
  /** Questions put to the student so far in this lesson. */
  asked: z.number().int().min(0).default(0),
  /** How many they got fully right. */
  correct: z.number().int().min(0).default(0),
  /** How many were partly right — the idea there, the execution not. */
  partial: z.number().int().min(0).default(0),
  /** How many they got wrong, or could not answer. */
  wrong: z.number().int().min(0).default(0),
  /** Doubts the student has raised, a second signal of where they are. */
  doubts: z.number().int().min(0).default(0),
  /** Steps taught since the last question, so a long unbroken stretch is visible. */
  sinceAsked: z.number().int().min(0).default(0),
  /** The most recent outcomes, newest last, e.g. ["correct","partial","correct"]. */
  recent: z.array(z.enum(["correct", "partial", "wrong"])).default([]),
  /** The difficulty last asked, so the model can step up or down from it. */
  lastDifficulty: z.enum(["recall", "apply", "stretch"]).nullish(),
});
export type LessonRecord = z.infer<typeof LessonRecordSchema>;

/**
 * What the model decides at a checkpoint.
 *
 * `action: "continue"` means let the lesson run on — the plain "any doubt?"
 * gate. `action: "ask"` carries the question to put to the student.
 */
export const CheckpointPlanSchema = z.object({
  action: z.enum(["continue", "ask"]).default("continue"),
  /** The question to SAY, in the student's language. Only for action "ask". */
  question: z.string().default(""),
  /**
   * How hard it is:
   *   recall  -> say back a fact or term just taught
   *   apply   -> use what was just taught on a small new case
   *   stretch -> join two ideas, or a case that looks different on the surface
   */
  difficulty: z.enum(["recall", "apply", "stretch"]).default("recall"),
  /** The answer being looked for, so the grader is not re-deriving it. */
  expected: z.string().default(""),
  /** One short sentence on why this call was made. Never spoken; for logs. */
  why: z.string().default(""),
});
export type CheckpointPlan = z.infer<typeof CheckpointPlanSchema>;

/** The verdict on a student's answer, plus the line to say back to them. */
export const AnswerGradeSchema = z.object({
  verdict: z.enum(["correct", "partial", "wrong"]).default("partial"),
  /** What to SAY back: the praise, or the correction. In the student's language. */
  say: z.string().default(""),
  /**
   * True when the miss is big enough that the lesson should not just move on —
   * the client then re-teaches the point as a doubt turn before continuing.
   */
  reteach: z.boolean().default(false),
});
export type AnswerGrade = z.infer<typeof AnswerGradeSchema>;

export const TutorRequestSchema = z.object({
  messages: z.array(HistoryMessageSchema).min(1),
  /** Compact textual description of what is on the board right now. */
  canvas: z.string().default(""),
  /** Session language, BCP-47 (en-IN, hi-IN, ...). */
  language: z.string().default("en-IN"),
  /** NCERT class 1-10 the student picked, or null if not chosen yet. */
  grade: z.number().int().min(1).max(10).nullish(),
  /** Subject the student picked. Values mirror SUBJECTS in lib/curriculum. */
  subject: z.enum(["maths", "science"]).nullish(),
  /** Free text about the student: "Class 10, CBSE, weak in algebra". */
  profile: z.string().default(""),
  /** Which stage of the lesson this turn is; defaults to the legacy single-turn flow. */
  mode: z.enum(TUTOR_MODES).default("ask"),
  /** The lesson plan designed earlier (teach/doubt turns thread it back so the model stays on plan). */
  plan: LessonPlanSchema.nullish(),
  /** Which plan step to teach (teach mode), 0-based. */
  step: z.number().int().min(0).nullish(),
  /** The student's self-reported familiarity with the topic, fed into planning. */
  familiarity: z.enum(["new", "some", "confident"]).nullish(),
  /** Which pipeline the student chose up front. Only "solve" changes behaviour. */
  track: z.enum(TUTOR_TRACKS).nullish(),
  /**
   * Solve mode: the question text already written on the board by the client, so the
   * server tells the model not to repeat it. Sent back on a solvedoubt turn too, as
   * the context of what is being solved.
   */
  solving: z.string().nullish(),
  /**
   * Checkpoint/grade modes: the running record of how this student has been
   * answering, which is what makes the questioning adaptive rather than a fixed
   * every-third-step rhythm. See `LessonRecordSchema`.
   */
  record: LessonRecordSchema.nullish(),
  /** Grade mode: the question that was asked, the answer being looked for (from
   *  the checkpoint decision that produced it), and what the student said back. */
  question: z.string().nullish(),
  expected: z.string().nullish(),
  answer: z.string().nullish(),
});
export type TutorRequest = z.infer<typeof TutorRequestSchema>;

/** NDJSON events streamed from /api/tutor to the browser. */
export type TutorEvent =
  | { type: "meta"; model: string; sources?: string[] }
  /** Plan mode, incremental: one step as soon as the planner finishes writing it,
   *  so the waiting screen fills with the real roadmap instead of a spinner. The
   *  authoritative plan still arrives as a single `plan` event at the end. */
  | { type: "planstep"; index: number; step: LessonStep }
  | { type: "plan"; plan: LessonPlan }
  /** Solve mode: the question, laid out as draw ops by the server (no LLM involved),
   *  sent before the first beat so the board shows what is being solved immediately.
   *  `question` is the plain text, for the transcript and for threading back as
   *  `solving` on a later doubt turn. */
  | { type: "question"; beat: Beat; question: string; label: string | null }
  | { type: "beat"; beat: Beat }
  /** Checkpoint mode: what to do at the gap between two steps — carry on, or put
   *  this question to the student. Absent (just `done`) means carry on. */
  | { type: "checkpoint"; plan: CheckpointPlan }
  /** Grade mode: the verdict on the answer the student just spoke, and the line
   *  to say back to them. Absent means treat it as partly right and move on. */
  | { type: "grade"; grade: AnswerGrade }
  | { type: "done" }
  | { type: "error"; message: string };
