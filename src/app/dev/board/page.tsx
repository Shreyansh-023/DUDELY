"use client";

/**
 * Board harness: plays a scripted lesson through the real BoardPlayer with no
 * model, no voice and no API key, so the layout engine, the figure anchors and
 * the PDF export can be checked deterministically (and screenshotted by a
 * script). Open /dev/board, press Play, then PDF. `?autoplay=1` plays at once.
 *
 * The script below is written in the contract the model is asked to use: no
 * coordinates on notes or figures, annotations by name, sketches relative.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "@/components/Whiteboard";
import { downloadBoardPdf } from "@/lib/canvas/pdf";
import { CONTENT_LEFT, CONTENT_RIGHT, CONTENT_TOP, STEP_RULE_OFFSET } from "@/lib/canvas/page";
import type { DrawOp } from "@/lib/schema";

const Whiteboard = dynamic(() => import("@/components/Whiteboard"), { ssr: false });

type Step = { title: string; beats: DrawOp[][] };

const tri = (id: string, pts: [number, number, string][], extra: Partial<DrawOp> = {}): DrawOp => ({
  op: "polygon",
  id,
  points: pts.map(([x, y, label]) => ({ x, y, label })),
  ...extra,
});
const t = (id: string, text: string, extra: Partial<DrawOp> = {}): DrawOp => ({ op: "text", id, text, ...extra });

const LESSON: Step[] = [
  {
    title: "Why trigonometry — measuring the unreachable",
    beats: [
      [t("w1", "Why trigonometry?", { size: "md", color: "purple" }), t("w2", "Find the height of a tree without climbing it.")],
      [t("w3", "Same time of day means the sun's rays hit both at the same angle.", { color: "blue" })],
      [
        tri("tree", [[0, 0, "tree top"], [0, 260, "tree base"], [200, 260, "shadow end"]], { text: "tree triangle" }),
        tri("person", [[0, 0, "person head"], [0, 120, "person feet"], [92, 120, "shadow end"]], { text: "person triangle" }),
      ],
      [t("w4", "Similar triangles have matching side ratios.", { color: "blue" })],
      [t("w5", "tree height / tree shadow = person height / person shadow", { color: "green" })],
    ],
  },
  {
    title: "Right triangles and naming the sides",
    beats: [
      [t("r1", "Triangle ABC, right angled at B")],
      [tri("abc", [[0, 0, "A"], [0, 240, "B"], [320, 240, "C"]])],
      [{ op: "angle", id: "angA", at: "A", text: "θ", color: "blue" }, t("r2", "angle A = θ", { color: "blue" })],
      [{ op: "text", id: "hyp", at: "AC", text: "hypotenuse" }, t("r3", "AC is the hypotenuse — opposite the right angle", { color: "blue" })],
      [{ op: "text", id: "opp", at: "BC", text: "opposite" }, { op: "text", id: "adj", at: "AB", text: "adjacent" }],
      [{ op: "highlight", id: "hl1", at: "AC", temp: true }, t("r4", "sin, cos, tan are pure numbers — they depend only on the angle,\nnot on the size of the triangle", { color: "green" })],
    ],
  },
  {
    title: "The three main ratios — sine, cosine, tangent",
    beats: [
      [t("s1", "sin A = opposite / hypotenuse = BC / AC", { color: "purple" })],
      [t("s2", "cos A = adjacent / hypotenuse = AB / AC", { color: "purple" })],
      [t("s3", "tan A = opposite / adjacent = BC / AB", { color: "purple" })],
      [t("s4", "sin^2 A + cos^2 A = 1", { color: "green" }), t("s5", "AC^2 = AB^2 + BC^2 = 1^2 + 1^2 = 2, so AC = √2", { color: "blue" })],
      [t("s6", "Opposite 30° = 1, opposite 60° = √3, hypotenuse = 2")],
    ],
  },
  {
    title: "Trigonometric ratios of 30° and 60°",
    beats: [
      [t("e1", "Equilateral triangle ABC, each side 2 units", { color: "purple" })],
      [tri("eq", [[0, 0, "A"], [-160, 277, "B"], [160, 277, "C"]], { sides: ["2", "2", "2"] })],
      [{ op: "line", id: "alt", from: "A", to: "foot A BC", color: "red" }, { op: "text", id: "dlab", at: "mid BC", text: "D", color: "red" }],
      [{ op: "angle", id: "angB", at: "B", text: "60°" }, t("e2", "angle B = 60°, angle BAD = 30°")],
      [t("e3", "AB^2 = AD^2 + BD^2", { color: "purple" }), t("e4", "2^2 = AD^2 + 1^2", { color: "purple" }), t("e5", "AD^2 = 4 - 1 = 3, so AD = √3 units", { color: "green" })],
    ],
  },
  {
    title: "Practice from your textbook",
    beats: [
      [
        {
          op: "table",
          id: "tbl",
          text: "Trigonometric ratio table",
          rows: [
            ["Angle", "0°", "30°", "45°", "60°", "90°"],
            ["sin", "0", "1/2", "1/√2", "√3/2", "1"],
            ["cos", "1", "√3/2", "1/√2", "1/2", "0"],
            ["tan", "0", "1/√3", "1", "√3", "not defined"],
          ],
        },
      ],
      [t("p1", "sin^2 θ + cos^2 θ = 1", { color: "purple" }), t("p2", "1 + tan^2 θ = sec^2 θ", { color: "purple" })],
      [t("p3", "Triangle ABC right angled at B, AB = 24 cm, BC = 7 cm."), t("p4", "Find sin A, cos A, sin C, cos C.")],
      [t("p5", "AC^2 = AB^2 + BC^2 = 24^2 + 7^2 = 576 + 49 = 625"), t("p6", "AC = √625 = 25 cm", { color: "green" })],
      ...Array.from({ length: 9 }, (_, i) => [t(`fill${i}`, `Practice line ${i + 1}: sin A = 7/25, cos A = 24/25 — check: (7/25)^2 + (24/25)^2 = 1`)]),
    ],
  },
  {
    title: "Heights and distances — the classic application",
    beats: [
      [tri("obt", [[0, 0, "T"], [0, 300, "B"], [330, 300, "O"]]), t("h1", "Observer at O looks up at tower top T")],
      [{ op: "angle", id: "angO", at: "O", text: "elevation", color: "blue" }, t("h2", "Angle of elevation: from the horizontal OB up to the line of sight OT", { color: "blue" })],
      [{ op: "highlight", id: "hlOT", at: "OT" }, t("h3", "tan(elevation) = TB / OB", { color: "purple" })],
    ],
  },
  {
    // The cases the first live run exposed: a figure given in real units (tiny),
    // a label and a band on a DIAGONAL, a line joining two figures, and a table
    // whose cells are long sentences.
    title: "Edge cases from the live run",
    beats: [
      [tri("tiny", [[0, 0, "P"], [0, 5, "Q"], [10, 5, "R"]]), t("x1", "Given in real units: PQ = 5, QR = 10 — drawn at a readable size")],
      [{ op: "angle", id: "angP", at: "P", text: "α" }, { op: "text", id: "xq", at: "QR", text: "10 m" }],
      // The model redraws the same triangle to add side labels: the copy is not drawn, the labels land on the first.
      [tri("tiny2", [[0, 0, "P"], [0, 5, "Q"], [10, 5, "R"]], { sides: ["5 m", "", "hypotenuse"] }), t("xdup", "Same triangle again — labels only, no second copy")],
      [
        { op: "polygon", id: "quad", points: [{ x: 0, y: 0, label: "A" }, { x: 260, y: 0, label: "B" }, { x: 260, y: 200, label: "C" }, { x: 0, y: 200, label: "D" }], place: "below" },
        t("x2", "Rectangle ABCD with diagonal AC", { color: "blue" }),
      ],
      [{ op: "line", id: "diag", from: "A", to: "C", dash: true }, { op: "text", id: "diagl", at: "AC", text: "diagonal d" }, { op: "highlight", id: "hlAC", at: "AC" }],
      [
        tri("eye", [[0, 0, "E"], [0, 60, "F"], [40, 60, "G"]]),
        tri("tree", [[0, 0, "T"], [0, 260, "S"], [120, 260, "U"]]),
      ],
      [{ op: "line", id: "sight", from: "E", to: "T", of: "eye", dash: true, color: "blue", text: "line of sight" }],
      [
        {
          op: "table",
          id: "wide",
          text: "Six trigonometric ratios",
          rows: [
            ["Core ratio", "Reciprocal ratio"],
            ["sin theta = opposite / hypotenuse", "cosec theta = hypotenuse / opposite"],
            ["cos theta = adjacent / hypotenuse", "sec theta = hypotenuse / adjacent"],
            ["tan theta = opposite / adjacent", "cot theta = adjacent / opposite"],
          ],
        },
      ],
      [t("x3", "AC^2 = AB^2 + BC^2 lines up with", { color: "purple" }), t("x4", "a plain line below it", { color: "purple" }), t("x5", "and x^2 + y^2 = r^2 after that", { color: "purple" })],
      [t("x6", "sin^2 θ + cos^2 θ = 1 for 0° ≤ θ ≤ 90° (fallback font, runs still aligned)", { color: "green" })],
    ],
  },
];

function headingOps(step: number, title: string): DrawOp[] {
  const ruleY = CONTENT_TOP + STEP_RULE_OFFSET;
  return [
    { op: "text", id: `step_head_${step}`, layout: "fixed", x: CONTENT_LEFT, y: CONTENT_TOP, text: `${step + 1}. ${title}`, size: "lg", color: "purple" },
    ...[0, 1.5, 3].map((dy, i) => ({
      op: "line" as const,
      id: `step_rule_${step}_${i}`,
      layout: "fixed" as const,
      x: CONTENT_LEFT,
      y: ruleY + dy,
      x2: CONTENT_RIGHT,
      y2: ruleY + dy,
      color: "purple" as const,
    })),
  ];
}

export default function BoardHarness() {
  const boardRef = useRef<Board | null>(null);
  const [status, setStatus] = useState("idle");
  const playing = useRef(false);

  const play = useCallback(async () => {
    const b = boardRef.current;
    if (!b || playing.current) return;
    playing.current = true;
    const ac = new AbortController();
    let turn = 1;
    for (let i = 0; i < LESSON.length; i++) {
      const step = LESSON[i];
      setStatus(`step ${i + 1}: ${step.title}`);
      b.player.beginTeachTurn({ newStep: true });
      await b.player.drawStepHeading(headingOps(i, step.title), turn, ac.signal);
      for (const beat of step.beats) await b.player.applyBeat(beat, turn, ac.signal);
      turn++;
    }
    setStatus("done");
    playing.current = false;
  }, []);

  const pdf = useCallback(async () => {
    const b = boardRef.current;
    if (!b) return;
    setStatus("pdf…");
    const mod = await import("@excalidraw/excalidraw");
    const res = await downloadBoardPdf({
      player: b.player,
      exportToCanvas: mod.exportToCanvas as Parameters<typeof downloadBoardPdf>[0]["exportToCanvas"],
      getCommonBounds: mod.getCommonBounds as Parameters<typeof downloadBoardPdf>[0]["getCommonBounds"],
      topic: "harness-trigonometry",
    });
    setStatus("error" in res ? `pdf error: ${res.error}` : `pdf: ${res.pages} pages`);
  }, []);

  useEffect(() => {
    (window as unknown as { __harness?: unknown }).__harness = { play, pdf, board: () => boardRef.current };
  }, [play, pdf]);

  return (
    <div className="flex h-screen w-screen flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-sm">
        <button className="rounded border px-3 py-1" onClick={play} data-testid="play">
          Play
        </button>
        <button className="rounded border px-3 py-1" onClick={pdf} data-testid="pdf">
          PDF
        </button>
        <span data-testid="status">{status}</span>
      </div>
      <div className="min-h-0 flex-1">
        <Whiteboard
          onReady={(board) => {
            boardRef.current = board;
            if (new URLSearchParams(window.location.search).get("autoplay")) setTimeout(() => void play(), 800);
          }}
        />
      </div>
    </div>
  );
}
