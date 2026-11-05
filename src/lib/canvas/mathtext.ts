import { measureText } from "./measure";

/**
 * Superscripts and subscripts on the board.
 *
 * WHY THIS EXISTS: Excalidraw text is one font, one size, one baseline per
 * element, so "x²" can only be written with a Unicode glyph — and NONE of the
 * bundled fonts can carry that load. Verified against the shipped woff2 cmaps:
 *
 *   font          superscripts        subscripts
 *   Excalifont     0/11                0/10     <- the board default
 *   Virgil         3/11 (¹²³ only)     0/10
 *   ComicShanns    0/11                0/10
 *   Nunito         4/11                0/10
 *   LiberationSans 4/11 (¹²³ⁿ)         0/10     <- the math fallback
 *
 * So "x⁴" is mojibake everywhere and "H₂O" is mojibake everywhere — there is no
 * font to fall back to. The only honest fix is geometry: draw the base at the
 * normal size and the exponent as a SEPARATE smaller text element raised (or
 * lowered) from the base's baseline. That is what this module computes.
 *
 * It takes the notation a model actually writes — `x^2`, `x^(n+1)`, `H_2O` —
 * and returns positioned runs. The caller turns each run into its own text op.
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

export type MathLayout = {
  runs: MathRun[];
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
 * Splits text into runs at `^` and `_`.
 *
 * The script is the single character that follows, or a parenthesised group:
 *   x^2      -> x, sup 2
 *   x^(n+1)  -> x, sup n+1        (the parens are consumed, not drawn)
 *   H_2O     -> H, sub 2, then O
 *   10^-3    -> 10, sup -3        (a leading sign binds to the script)
 *
 * A `^` or `_` with nothing usable after it is left alone as a literal, so a
 * stray caret in prose never silently eats the next character.
 */
function parse(text: string, fontPx: number, level: Level, out: MathRun[], cursor: { x: number }, depth: number): void {
  let buf = "";
  let i = 0;

  const flush = () => {
    if (!buf) return;
    out.push({ text: hardenSpaces(buf), dx: cursor.x, dy: baselineShift(fontPx, level), fontPx, level });
    cursor.x += measureText(buf, fontPx);
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
        const nested: MathRun[] = [];
        const nestedCursor = { x: cursor.x };
        parse(script.body, childFont, childLevel, nested, nestedCursor, depth + 1);
        const shift = baselineShift(fontPx, childLevel) - baselineShift(fontPx, "base");
        for (const run of nested) out.push({ ...run, dy: run.dy + shift });
        cursor.x = nestedCursor.x;
        i = script.end;
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
 * The script that follows a `^` or `_` at index `i`, or null if there is none.
 * Returns the script's body (parens stripped) and the index just past it.
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
    return null; // unbalanced — treat the caret as literal
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
export function hasMathScript(text: string | null | undefined): boolean {
  if (!text) return false;
  for (let i = 0; i < text.length - 1; i++) {
    if ((text[i] === "^" || text[i] === "_") && scriptAfter(text, i + 1)) return true;
  }
  return false;
}

/**
 * Lays out one LINE of an expression into positioned runs. Returns null when
 * there is no script notation in it, so callers can keep using a single plain
 * text element for ordinary prose (cheaper, and it stays hand-drawn).
 */
export function layoutMathLine(text: string, fontPx: number): MathLayout | null {
  if (!hasMathScript(text)) return null;
  const runs: MathRun[] = [];
  const cursor = { x: 0 };
  parse(text, fontPx, "base", runs, cursor, 0);
  if (!runs.length) return null;

  // Normalise so the topmost run sits at dy=0, and report the full height.
  let top = Infinity;
  let bottom = -Infinity;
  for (const r of runs) {
    top = Math.min(top, r.dy);
    bottom = Math.max(bottom, r.dy + lineHeight(r.fontPx));
  }
  for (const r of runs) r.dy -= top;
  return { runs, w: cursor.x, h: bottom - top };
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
  return s.replace(/^ +/, (m) => " ".repeat(m.length)).replace(/ +$/, (m) => " ".repeat(m.length));
}

/** Excalidraw draws text at 1.25x the font size per line. */
export function lineHeight(fontPx: number): number {
  return Math.round(fontPx * 1.25);
}

/**
 * Strips script notation back to flat text ("x^2" -> "x2"). Used for anything
 * that needs a plain string rather than runs — the board summary the model
 * reads back, and width estimates made before layout.
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
