import type { DrawOp } from "../../schema";
import { measureText, boundsOf, type Expanded } from "./util";

/**
 * Lowers a `molecule` op into a structural formula: element symbols at the atom
 * positions the model gives, with bond lines between them (single/double/triple
 * drawn as 1/2/3 parallel lines). Bonds are shortened near a labelled atom so the
 * line never runs through the letter.
 */

const FONT = 16;

export function expandMolecule(op: DrawOp): Expanded {
  const pid = (op.id || "mol").replace(/[^a-zA-Z0-9_-]/g, "_");
  const atoms = (op.atoms ?? []).filter((a) => a && a.id && Number.isFinite(a.x) && Number.isFinite(a.y));
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (atoms.length && heading) {
    const b = boundsOf(atoms);
    ops.push({ op: "text", id: `${pid}.h`, x: b.x, y: b.y - 42, text: heading, size: "md", color: "purple" });
  }

  // Bonds first (so the element letters sit on top of the line ends).
  (op.bonds ?? []).forEach((bond, bi) => {
    const a = byId.get(bond.from);
    const b = byId.get(bond.to);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const gapA = (a.el ?? "").trim() ? 14 : 4;
    const gapB = (b.el ?? "").trim() ? 14 : 4;
    const sx = a.x + ux * gapA;
    const sy = a.y + uy * gapA;
    const ex = b.x - ux * gapB;
    const ey = b.y - uy * gapB;
    const order = Math.max(1, Math.min(3, Math.round(bond.order ?? 1)));
    // Perpendicular offset for multiple bonds.
    const px = -uy;
    const py = ux;
    const offsets = order === 1 ? [0] : order === 2 ? [-3, 3] : [-5, 0, 5];
    offsets.forEach((o, k) => {
      ops.push({
        op: "line",
        id: `${pid}.b${bi}_${k}`,
        x: sx + px * o,
        y: sy + py * o,
        x2: ex + px * o,
        y2: ey + py * o,
        color: "black",
      });
    });
  });

  // Aromatic ring: an inner circle at the centroid of the named ring atoms.
  const ringAtoms = (op.ring ?? []).map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (ringAtoms.length >= 3) {
    const rcx = ringAtoms.reduce((s, a) => s + a.x, 0) / ringAtoms.length;
    const rcy = ringAtoms.reduce((s, a) => s + a.y, 0) / ringAtoms.length;
    const rad = ringAtoms.reduce((s, a) => s + Math.hypot(a.x - rcx, a.y - rcy), 0) / ringAtoms.length;
    const inner = rad * 0.55;
    ops.push({ op: "ellipse", id: `${pid}.ring`, x: rcx - inner, y: rcy - inner, w: inner * 2, h: inner * 2, color: "black" });
  }

  // Atom labels (element symbols) centred on each position; a bare vertex gets a dot.
  atoms.forEach((a, i) => {
    const el = (a.el ?? "").trim();
    if (el) {
      ops.push({ op: "text", id: `${pid}.a${i}`, x: a.x - measureText(el, FONT) / 2, y: a.y - 9, text: el, size: "sm", color: a.color ?? "black" });
    } else {
      ops.push({ op: "ellipse", id: `${pid}.a${i}`, x: a.x - 3, y: a.y - 3, w: 6, h: 6, color: a.color ?? "black" });
    }
  });

  const b = atoms.length ? boundsOf(atoms) : { x: op.x ?? 0, y: op.y ?? 0, w: 1, h: 1 };
  const bbox = { x: b.x - 30, y: b.y - (heading ? 48 : 20), w: b.w + 60, h: b.h + (heading ? 70 : 40) };
  return { ops, bbox, label: `molecule (${atoms.length} atoms)` };
}
