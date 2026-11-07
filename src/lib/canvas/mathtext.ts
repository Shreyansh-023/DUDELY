import { measureText } from "./measure";

/**
 * Superscripts, subscripts and square roots on the board.
 *
 * WHY THIS EXISTS: Excalidraw text is one font, one size, one baseline per
 * element, so "x²" can only be written with a Unicode glyph — and NONE of the
 * bundled fonts can carry that load. Verified against the shipped woff2 cmaps:
 *
 *   font          superscripts        subscripts     √
 *   Excalifont     0/11                0/10          no   <- the board default
 *   Virgil         3/11 (¹²³ only)     0/10          no
 *   ComicShanns    0/11                0/10          no
 *   Nunito         4/11                0/10          no
 *   LiberationSans 4/11 (¹²³ⁿ)         0/10          yes  <- the math fallback
 *
 * So "x⁴" is mojibake everywhere, "H₂O" is mojibake everywhere, and "√2" could
 * only be had by switching the text to the fallback font — which on a Windows
 * machine is Arial, and a page of hand-written notes with one line (or, with
 * the old page-wide latch, the whole page) in Arial reads as a glitch. The only
 * honest fix is geometry: draw the base at the normal size and the exponent as
 * a SEPARATE smaller text element raised (or lowered) from the base's
 * baseline; draw the radical sign as two strokes and a bar over the radicand,
 * the way a hand draws it. That is what this module computes.
 *
 * It takes the notation a model actually writes — `x^2`, `x^(n+1)`, `H_2O`,
 * `√5`, `√(a^2 + b^2)` — and returns positioned runs plus the strokes to draw.
 * The caller turns each run into its own text op and each stroke into a line.
 */

/** A piece of a laid-out expression: its text, where to put it, how big. */
export type MathRun = {
  text: string;
  /** Offset from the expression's origin, in px. `dy` is the TOP of the run. */
  dx: number;
  dy: number;
  fontPx: number;
  level: Level;
};

/** A line segment of a radical sign, relative to the expression's origin. */
export type MathStroke = { x1: number; y1: number; x2: number; y2: number };

export type MathLayout = {
  runs: MathRun[];
  strokes: MathStroke[];
  /** Total advance width of the expression. */
  w: number;
  /** Full height, from the top of the highest superscript to the bottom of the
   *  lowest subscript. `dy` values are already relative to that top. */
  h: number;
};

type Level = "base" | "sup" | "sub";

/**
 * Scale and baseline shift for a raised/lowered run, as a fraction of the BASE
 * font size. These match the conventions typesetters use (and what the OpenType
 * `sups`/`subs` features do): roughly 70% size, raised about a third of the
 * base size, lowered about a sixth. Small enough to read as an exponent at a
 * glance, large enough to stay legible at the board's 16px `sm` size.
 */
const SCALE = 0.7;
// Measured against the rendered board, not picked from theory: a 0.34em rise
// left the exponent visibly detached, floating above the line rather than
// riding on the base's shoulder. These keep the script's body overlapping the
// top half of the base character, which is what reads as an exponent.
const SUP_RISE = 0.22;
const SUB_DROP = 0.12;

/** Nested scripts (x^(2^n)) shrink again, but never below this, or they vanish. */
const MIN_FONT_PX = 9;

/**
 * How deep scripts may nest. Two levels covers the real cases (x^(2^n)); past
 * that the type is too small to read, so a deeper `^` is drawn as a literal
 * caret rather than shrunk into an illegible speck.
 */
const MAX_DEPTH = 2;

/**
 * The radical sign, in em of the run's font: a short tick down, a long stroke
 * up to the bar, and the bar (vinculum) across the radicand. Proportions
 * follow how the sign is drawn by hand on a line of the same height.
 */
const RAD_TICK_X = 0.04;
const RAD_TICK_Y = 0.6;
const RAD_FOOT_X = 0.2;
const RAD_FOOT_Y = 1.0;
const RAD_TOP_X = 0.44;
const RAD_TOP_Y = 0.12;
/** Where the radicand starts, and the bar's overhang past it. */
const RAD_BODY_X = 0.52;
const RAD_OVERHANG = 0.14;
/** Air after the bar before the next run. */
const RAD_AFTER = 0.18;

type Ctx = { runs: MathRun[]; strokes: MathStroke[]; cursor: { x: number }; math: boolean };

/**
 * Splits text into runs at `^`, `_` and `√`.
 *
 * The script is the single character that follows, or a parenthesised group:
 *   x^2      -> x, sup 2
 *   x^(n+1)  -> x, sup n+1        (the parens are consumed, not drawn)
 *   H_2O     -> H, sub 2, then O
 *   10^-3    -> 10, sup -3        (a leading sign binds to the script)
 *   √5       -> radical strokes over "5"
 *   √(2n+1)  -> radical strokes over "2n+1"
 *
 * A `^`, `_` or `√` with nothing usable after it is left alone as a literal, so
 * a stray caret in prose never silently eats the next character.
 */
function parse(text: string, fontPx: number, level: Level, ctx: Ctx, depth: number): void {
  let buf = "";
  let i = 0;
  const top = baselineShift(fontPx, level);

  const flush = () => {
    if (!buf) return;
    ctx.runs.push({ text: hardenSpaces(buf), dx: ctx.cursor.x, dy: top, fontPx, level });
    ctx.cursor.x += measureText(buf, fontPx, ctx.math);
    buf = "";
  };

  while (i < text.length) {
    const ch = text[i];
    if ((ch === "^" || ch === "_") && i + 1 < text.length) {
      const script = scriptAfter(text, i + 1);
      if (script && depth < MAX_DEPTH) {
        flush();
        const childLevel: Level = ch === "^" ? "sup" : "sub";
        const childFont = Math.max(MIN_FONT_PX, Math.round(fontPx * SCALE));
        // A nested script is laid out relative to its parent, then the parent's
        // own shift is added, so x^(2^n) stacks correctly.
        const nested: Ctx = { runs: [], strokes: [], cursor: { x: ctx.cursor.x }, math: ctx.math };
        parse(script.body, childFont, childLevel, nested, depth + 1);
        const shift = baselineShift(fontPx, childLevel) - baselineShift(fontPx, "base");
        for (const run of nested.runs) ctx.runs.push({ ...run, dy: run.dy + shift });
        for (const s of nested.strokes) ctx.strokes.push({ ...s, y1: s.y1 + shift, y2: s.y2 + shift });
        ctx.cursor.x = nested.cursor.x;
        i = script.end;
        continue;
      }
    }
    if (ch === "√") {
      // A space between the sign and its radicand is a slip, not a literal.
      let j = i + 1;
      while (j < text.length && text[j] === " ") j++;
      const rad = scriptAfter(text, j);
      if (rad) {
        flush();
        const em = fontPx;
        const h = lineHeight(fontPx);
        const x0 = ctx.cursor.x;
        const y = (f: number) => top + f * h;
        const bodyX = x0 + RAD_BODY_X * em;
        // The radicand at the same level and size: a root is not a script.
        const nested: Ctx = { runs: [], strokes: [], cursor: { x: bodyX }, math: ctx.math };
        parse(rad.body, fontPx, level, nested, depth);
        const bodyW = Math.max(nested.cursor.x - bodyX, 0.5 * em);
        const barEnd = bodyX + bodyW + RAD_OVERHANG * em;
        ctx.strokes.push({ x1: x0 + RAD_TICK_X * em, y1: y(RAD_TICK_Y), x2: x0 + RAD_FOOT_X * em, y2: y(RAD_FOOT_Y) });
        ctx.strokes.push({ x1: x0 + RAD_FOOT_X * em, y1: y(RAD_FOOT_Y), x2: x0 + RAD_TOP_X * em, y2: y(RAD_TOP_Y) });
        ctx.strokes.push({ x1: x0 + RAD_TOP_X * em, y1: y(RAD_TOP_Y), x2: barEnd, y2: y(RAD_TOP_Y) });
        ctx.runs.push(...nested.runs);
        ctx.strokes.push(...nested.strokes);
        ctx.cursor.x = barEnd + RAD_AFTER * em;
        i = rad.end;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
}

/**
 * Top offset of a run's box relative to the base run's box top. A raised run is
 * both smaller and moved up; because `dy` is a TOP (not a baseline), the smaller
 * box also has to be nudged down by the size difference to sit on the same
 * baseline before the rise is applied.
 */
function baselineShift(basePx: number, level: Level): number {
  if (level === "base") return 0;
  const childPx = Math.max(MIN_FONT_PX, Math.round(basePx * SCALE));
  const align = basePx - childPx; // same-baseline position for the smaller box
  return level === "sup" ? -Math.round(basePx * SUP_RISE) : align + Math.round(basePx * SUB_DROP);
}

/**
 * The script that follows a `^`, `_` or `√` at index `i`, or null if there is
 * none. Returns the script's body (parens stripped) and the index just past it.
 */
function scriptAfter(text: string, i: number): { body: string; end: number } | null {
  if (text[i] === "(" || text[i] === "{") {
    const close = text[i] === "(" ? ")" : "}";
    let depth = 1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === text[i]) depth++;
      else if (text[j] === close && --depth === 0) {
        const body = text.slice(i + 1, j);
        return body ? { body, end: j + 1 } : null;
      }
    }
    return null; // unbalanced — treat the marker as literal
  }
  // Bare script: one token, so a script never swallows what follows it —
  // "H_2O" is H, sub 2, then a full-size O (not a subscripted "2O").
  //
  // A NUMBER stops at its digits, because a digit run is nearly always followed
  // by more formula ("x^2y" is x, sup 2, then y; "H_2O" likewise). LETTERS run
  // to the end of the word, because a multi-letter script is almost always one
  // name — "v_max" means v sub max, not v sub m then "ax". A single trailing
  // letter still works ("x^n"), and anything mixed needs brackets: "x^(2y)".
  const rest = text.slice(i);
  const m = /^[+-]?\d+(\.\d+)?/.exec(rest) ?? /^[+-]?[A-Za-z]+/.exec(rest);
  if (!m) return null;
  return { body: m[0], end: i + m[0].length };
}

/**
 * Unicode superscript/subscript characters -> the `^`/`_` notation this module
 * lays out. The model is told to write "x^2", but it has a strong habit of
 * reaching for "x²" anyway, and those characters are missing from every bundled
 * font (only ¹ ² ³ ⁿ exist anywhere, and no subscript does), so left alone they
 * render as mojibake. Rewriting them here means a lapse still comes out right.
 *
 * Runs of adjacent script characters become one bracketed script, so "x¹²" is
 * the exponent 12 rather than 1 then 2.
 */
const SUP_MAP: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁺": "+", "⁻": "-", "ⁿ": "n", "ⁱ": "i",
};
const SUB_MAP: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  "₊": "+", "₋": "-", "ₓ": "x", "ₙ": "n", "ₐ": "a",
};

export function normalizeScripts(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const map = SUP_MAP[text[i]] ? SUP_MAP : SUB_MAP[text[i]] ? SUB_MAP : null;
    if (!map) {
      out += text[i++];
      continue;
    }
    let body = "";
    while (i < text.length && map[text[i]]) body += map[text[i++]];
    const marker = map === SUP_MAP ? "^" : "_";
    // One token can go bare; anything longer needs brackets to stay together.
    out += /^[+-]?\d+$/.test(body) && body.length > 1 ? `${marker}(${body})` : `${marker}${body}`;
  }
  return out;
}

/** True when `text` contains notation this module would actually lay out. */
export function hasMathNotation(text: string | null | undefined): boolean {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "^" || ch === "_") && i + 1 < text.length && scriptAfter(text, i + 1)) return true;
    if (ch === "√") {
      let j = i + 1;
      while (j < text.length && text[j] === " ") j++;
      if (scriptAfter(text, j)) return true;
    }
  }
  return false;
}

/** @deprecated use hasMathNotation */
export const hasMathScript = hasMathNotation;

/**
 * Lays out one LINE of an expression into positioned runs. Returns null when
 * there is no notation in it, so callers can keep using a single plain text
 * element for ordinary prose (cheaper, and it stays hand-drawn).
 */
export function layoutMathLine(text: string, fontPx: number, math = false): MathLayout | null {
  if (!hasMathNotation(text)) return null;
  const ctx: Ctx = { runs: [], strokes: [], cursor: { x: 0 }, math };
  parse(text, fontPx, "base", ctx, 0);
  if (!ctx.runs.length && !ctx.strokes.length) return null;

  // Normalise so the topmost run sits at dy=0, and report the full height.
  let top = Infinity;
  let bottom = -Infinity;
  for (const r of ctx.runs) {
    top = Math.min(top, r.dy);
    bottom = Math.max(bottom, r.dy + lineHeight(r.fontPx));
  }
  for (const s of ctx.strokes) {
    top = Math.min(top, s.y1, s.y2);
    bottom = Math.max(bottom, s.y1, s.y2);
  }
  for (const r of ctx.runs) r.dy -= top;
  for (const s of ctx.strokes) {
    s.y1 -= top;
    s.y2 -= top;
  }
  return { runs: ctx.runs, strokes: ctx.strokes, w: ctx.cursor.x, h: bottom - top };
}

/**
 * Excalidraw does not RENDER a leading or trailing space in a text element (it
 * keeps the character but the element measures narrower). In ordinary text that
 * is invisible; here every run is absolutely positioned, so a dropped edge space
 * closes the gap between a script and the word after it — "ax^2 + bx" came out
 * as "axbx". Non-breaking spaces at the edges are rendered, so the gap holds.
 * Interior spaces are left alone, so word wrapping and copy-out stay normal.
 */
function hardenSpaces(s: string): string {
  return s.replace(/^ +/, (m) => " ".repeat(m.length)).replace(/ +$/, (m) => " ".repeat(m.length));
}

/** Excalidraw draws text at 1.25x the font size per line. */
export function lineHeight(fontPx: number): number {
  return Math.round(fontPx * 1.25);
}

/**
 * Strips script notation back to flat text ("x^2" -> "x2"). Used for anything
 * that needs a plain string rather than runs — the board summary the model
 * reads back, and width estimates made before layout. The √ sign is kept: it
 * is still the clearest way to read a root back.
 */
export function flattenMath(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if ((ch === "^" || ch === "_") && i + 1 < text.length) {
      const script = scriptAfter(text, i + 1);
      if (script) {
        // Recurse: the body may hold scripts of its own ("2^(3^2)" -> "232").
        out += flattenMath(script.body);
        i = script.end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Board text written the way it is SPOKEN, rewritten the way it is written on a
 * board: "theta" is θ, "30 degrees" is 30°, "root 3" is √3. The model is told
 * to write the symbols and still slips into the words it says aloud; a page
 * of "sin theta = root 3 / 2" is not what a teacher writes.
 */
export function symbolsForWords(text: string): string {
  const LEAD = String.raw`(?<!cube )\b(?:square\s+root\s+of|square\s+root|sqrt|root)`;
  return (
    text
      .replace(/\btheta\b/gi, "θ")
      .replace(/\balpha\b/gi, "α")
      .replace(/\bbeta\b/gi, "β")
      .replace(/\bphi\b/gi, "φ")
      .replace(/\b(\d+(?:\.\d+)?)\s*degrees?\b/gi, "$1°")
      // "root (2n+1)" / "sqrt(5)": a bracketed radicand; a single token drops the brackets.
      .replace(new RegExp(LEAD + String.raw`\s*\(([^()]{1,24})\)`, "gi"), (_m, body: string) =>
        /^[\w.]+$/.test(body) ? `√${body}` : `√(${body})`,
      )
      // "root 3", "square root of 5", "root x": one token; "a"/"i" stay English.
      .replace(new RegExp(LEAD + String.raw`\s+(\d+(?:\.\d+)?|[a-zA-Z])(?![\w(])`, "gi"), (m: string, body: string) =>
        /^[ai]$/i.test(body) ? m : `√${body}`,
      )
  );
}
