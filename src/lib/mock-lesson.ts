import type { Beat, DrawOp } from "./schema";

/** Fills the nullable draw-op fields so mock literals can stay terse yet type-check. */
const op = (o: Partial<DrawOp> & Pick<DrawOp, "op">): DrawOp => ({
  id: null,
  x: null,
  y: null,
  w: null,
  h: null,
  x2: null,
  y2: null,
  text: null,
  size: null,
  color: null,
  ids: null,
  ...o,
});

/**
 * A canned lesson used when LLM_PROVIDER=mock. Lets you demo and test the
 * whiteboard + voice pipeline without any API key.
 */
export function mockLesson(question: string, language: string, turn: number): Beat[] {
  const hi = language.startsWith("hi");
  const y0 = 80 + (turn - 1) * 420;
  const q = question.length > 38 ? question.slice(0, 35) + "…" : question;

  if (turn > 1) {
    return hi
      ? [
          { say: "Bahut badhiya, sahi pakde ho.", lang: "hi-IN", draw: [op({ op: "text", id: `ok${turn}`, x: 80, y: y0, text: "✓ Sahi!", size: "lg", color: "green" })] },
          { say: "Ab batao, agar 4 ki jagah 8 tukde hote, to aadha kitne tukde hota?", lang: "hi-IN", draw: [op({ op: "text", id: `q${turn}`, x: 80, y: y0 + 70, text: "8 tukde → aadha = ? tukde", color: "orange" })] },
        ]
      : [
          { say: "Nice, that is exactly right.", lang: "en-IN", draw: [op({ op: "text", id: `ok${turn}`, x: 80, y: y0, text: "✓ Correct!", size: "lg", color: "green" })] },
          { say: "Now, if the pizza had 8 slices instead of 4, how many slices make a half?", lang: "en-IN", draw: [op({ op: "text", id: `q${turn}`, x: 80, y: y0 + 70, text: "8 slices → half = ? slices", color: "orange" })] },
        ];
  }

  const s = hi
    ? ["Achha, chalo isko pizza se samajhte hain.", "Yeh ek pizza hai jisko maine 4 barabar tukdon mein kaata.", "Tumne 2 tukde kha liye, matlab 2 by 4.", "Ab dekho, yeh highlighted hissa pure pizza ka kitna hai? Aadha, ya kam?"]
    : ["Okay, let us see this with a pizza.", "Here is a pizza that I cut into 4 equal slices.", "You ate 2 slices, so that is 2 by 4.", "Now look at the highlighted part. Is it half the pizza, or less?"];
  const lang = hi ? "hi-IN" : "en-IN";

  return [
    { say: s[0], lang, draw: [op({ op: "text", id: "t1", x: 80, y: y0, text: q, size: "lg", color: "purple" })] },
    {
      say: s[1],
      lang,
      draw: [
        op({ op: "ellipse", id: "p1", x: 700, y: y0, w: 220, h: 220, color: "orange" }),
        op({ op: "line", id: "l1", x: 810, y: y0, x2: 810, y2: y0 + 220 }),
        op({ op: "line", id: "l2", x: 700, y: y0 + 110, x2: 920, y2: y0 + 110 }),
        op({ op: "text", id: "t2", x: 700, y: y0 + 240, text: "4 equal slices", size: "sm", color: "gray" }),
      ],
    },
    {
      say: s[2],
      lang,
      draw: [
        op({ op: "highlight", id: "h1", x: 700, y: y0, w: 110, h: 220 }),
        op({ op: "text", id: "t3", x: 80, y: y0 + 80, text: hi ? "khaye = 2 tukde of 4" : "eaten = 2 slices of 4", color: "blue" }),
        op({ op: "arrow", id: "a1", x: 420, y: y0 + 95, x2: 690, y2: y0 + 110, text: "2/4", color: "blue" }),
      ],
    },
    { say: s[3], lang, draw: [op({ op: "text", id: "t4", x: 80, y: y0 + 150, text: "2/4 = ?", size: "lg", color: "orange" })] },
  ];
}
