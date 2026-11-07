import type { DrawOp } from "../../schema";
import { hasMathNotation } from "../mathtext";
import { expandAngle } from "./angle";
import { expandApparatus } from "./apparatus";
import { expandAxes } from "./axes";
import { expandBars } from "./bars";
import { expandCircles } from "./circles";
import { expandCircuit } from "./circuit";
import { expandCurvearrow } from "./curvearrow";
import { expandFraction } from "./fraction";
import { expandGraph } from "./graph";
import { expandIncline } from "./incline";
import { expandLabeled } from "./labeled";
import { expandMathText } from "./mathline";
import { expandMolecule } from "./molecule";
import { expandNet } from "./net";
import { expandNumberLine } from "./numberline";
import { expandOptics } from "./optics";
import { expandPie } from "./pie";
import { expandPolygon } from "./polygon";
import { expandPunnett } from "./punnett";
import { expandReaction } from "./reaction";
import { expandSolid } from "./solid";
import { expandTable } from "./table";
import { expandTimeline } from "./timeline";
import { expandTree } from "./tree";
import { expandVector } from "./vector";
import { expandVenn } from "./venn";
import { expandWave } from "./wave";
import type { Expanded } from "./util";

/**
 * Registry of high-level diagram primitives. Each entry lowers one semantic op
 * into low-level draw ops with geometry computed by code, so the structure can
 * never overlap itself. Adding a new primitive = write an expander, register it
 * here, add the op name to OPS, and document it in the prompt.
 */
export const PRIMITIVES: Record<string, (op: DrawOp) => Expanded> = {
  numberline: expandNumberLine,
  axes: expandAxes,
  bars: expandBars,
  fraction: expandFraction,
  polygon: expandPolygon,
  angle: expandAngle,
  vector: expandVector,
  table: expandTable,
  circles: expandCircles,
  circuit: expandCircuit,
  optics: expandOptics,
  molecule: expandMolecule,
  solid: expandSolid,
  labeled: expandLabeled,
  punnett: expandPunnett,
  net: expandNet,
  reaction: expandReaction,
  tree: expandTree,
  venn: expandVenn,
  graph: expandGraph,
  apparatus: expandApparatus,
  curvearrow: expandCurvearrow,
  wave: expandWave,
  pie: expandPie,
  incline: expandIncline,
  timeline: expandTimeline,
};

/**
 * A figure's own labels can carry notation too — a side marked "√2", a table
 * cell "√3/2", an axis titled "x^2" — and a plain text element cannot draw
 * any of it. Each such child is lowered to its runs and strokes, exactly as a
 * free text op would be, so the figure's labels read like the notes around it.
 */
export function lowerMathChildren(ex: Expanded): Expanded {
  if (!ex.ops.some((o) => o.op === "text" && hasMathNotation(o.text))) return ex;
  const ops: DrawOp[] = [];
  for (const o of ex.ops) {
    if (o.op === "text" && hasMathNotation(o.text)) ops.push(...expandMathText(o).ops);
    else ops.push(o);
  }
  return { ...ex, ops };
}

/** Expand a primitive op, with its labels' notation lowered. Null for a non-primitive. */
export function expandPrimitive(op: DrawOp): Expanded | null {
  const fn = PRIMITIVES[op.op];
  return fn ? lowerMathChildren(fn(op)) : null;
}

export type { Expanded };
