/**
 * Live tutor smoke tests — posts to /api/tutor and checks grounding + answer quality.
 *
 *   node scripts/eval_tutor.mjs [baseUrl]
 */
const BASE = process.argv[2] || "http://localhost:3001";

const CASES = [
  {
    id: "c10-ex2-ch1",
    grade: 10,
    subject: "maths",
    text: "Example 2 of chapter 1",
    mode: "explain",
    expectSources: [/chapter\s*1|real numbers|example\s*2/i],
    expectSay: [/HCF|LCM|prime|factor|6|20/i],
    expectNot: [/I don't have|no textbook|cannot find/i],
  },
  {
    id: "c10-quadratic",
    grade: 10,
    subject: "maths",
    text: "What is a quadratic equation? Give one simple example.",
    mode: "ask",
    expectSources: [/quadratic|chapter\s*4/i],
    expectSay: [/quadratic|degree|x\^?2|ax\^?2/i],
  },
  {
    id: "c6-primes",
    grade: 6,
    subject: "maths",
    text: "What is a prime number? Give two examples.",
    mode: "ask",
    expectSources: [/prime|chapter\s*5/i],
    expectSay: [/prime|divis|2|3|5|7|11/i],
  },
  {
    id: "c9-coords",
    grade: 9,
    subject: "maths",
    text: "Teach me how to plot a point on the cartesian plane.",
    mode: "ask",
    expectSources: [/coordinate|orienting|chapter\s*1/i],
    expectSay: [/axis|x|y|coordinate|origin|plane/i],
  },
  {
    id: "c5-fractions",
    grade: 5,
    subject: "maths",
    text: "Explain what a fraction is with a simple example.",
    mode: "ask",
    expectSources: [/fraction|chapter\s*2/i],
    expectSay: [/fraction|part|whole|half|numerator|denominator|\d+\/\d+/i],
  },
  {
    id: "c1-shapes",
    grade: 1,
    subject: "maths",
    text: "What things are round? What things are long?",
    mode: "ask",
    expectSources: [/long|round|chapter\s*2|shape/i],
    expectSay: [/round|long|ball|circle|stick|shape/i],
  },
];

async function postTutor(body) {
  const res = await fetch(`${BASE}/api/tutor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const text = await res.text();
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* ignore partial */
    }
  }
  return events;
}

function summarize(events) {
  const meta = events.find((e) => e.type === "meta") || {};
  const beats = events.filter((e) => e.type === "beat").map((e) => e.beat);
  const err = events.find((e) => e.type === "error");
  const say = beats.map((b) => b.say || "").join(" ");
  return {
    model: meta.model,
    sources: meta.sources || [],
    say,
    beatCount: beats.length,
    error: err?.message || null,
    plan: events.find((e) => e.type === "plan")?.plan || null,
  };
}

function check(caseDef, summary) {
  const fails = [];
  if (summary.error) fails.push(`API error: ${summary.error}`);
  if (summary.beatCount === 0 && !summary.plan) fails.push("no beats produced");
  const sourceBlob = (summary.sources || []).join(" | ");
  if (caseDef.expectSources?.length) {
    const ok = caseDef.expectSources.some((re) => re.test(sourceBlob));
    if (!ok && sourceBlob) fails.push(`sources miss expected topic: ${sourceBlob.slice(0, 120)}`);
    if (!sourceBlob) fails.push("no RAG sources in meta (ungrounded)");
  }
  if (caseDef.expectSay?.length && summary.say) {
    const ok = caseDef.expectSay.some((re) => re.test(summary.say));
    if (!ok) fails.push(`spoken text missing expected maths content: ${summary.say.slice(0, 160)}`);
  }
  if (caseDef.expectNot?.length && summary.say) {
    for (const re of caseDef.expectNot) {
      if (re.test(summary.say)) fails.push(`spoken text matched forbidden: ${re}`);
    }
  }
  return fails;
}

async function main() {
  console.log(`Tutor eval against ${BASE}\n`);
  try {
    const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json());
    console.log("config:", JSON.stringify(cfg));
  } catch (e) {
    console.error("config failed:", e.message);
    process.exit(1);
  }

  const rows = [];
  for (const c of CASES) {
    process.stdout.write(`… ${c.id} `);
    const body = {
      messages: [{ role: "user", text: c.text }],
      language: "en-IN",
      grade: c.grade,
      subject: c.subject,
      mode: c.mode,
      profile: `Class ${c.grade} CBSE student`,
    };
    let summary;
    try {
      const events = await postTutor(body);
      summary = summarize(events);
    } catch (e) {
      summary = { error: e.message, say: "", sources: [], beatCount: 0 };
    }
    const fails = check(c, summary);
    const ok = fails.length === 0;
    console.log(ok ? "PASS" : "FAIL");
    if (!ok) fails.forEach((f) => console.log("   -", f));
    console.log("   model:", summary.model);
    console.log("   sources:", (summary.sources || []).slice(0, 3).join(" ; ") || "(none)");
    console.log("   say:", (summary.say || "").slice(0, 220).replace(/\s+/g, " "));
    rows.push({ id: c.id, ok, fails, summary });
  }

  const pass = rows.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(64));
  console.log(`TUTOR LIVE CHECK: ${pass}/${rows.length} passed`);
  console.log("=".repeat(64));
  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
