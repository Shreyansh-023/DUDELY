import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `circles` op into concentric circles sharing ONE centre.
 *
 * Why this is a primitive rather than several `ellipse` ops: a raw shape is put
 * through collision avoidance, which treats any overprint as a mistake and
 * shoves the newer shape clear. Two circles that are meant to sit inside one
 * another are exactly that kind of overprint, so hand-built concentric circles
 * could never survive — the inner one was always ejected. Children of a
 * primitive are pre-solved and skip per-child collision, so here they stay put.
 *
 * Used for: circle geometry (radius/diameter/chord work), annulus and
 * cross-section figures, orbital shells, ripples, target/dartboard models.
 */

const FONT = 16;
/** Rendered height of one `sm` label line. */
const TEXT_H = 20;

export function expandCircles(op: DrawOp): Expanded {
  const pid = (op.id || "circ").replace(/[^a-zA-Z0-9_-]/g, "_");
  // (x, y) is the CENTRE here, unlike a raw ellipse's top-left: concentric
  // circles are defined by a shared centre, and making the model compute a
  // different top-left per radius is what invites mistakes.
  const cx = op.x ?? 760;
  const cy = op.y ?? 300;

  // Radii, largest first so a filled inner circle is not hidden by an outer one.
  const given = (op.radii ?? []).filter((r) => Number.isFinite(r) && r > 0);
  const radii = (given.length ? given : [140, 90, 45]).map((r) => Math.max(8, Math.min(r, 400)));
  const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);

  const labels = op.labels ?? [];
  const colors = op.colors ?? [];
  const base = op.color ?? "black";
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  const maxR = order[0].r;
  if (heading) {
    const hw = measureText(heading, 24);
    ops.push({ op: "text", id: `${pid}.h`, x: cx - hw / 2, y: cy - maxR - 44, text: heading, size: "md", color: "purple" });
  }

  for (const { r, i } of order) {
    ops.push({
      op: "ellipse",
      id: `${pid}.c${i}`,
      // An ellipse is placed by its top-left, so convert from the centre.
      x: cx - r,
      y: cy - r,
      w: r * 2,
      h: r * 2,
      color: colors[i] ?? base,
    });
  }

  // Centre dot, so the shared centre reads as deliberate rather than accidental.
  if (op.centre !== false) {
    ops.push({ op: "ellipse", id: `${pid}.o`, x: cx - 3, y: cy - 3, w: 6, h: 6, color: base });
  }

  // A radius line per circle, drawn at a different angle each so the labels that
  // sit on them cannot land on top of one another. The angles are spread over
  // the whole circle rather than a narrow fan: with a fixed small step, two
  // radii of similar length put their labels within a few px of each other.
  if (op.radii_lines) {
    const n = order.length;
    // Sweep from just below the horizontal, downward and round. The top of the
    // figure is left alone because the heading sits there: a label swung up to
    // 12 o'clock landed on it ("r = 5 cm" across "Annulus").
    const start = 20;
    const sweep = 290;
    const spread = n > 1 ? sweep / (n - 1) : 0;
    order.forEach(({ r, i }, k) => {
      const angle = (start + k * spread) * (Math.PI / 180);
      const lab = labels[i];
      const lw = lab ? measureText(lab, FONT) : 0;
      // Where the label goes decides how far the line runs, so work it out
      // first. A label wider than the gap between this circle and the next one
      // in cannot sit between the arcs without crossing one, so it goes OUTSIDE
      // the whole figure — and the radius line is then extended to reach it, or
      // it would point into empty space.
      const inner = order[k + 1]?.r ?? 0;
      const outside = Boolean(lab) && lw + 12 > r - inner;
      const lineTo = outside ? maxR + 10 : r;
      ops.push({
        op: "line",
        id: `${pid}.r${i}`,
        x: cx,
        y: cy,
        x2: cx + Math.cos(angle) * lineTo,
        y2: cy + Math.sin(angle) * lineTo,
        color: colors[i] ?? base,
        // Explicitly permanent: a bare line is structure here, not a gesture.
        temp: false,
      });
      if (lab) {
        if (outside) {
          // Anchor the label's NEAREST corner just past the outer arc. Anchoring
          // its centre is not enough on a diagonal: half the label swings back
          // over the circle, which is how "r = 5 cm" ended up across the rim.
          const ax = cx + Math.cos(angle) * (maxR + 16);
          const ay = cy + Math.sin(angle) * (maxR + 16);
          ops.push({
            op: "text",
            id: `${pid}.rl${i}`,
            x: Math.cos(angle) >= 0 ? ax : ax - lw,
            // Same idea vertically: drop below / lift above by the text height
            // so the box, not just its anchor, clears the arc.
            y: Math.sin(angle) >= 0 ? ay : ay - TEXT_H,
            text: lab,
            size: "sm",
            color: colors[i] ?? "blue",
          });
        } else {
          const at = (r + inner) / 2;
          ops.push({
            op: "text",
            id: `${pid}.rl${i}`,
            x: cx + Math.cos(angle) * at - lw / 2,
            y: cy + Math.sin(angle) * at - TEXT_H / 2,
            text: lab,
            size: "sm",
            color: colors[i] ?? "blue",
          });
        }
      }
    });
  } else {
    // No radii drawn: label each ring just outside its own arc, straight up from
    // the centre, so every label clears the ring inside it.
    order.forEach(({ r, i }) => {
      const lab = labels[i];
      if (!lab) return;
      const lw = measureText(lab, FONT);
      ops.push({
        op: "text",
        id: `${pid}.l${i}`,
        x: cx - lw / 2,
        y: cy - r + 8,
        text: lab,
        size: "sm",
        color: colors[i] ?? "blue",
      });
    });
  }

  // The box must cover every child, including a label pushed outside the rings,
  // or collision avoidance would let later content land on top of one.
  const pad = 28;
  let x1 = cx - maxR - pad;
  let y1 = cy - maxR - (heading ? 56 : pad);
  let x2 = cx + maxR + pad;
  let y2 = cy + maxR + pad;
  for (const o of ops) {
    if (o.op !== "text") continue;
    const ox = o.x ?? 0;
    const oy = o.y ?? 0;
    x1 = Math.min(x1, ox - 8);
    y1 = Math.min(y1, oy - 6);
    x2 = Math.max(x2, ox + measureText(o.text ?? "", o.size === "md" ? 24 : FONT) + 8);
    y2 = Math.max(y2, oy + 26);
  }
  const bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  return { ops, bbox, label: `concentric circles (${radii.length})` };
}
