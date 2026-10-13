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
        ...(op.text ? { label: { text: op.text, fontSize: 20 } } : {}),
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
        ...(op.text ? { label: { text: op.text, fontSize: 16 } } : {}),
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
