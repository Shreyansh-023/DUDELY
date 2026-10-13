import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `wave` op into a sine curve (sampled as line segments) on a dashed
 * baseline, with an amplitude arrow (A) at the first crest and a wavelength span
 * (λ) under one cycle. Use for transverse waves, SHM, sound, AC, light.
 */

const FONT = 16;

export function expandWave(op: DrawOp): Expanded {
  const pid = (op.id || "wav").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 680;
  const y = op.y ?? 300; // baseline
  const w = Math.max(op.w ?? 440, 120);
  const amp = Math.max(op.amp ?? 48, 8);
  const cycles = Math.max(op.waves ?? 2, 0.25);
  const col = op.color ?? "blue";
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - amp - 40, text: heading, size: "md", color: "purple" });

  // Dashed baseline.
  ops.push({ op: "line", id: `${pid}.base`, x, y, x2: x + w, y2: y, color: "gray", dash: true });

  // Sine curve.
  const n = Math.max(24, Math.round(cycles * 24));
  const yAt = (t: number) => y - amp * Math.sin(2 * Math.PI * cycles * t);
  for (let i = 0; i < n; i++) {
    ops.push({
      op: "line",
      id: `${pid}.s${i}`,
      x: x + (w * i) / n,
      y: yAt(i / n),
      x2: x + (w * (i + 1)) / n,
      y2: yAt((i + 1) / n),
      color: col,
    });
  }

  // Amplitude arrow at the first crest.
  const crestX = x + w / (4 * cycles);
  ops.push({ op: "arrow", id: `${pid}.amp`, x: crestX, y, x2: crestX, y2: y - amp, color: "green" });
  ops.push({ op: "text", id: `${pid}.ampl`, x: crestX + 6, y: y - amp / 2 - 9, text: "A", size: "sm", color: "green" });

  // Wavelength span under one cycle.
  const lamX = x + w / cycles;
  const ly = y + amp + 16;
  ops.push({ op: "line", id: `${pid}.lam`, x, y: ly, x2: lamX, y2: ly, color: "orange" });
  ops.push({ op: "line", id: `${pid}.lamA`, x, y: ly - 5, x2: x, y2: ly + 5, color: "orange" });
  ops.push({ op: "line", id: `${pid}.lamB`, x: lamX, y: ly - 5, x2: lamX, y2: ly + 5, color: "orange" });
  ops.push({ op: "text", id: `${pid}.laml`, x: (x + lamX) / 2 - measureText("λ", FONT) / 2, y: ly + 6, text: "λ", size: "sm", color: "orange" });

  const bbox = { x: x - 10, y: y - amp - (heading ? 46 : 16), w: w + 24, h: 2 * amp + (heading ? 80 : 56) };
  return { ops, bbox, label: `wave (${cycles}λ)` };
}
