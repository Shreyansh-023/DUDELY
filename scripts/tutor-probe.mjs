/**
 * Probe /api/tutor with a few Class 10 Maths questions and check the model's beats:
 * time to first beat, valid beats, board drawing, first-beat length and language.
 * Compares models on the beat format without opening a browser.
 *
 *   node scripts/tutor-probe.mjs http://localhost:3000            # uses the server's LLM_PROVIDER
 *   node scripts/tutor-probe.mjs http://localhost:3000 out.json   # also save every beat
 */
import fs from "node:fs";

const base = process.argv[2] || "http://localhost:3000";
const out = process.argv[3];

// language = the session language picked in the UI (en = English only, en-IN = English + Hindi).
// expect   = the reply language the tutor should use, given that session and how the student wrote.
const CASES = [
  { language: "en", text: "How do I find the roots of 2x^2 - 7x + 3 = 0?", expect: "english" },
  { language: "en-IN", text: "Why is sin²A + cos²A = 1?", expect: "english" },
  { language: "en-IN", text: "Discriminant kya hota hai? Samjhao na", expect: "hinglish" },
  { language: "hi-IN", text: "समांतर श्रेढ़ी का n वाँ पद कैसे निकालते हैं?", expect: "devanagari" },
  { language: "hi-IN", text: "द्विघात समीकरण के मूल कैसे ज्ञात करते हैं?", expect: "devanagari" },
  { language: "hi-IN", text: "Probability ka formula kya hai?", expect: "hinglish" },
];

const DEVANAGARI = /[ऀ-ॿ]/g;
const LETTERS = /[A-Za-zऀ-ॿ]/g;
const HINDI_IN_LATIN = new Set(
  "kya hai hain hota hoti hote kaise ka ki ke ko se mein aur nahi yeh ye matlab hum chalo dekho achha accha batao samjho isko iska".split(" "),
);
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const devShare = (s) => (s.match(DEVANAGARI)?.length ?? 0) / Math.max(s.match(LETTERS)?.length ?? 0, 1);
const hindiLatinWords = (s) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => HINDI_IN_LATIN.has(w))).size;

function languageOk(expect, said) {
  const dev = devShare(said);
  if (expect === "devanagari") return dev >= 0.5;
  if (expect === "hinglish") return dev < 0.3 && hindiLatinWords(said) >= 2;
  return dev < 0.05 && hindiLatinWords(said) < 2; // english
}

async function ask(c) {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/tutor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", text: c.text }],
      canvas: "",
      language: c.language,
      grade: 10,
      subject: "maths",
      profile: "",
    }),
  });
  if (!res.ok) return { ...c, error: `HTTP ${res.status}: ${await res.text()}` };

  const beats = [];
  let model = "?", sources = [], error = null, firstBeatMs = null, buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "meta") {
        model = ev.model;
        sources = ev.sources ?? [];
      }
      if (ev.type === "beat") {
        firstBeatMs ??= performance.now() - t0;
        beats.push(ev.beat);
      }
      if (ev.type === "error") error = ev.message;
    }
  }
  const ops = beats.flatMap((b) => b.draw ?? []);
  const said = beats.map((b) => b.say).join(" ");
  return {
    ...c,
    model,
    sources,
    error,
    beats: beats.length,
    beatsWithDrawing: beats.filter((b) => (b.draw ?? []).length > 0).length,
    ops: ops.length,
    textOnBoard: ops.filter((o) => o.op === "text").map((o) => o.text).slice(0, 6),
    firstBeatWords: beats[0] ? words(beats[0].say) : null,
    devanagariShare: Number(devShare(said).toFixed(2)),
    languageOk: beats.length > 0 && languageOk(c.expect, said),
    firstBeatSec: firstBeatMs && Number((firstBeatMs / 1000).toFixed(1)),
    totalSec: Number(((performance.now() - t0) / 1000).toFixed(1)),
    raw: beats,
  };
}

const results = [];
for (const c of CASES) {
  const r = await ask(c);
  results.push(r);
  if (r.error && !r.beats) {
    console.log(`\n[${c.language}] ${c.text}\n  ERROR ${r.error}`);
    continue;
  }
  console.log(
    `\n[${c.language}] ${c.text}\n  model ${r.model} | ${r.beats} beats (${r.beatsWithDrawing} with drawing, ${r.ops} ops)` +
      ` | first beat ${r.firstBeatSec}s, total ${r.totalSec}s` +
      ` | first beat ${r.firstBeatWords} words${r.firstBeatWords < 10 ? "" : " (rule: <10)"}` +
      ` | expected ${c.expect}: ${r.languageOk ? "ok" : "WRONG LANGUAGE"}` +
      `${r.error ? ` | ERROR ${r.error}` : ""}\n  board: ${JSON.stringify(r.textOnBoard)}` +
      (r.sources.length ? `\n  textbook: ${r.sources.join("\n            ")}` : "\n  textbook: (no passages)"),
  );
  for (const b of r.raw) console.log(`    say: ${b.say}`);
}

const ok = results.filter((r) => r.beats > 0);
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(
  `\nSUMMARY ${ok[0]?.model ?? "?"}: valid replies ${ok.length}/${results.length}` +
    ` | right language ${results.filter((r) => r.languageOk).length}/${results.length}` +
    ` | first beat <10 words ${ok.filter((r) => r.firstBeatWords < 10).length}/${results.length}` +
    ` | drew on board ${ok.filter((r) => r.ops > 0).length}/${results.length}` +
    ` | median time to first beat ${median(ok.map((r) => r.firstBeatSec))}s`,
);
if (out) {
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nsaved -> ${out}`);
}
