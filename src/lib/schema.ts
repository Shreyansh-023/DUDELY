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
  ids: z.array(z.string()).nullish().catch(null).describe("Ids to remove (erase op only)."),
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
  // sources: textbook passages that grounded this turn (for debugging; the UI ignores it)
  | { type: "meta"; model: string; sources?: string[] }
  | { type: "beat"; beat: Beat }
  | { type: "done" }
  | { type: "error"; message: string };
