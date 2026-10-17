import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ColorName, DrawOp, SizeName } from "../schema";

/**
 * Maps the LLM's compact draw ops to Excalidraw "skeleton" elements, which
 * `convertToExcalidrawElements` turns into fully-formed scene elements.
 *
 * Everything the tutor draws is tagged with customData.tutor so we can tell it
 * apart from the student's own strokes later.
 */

export const STROKE: Record<ColorName, string> = {
  black: "#1e1e1e",
  blue: "#1971c2",
  red: "#e03131",
  green: "#2f9e44",
  orange: "#f08c00",
  purple: "#9c36b5",
  gray: "#868e96",
};

export const FILL: Record<ColorName, string> = {
  black: "transparent",
  blue: "#a5d8ff",
  red: "#ffc9c9",
  green: "#b2f2bb",
  orange: "#ffd8a8",
  purple: "#eebefa",
  gray: "#e9ecef",
};

export const FONT_PX: Record<SizeName, number> = { sm: 16, md: 24, lg: 36 };

export const HIGHLIGHT_FILL = "#ffec99";

// Excalidraw font-family ids (the numbers used by appState.currentItemFontFamily).
// The board's default is the hand-drawn Excalifont (5); family 2 is the plain
// Helvetica substitute (LiberationSans). We keep everything hand-drawn EXCEPT
// text that contains a math glyph the hand-drawn fonts can't render (see below).
const FONT_HANDDRAWN = 5;
const FONT_MATH = 2;

/**
 * Characters that NONE of Excalidraw's hand-drawn fonts (Excalifont/Virgil/
 * Comic Shanns/Nunito/Lilita) have a glyph for, so the browser substitutes a
 * fallback and they come out as mojibake on the board — e.g. "√2" rendered as
 * "Ã2", "x²" as garbage. Every character listed here DOES exist in the bundled
 * Helvetica substitute (LiberationSans), so any string containing one is drawn
 * in that font instead. Verified against the bundled woff2 cmaps.
 *
 * Symbols the hand-drawn font CAN draw are deliberately left out so ordinary
 * text keeps its hand-drawn feel: × ÷ · − ± ° π θ Σ µ λ α β ½ ¼ ¾ – — …
 * Covered here: √∛ superscripts(² ³ ¹ ⁰ ⁴⁵⁶⁷⁸⁹ ⁿ) subscripts(₀–₉) Δ Ω
 * ≤ ≥ ≠ ≈ ≡ ∝ ∞ → ← ↔ ⇒ ∫ ∏ ∂ ∇ ∈∉ ∠ ∥ ∩∪ ⊂⊃ ∅ ∴ ∵ △ ′ ″.
 */
const MATH_GLYPHS_NEEDING_FALLBACK =
  /[²³¹⁰-₟√-∜ΔΩ∂∇∏∈-∍∠∥∩∪⊂⊃∅∫-∮∴∵≈≠≡≤≥∝∞←-⇿′″△]/;

/**
 * Indic/Arabic scripts (Devanagari, Bengali, Tamil, Telugu, …, Arabic/Urdu).
 * The math fallback font (LiberationSans) is Latin-only, so a string that mixes
 * one of these scripts with a math glyph must STAY hand-drawn — switching fonts
 * would drop the letters entirely, which is worse than one mis-rendered symbol.
 * Pure "√2" / "x²" labels have no such letters and are still fixed.
 */
const COMPLEX_SCRIPT = /[؀-ۿऀ-෿]/;

/**
 * Font family for a piece of board text: the Helvetica fallback (family 2) when
 * the string contains a math glyph the hand-drawn font lacks, otherwise the
 * hand-drawn default (family 5). Excalidraw text is single-font per element, so
 * a short label like "√2" renders wholly in Helvetica — clean, and far better
 * than the "Ã2" mojibake the hand-drawn font produced.
 */
export function boardFontFamily(text: string | null | undefined): typeof FONT_HANDDRAWN | typeof FONT_MATH {
  if (!text || !MATH_GLYPHS_NEEDING_FALLBACK.test(text)) return FONT_HANDDRAWN;
  if (COMPLEX_SCRIPT.test(text)) return FONT_HANDDRAWN;
  return FONT_MATH;
}

export type TutorMeta = {
  tutor: true;
  turn: number;
  opId?: string;
  temp?: boolean;
  highlight?: boolean;
  // Children of a high-level primitive (e.g. a numberline) share the parent's id
  // in `group`, so the board summary can collapse them to one line and an erase
  // of the parent removes the whole group.
  group?: string;
  groupLabel?: string;
};

function meta(turn: number, opId?: string | null, temp?: boolean | null): TutorMeta {
  return { tutor: true, turn, opId: opId ?? undefined, temp: temp ? true : undefined };
}

/**
 * Returns the skeleton(s) for one op, or null for ops that do not create
 * elements (erase/clear are handled by the player).
 */
export function opToSkeleton(
  op: DrawOp,
  turn: number,
  elementId: string,
): ExcalidrawElementSkeleton | null {
  const color = op.color ?? "black";
  const stroke = STROKE[color];

  switch (op.op) {
    case "text": {
      if (!op.text) return null;
      return {
        type: "text",
        id: elementId,
        x: op.x ?? 0,
        y: op.y ?? 0,
        text: op.text,
        fontSize: FONT_PX[op.size ?? "md"],
        fontFamily: boardFontFamily(op.text),
        strokeColor: stroke,
        textAlign: "left",
        customData: meta(turn, op.id, op.temp),
      };
    }
    case "rect":
    case "ellipse":
    case "diamond": {
      const type = op.op === "rect" ? "rectangle" : op.op;
      return {
        type,
        id: elementId,
        x: op.x ?? 0,
        y: op.y ?? 0,
        // An explicit size is respected (down to 4px, so primitives can draw small
        // dots); only an OMITTED size falls back to a comfortable default.
        width: op.w != null ? Math.max(op.w, 4) : 160,
        height: op.h != null ? Math.max(op.h, 4) : 80,
        strokeColor: stroke,
        backgroundColor: FILL[color],
        fillStyle: "hachure",
        roughness: 1,
        roundness: type === "rectangle" ? { type: 3 } : null,
        customData: meta(turn, op.id, op.temp),
        ...(op.text ? { label: { text: op.text, fontSize: 20, fontFamily: boardFontFamily(op.text) } } : {}),
      };
    }
    case "arrow":
    case "line": {
      const x = op.x ?? 0;
      const y = op.y ?? 0;
      const dx = (op.x2 ?? x + 120) - x;
      const dy = (op.y2 ?? y) - y;
      return {
        type: op.op,
        id: elementId,
        x,
        y,
        width: Math.abs(dx),
        height: Math.abs(dy),
        points: [
          [0, 0],
          [dx, dy],
        ],
        strokeColor: stroke,
        strokeWidth: 2,
        strokeStyle: op.dash ? "dashed" : "solid",
        roughness: 1,
        endArrowhead: op.op === "arrow" ? "arrow" : null,
        startArrowhead: null,
        customData: meta(turn, op.id, op.temp),
        ...(op.text ? { label: { text: op.text, fontSize: 16, fontFamily: boardFontFamily(op.text) } } : {}),
      } as ExcalidrawElementSkeleton;
    }
    case "highlight": {
      return {
        type: "rectangle",
        id: elementId,
        x: op.x ?? 0,
        y: op.y ?? 0,
        width: Math.max(op.w ?? 160, 20),
        height: Math.max(op.h ?? 60, 20),
        strokeColor: "transparent",
        backgroundColor: HIGHLIGHT_FILL,
        fillStyle: "solid",
        roughness: 0,
        opacity: 45,
        roundness: { type: 3 },
        // Tagged so collision avoidance never treats a translucent highlight as an
        // obstacle — it is meant to overlay the very content it points at.
        customData: { ...meta(turn, op.id, op.temp), highlight: true },
      };
    }
    case "numberline":
    case "axes":
    case "bars":
    case "fraction":
    case "polygon":
    case "angle":
    case "vector":
    case "table":
    case "circuit":
    case "optics":
    case "molecule":
    case "solid":
    case "labeled":
    case "punnett":
    case "net":
    case "reaction":
    case "tree":
    case "venn":
    case "graph":
    case "apparatus":
    case "curvearrow":
    case "wave":
    case "pie":
    case "incline":
    case "timeline":
    case "erase":
    case "clear":
      // High-level primitives are expanded into low-level ops by the player
      // before they ever reach here; erase/clear create no elements.
      return null;
  }
}
