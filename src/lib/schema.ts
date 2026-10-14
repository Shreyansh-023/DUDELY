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

export const TutorRequestSchema = z.object({
  messages: z.array(HistoryMessageSchema).min(1),
  /** Compact textual description of what is on the board right now. */
  canvas: z.string().default(""),
  /** Session language, BCP-47 (en-IN, hi-IN, ...). */
  language: z.string().default("en-IN"),
  /** NCERT class 1-12 the student picked, or null if not chosen yet. */
  grade: z.number().int().min(1).max(12).nullish(),
  /** Subject the student picked. Values mirror SUBJECTS in lib/curriculum. */
  subject: z.enum(["maths", "science"]).nullish(),
  /** Free text about the student: "Class 10, CBSE, weak in algebra". */
  profile: z.string().default(""),
});
export type TutorRequest = z.infer<typeof TutorRequestSchema>;

/** NDJSON events streamed from /api/tutor to the browser. */
export type TutorEvent =
  | { type: "meta"; model: string; sources?: string[] }
  | { type: "beat"; beat: Beat }
  | { type: "done" }
  | { type: "error"; message: string };
