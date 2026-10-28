import {
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_TOP,
  MD_PITCH,
} from "./canvas/page";
import { FONT_PX } from "./canvas/ops";
import type { Beat, DrawOp } from "./schema";

/**
 * Write the question on the board without asking the model to do it.
 *
 * In solve mode the question text is already known exactly — it came out of the
 * solutions index (or is the student's own words) — so having an LLM re-emit it as
 * draw ops only adds latency and a chance of it paraphrasing, re-numbering or
 * silently changing a value. This lays it out here instead: pure, synchronous,
 * deterministic, and the same every time.
 *
 * The model then starts at the solution, and is told (see buildSolvePrompt) that the
 * heading and question are already on the board.
 */

/** Width of the writable column. */
const COL_W = CONTENT_RIGHT - CONTENT_LEFT;
/**
 * Mean glyph width as a fraction of font size, for the hand-drawn board font.
 *
 * Server-side only, so lib/canvas/measure.ts (which needs a DOM canvas) is not
 * available here. These must ERR HIGH: under-estimating runs text off the page,
 * while over-estimating only wraps a line early. 0.62 sits just above the 0.6
 * that measure.ts uses for its own no-canvas fallback.
 */
const GLYPH_RATIO = 0.62;
/** Devanagari and other complex scripts render wider per character than Latin. */
const GLYPH_RATIO_COMPLEX = 0.78;
const COMPLEX_SCRIPT = /[ऀ-෿]/;
/**
 * Most lines of question text the board will carry. The question block shares the
 * page with the working, so it gets roughly the top third; beyond this the text is
 * truncated on the board only — the model still receives the whole question.
 */
const MAX_QUESTION_LINES = 6;

/** Rough rendered width (px) of `text`. Mirrors measureText's fallback estimate. */
function width(text: string, fontPx: number): number {
  const ratio = COMPLEX_SCRIPT.test(text) ? GLYPH_RATIO_COMPLEX : GLYPH_RATIO;
  return text.length * fontPx * ratio;
}

/** Greedy word wrap to `maxWidth`, keeping existing line breaks as hard breaks. */
function wrap(text: string, fontPx: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next, fontPx) > maxWidth) {
        out.push(line);
        // A single word longer than the column (a long expression): hard-split it
        // rather than let it run off the page.
        line = word;
        while (width(line, fontPx) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && width(line.slice(0, cut), fontPx) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Collapse the whitespace a PDF extraction leaves behind, without touching content. */
function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export type QuestionBoard = {
  /** The ops that write the heading + question, in order. */
  ops: DrawOp[];
  /** Page-local y where the model should start its solution. */
  nextY: number;
  /** The wrapped question lines, for the prompt's CANVAS description. */
  lines: string[];
};

/**
 * Lay out "<heading>" + the question text at the top of a fresh page.
 *
 * `heading` is the positional label ("Exercise 5.2 · Q3"); omit it for a question
 * the student typed themselves, which has no book reference.
 */
export function layoutQuestion(opts: {
  question: string;
  heading?: string | null;
  /** Page-local y to start at. Defaults to the top of the content box. */
  top?: number;
}): QuestionBoard {
  const ops: DrawOp[] = [];
  let y = opts.top ?? CONTENT_TOP;

  const heading = opts.heading?.trim();
  if (heading) {
    ops.push({
      op: "text",
      id: "q_head",
      x: CONTENT_LEFT,
      y,
      text: heading,
      size: "md",
      color: "blue",
    });
    y += MD_PITCH;
  }

  const question = tidy(opts.question);
  const wrapped = question ? wrap(question, FONT_PX.sm, COL_W) : [];
  // A very long question (a multi-part one, or a table flattened by extraction)
  // must not eat the page the solution needs. Keep the first lines, mark the cut:
  // the model still has the full text in its prompt, so nothing is lost from the
  // solution itself — only from what is transcribed on the board.
  const lines =
    wrapped.length > MAX_QUESTION_LINES
      ? [...wrapped.slice(0, MAX_QUESTION_LINES - 1), `${wrapped[MAX_QUESTION_LINES - 1]} …`]
      : wrapped;
  lines.forEach((line, i) => {
    ops.push({
      op: "text",
      id: `q_line${i + 1}`,
      x: CONTENT_LEFT,
      y,
      text: line,
      size: "sm",
      color: "black",
    });
    // `sm` text is 16px in a 50px md grid; pack question lines tighter than the
    // teaching grid so a long question does not eat the whole page.
    y += 30;
  });

  // Underline the question block so the solution below reads as a separate section.
  if (lines.length > 0) {
    y += 10;
    ops.push({
      op: "line",
      id: "q_rule",
      x: CONTENT_LEFT,
      y,
      x2: CONTENT_LEFT + Math.min(COL_W, Math.max(...lines.map((l) => width(l, FONT_PX.sm)))),
      y2: y,
      color: "gray",
    });
    y += 26;
  }

  return { ops, nextY: y, lines };
}

/**
 * The question as a single opening beat: nothing spoken, the board written.
 *
 * `say` is empty on purpose — the model's first beat does the talking, and this
 * beat exists only to put the question up before it starts. The client plays a
 * beat with no speech as a pure drawing beat.
 */
export function questionBeat(opts: {
  question: string;
  heading?: string | null;
  top?: number;
}): { beat: Beat; nextY: number; lines: string[] } {
  const { ops, nextY, lines } = layoutQuestion(opts);
  return { beat: { say: "", draw: ops }, nextY, lines };
}
