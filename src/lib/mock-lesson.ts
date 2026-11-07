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
 *
 * Written the way the model is asked to write: notes carry no coordinates (the
 * board flows them), the pizza is a free-form SKETCH whose coordinates are
 * relative to each other only, and the highlight in the next beat uses the same
 * sketch coordinates — the turn's sketch frame puts it over the pizza.
 */
export function mockLesson(question: string, language: string, turn: number): Beat[] {
  const hi = language.startsWith("hi");
  const q = question.length > 38 ? question.slice(0, 35) + "…" : question;

  if (turn > 1) {
    return hi
      ? [
          { say: "Bahut badhiya, sahi pakde ho.", lang: "hi-IN", draw: [op({ op: "text", id: `ok${turn}`, text: "✓ Sahi!", size: "lg", color: "green" })] },
          { say: "Ab batao, agar 4 ki jagah 8 tukde hote, to aadha kitne tukde hota?", lang: "hi-IN", draw: [op({ op: "text", id: `q${turn}`, text: "8 tukde → aadha = ? tukde", color: "orange" })] },
        ]
      : [
          { say: "Nice, that is exactly right.", lang: "en-IN", draw: [op({ op: "text", id: `ok${turn}`, text: "✓ Correct!", size: "lg", color: "green" })] },
          { say: "Now, if the pizza had 8 slices instead of 4, how many slices make a half?", lang: "en-IN", draw: [op({ op: "text", id: `q${turn}`, text: "8 slices → half = ? slices", color: "orange" })] },
        ];
  }

  const s = hi
    ? ["Achha, chalo isko pizza se samajhte hain.", "Yeh ek pizza hai jisko maine 4 barabar tukdon mein kaata.", "Tumne 2 tukde kha liye, matlab 2 by 4.", "Ab dekho, yeh highlighted hissa pure pizza ka kitna hai? Aadha, ya kam?"]
    : ["Okay, let us see this with a pizza.", "Here is a pizza that I cut into 4 equal slices.", "You ate 2 slices, so that is 2 by 4.", "Now look at the highlighted part. Is it half the pizza, or less?"];
  const lang = hi ? "hi-IN" : "en-IN";

  return [
    { say: s[0], lang, draw: [op({ op: "text", id: "t1", text: q, size: "lg", color: "purple" })] },
    {
      say: s[1],
      lang,
      draw: [
        op({ op: "ellipse", id: "p1", x: 0, y: 0, w: 220, h: 220, color: "orange" }),
        op({ op: "line", id: "l1", x: 110, y: 0, x2: 110, y2: 220 }),
        op({ op: "line", id: "l2", x: 0, y: 110, x2: 220, y2: 110 }),
        op({ op: "text", id: "t2", x: 0, y: 240, text: "4 equal slices", size: "sm", color: "gray" }),
      ],
    },
    {
      say: s[2],
      lang,
      draw: [
        op({ op: "highlight", id: "h1", x: 0, y: 0, w: 110, h: 220 }),
        op({ op: "text", id: "t3", text: hi ? "khaye = 2 tukde of 4" : "eaten = 2 slices of 4", color: "blue" }),
        op({ op: "arrow", id: "a1", to: "h1", text: "2/4", color: "blue" }),
      ],
    },
    { say: s[3], lang, draw: [op({ op: "text", id: "t4", text: "2/4 = ?", size: "lg", color: "orange" })] },
  ];
}
