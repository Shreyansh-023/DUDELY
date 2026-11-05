import type { DrawOp } from "../../schema";
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

export type { Expanded };
