import { streamText, type ModelMessage } from "ai";
import { textbookKey, type Grade, type SubjectId } from "@/lib/curriculum";
import {
  detectProvider,
  getDoubtModel,
  getLessonFallbacks,
  getLessonModel,
  getModel,
  isOverloadedError,
} from "@/lib/llm";
import { mockLesson } from "@/lib/mock-lesson";
import {
  buildDoubtSystemPrompt,
  buildExplainSystemPrompt,
  buildPlanPrompt,
  buildSystemPrompt,
  buildTeachSystemPrompt,
  buildUserTurn,
} from "@/lib/prompt";
import { retrieveTextbookContext, type Passage } from "@/lib/rag";
import {
  BeatSchema,
  LessonPlanSchema,
  TutorRequestSchema,
  type HistoryMessage,
  type LessonPlan,
  type TutorEvent,
} from "@/lib/schema";

export const maxDuration = 60;

/**
 * POST /api/tutor
 * Body: TutorRequest. Streams NDJSON TutorEvents: one `beat` per line as soon
 * as the model finishes it, so the browser can start speaking/drawing beat 1
 * while beats 2..n are still being generated.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = TutorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Bad request", issues: parsed.error.issues }, { status: 400 });
  }
  const { messages, canvas, language, profile, mode, step, familiarity } = parsed.data;
  const grade = (parsed.data.grade ?? null) as Grade | null;
  const subject = (parsed.data.subject ?? null) as SubjectId | null;
  const plan: LessonPlan | null = parsed.data.plan ?? null;

  // Mock only covers the legacy single-turn flow; the staged flow needs real models.
  if (detectProvider() === "mock" && mode === "ask") return mockResponse(messages, language);

  // Pick the model for this stage: Ultra plans, teaches and works named textbook
  // items (explain); Groq answers conceptual doubts; the configured default handles
  // the legacy "ask" flow.
  let model: ReturnType<typeof getModel>;
  try {
    model =
      mode === "doubt"
        ? getDoubtModel()
        : mode === "plan" || mode === "teach" || mode === "explain"
          ? getLessonModel()
          : getModel();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  // The chosen class + subject name one NCERT textbook; passages from it ground the
  // turn (rag/ builds the index, lib/rag searches it with Nemotron embeddings + BM25).
  // No book chosen, no index for it, or retrieval failing all mean the turn simply
  // runs without passages — grounding is additive, never a hard dependency.
  const book = textbookKey(grade, subject);
  let edition = "";
  let passages: Passage[] = [];
  if (book) {
    try {
      ({ edition, passages } = await retrieveTextbookContext(book, messages));
    } catch (err) {
      console.warn(`[tutor] textbook retrieval failed for ${book}: ${errorMessage(err)}`);
    }
  }

  // System prompt per stage. Teaching and doubt reuse the shared board-rules prompt
  // (plus their framing); planning uses its own designer prompt.
  const promptCtx = { language, profile, grade, subject, textbook: passages };
  const system =
    mode === "plan"
      ? buildPlanPrompt({ ...promptCtx, familiarity: familiarity ?? null })
      : mode === "teach"
        ? buildTeachSystemPrompt({ ...promptCtx, plan: plan ?? LessonPlanSchema.parse({}), step: step ?? 0 })
        : mode === "doubt"
          ? buildDoubtSystemPrompt({ ...promptCtx, plan })
          : mode === "explain"
            ? buildExplainSystemPrompt({ ...promptCtx, plan })
            : buildSystemPrompt(promptCtx);

  const last = messages.length - 1;
  const modelMessages: ModelMessage[] = messages.map((m, i) => {
    if (m.role === "assistant") return { role: "assistant", content: m.text || "(drew on the board)" };
    return { role: "user", content: i === last ? buildUserTurn({ text: m.text, canvas }) : m.text };
  });

  // Plan/teach/explain: if NVIDIA is overloaded, try Groq / Google / default next.
  const modelChain =
    mode === "plan" || mode === "teach" || mode === "explain"
      ? [model, ...getLessonFallbacks(model.label)]
      : [model];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: TutorEvent) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      send({
        type: "meta",
        model: model.label,
        ...(passages.length > 0
          ? { sources: passages.map((p) => `${book} ${edition}: ${p.label} (pdf p.${p.pages.join("-")})`) }
          : {}),
      });
      try {
        if (mode === "plan") {
          await streamPlan({
            models: modelChain,
            system,
            messages: modelMessages,
            signal: req.signal,
            send,
            fallbackTopic: messages[last]?.text ?? "",
          });
        } else {
          await streamBeats({
            models: modelChain,
            system,
            messages: modelMessages,
            signal: req.signal,
            send,
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

type ModelPick = { model: Parameters<typeof streamText>[0]["model"]; label: string };

type StreamArgs = {
  models: ModelPick[];
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  send: (ev: TutorEvent) => void;
};

/**
 * Teach/doubt/ask: the model emits beats as NDJSON. We extract each complete
 * top-level JSON object from the text stream (tolerant of arrays, commas, code
 * fences and pretty-printing) and validate it ourselves — no provider-side
 * structured output, which has been unreliable across Gemini/Groq/NVIDIA.
 * Retries once on empty output; on overload, walks the model fallback chain.
 */
async function streamBeats({ models, system, messages, signal, send }: StreamArgs) {
  let lastErr: string | null = null;
  for (let mi = 0; mi < models.length; mi++) {
    const { model, label } = models[mi];
    for (let attempt = 0; attempt < 2; attempt++) {
      let errMsg: string | null = null;
      let beatCount = 0;
      let raw = "";
      try {
        const result = streamText({
          model,
          system,
          messages,
          temperature: 0.6,
          maxOutputTokens: 3000,
          maxRetries: 1,
          abortSignal: signal,
          onError: ({ error }) => {
            errMsg ??= errorMessage(error);
          },
        });
        const scanner = new BeatScanner((beat) => {
          beatCount++;
          send({ type: "beat", beat });
        });
        for await (const delta of result.textStream) {
          if (signal.aborted) break;
          raw += delta;
          scanner.push(delta);
        }
      } catch (err) {
        errMsg ??= errorMessage(err);
      }

      if (signal.aborted) return;
      if (beatCount > 0) {
        if (errMsg) send({ type: "error", message: errMsg });
        else send({ type: "done" });
        return;
      }
      lastErr = errMsg;
      if (attempt === 0 && !isOverloadedError(errMsg)) {
        console.warn(
          `[tutor] no valid beats on ${label} (${errMsg ?? "no provider error"}), retrying once. raw:\n` +
            raw.slice(0, 3000),
        );
        continue;
      }
      break; // try next model (especially on overload)
    }
    if (mi + 1 < models.length && isOverloadedError(lastErr)) {
      console.warn(`[tutor] ${label} overloaded; falling back to ${models[mi + 1].label}`);
      send({ type: "meta", model: models[mi + 1].label });
    } else if (mi + 1 < models.length && lastErr) {
      console.warn(`[tutor] ${label} failed (${lastErr}); trying ${models[mi + 1].label}`);
      send({ type: "meta", model: models[mi + 1].label });
    }
  }
  send({ type: "error", message: lastErr ?? "The tutor did not produce a valid response. Please try again." });
}

/**
 * Plan mode: collect the planner's full output, pull the lesson-plan JSON object
 * out of it (reasoning models may wrap JSON in prose), validate it and emit one
 * `plan` event. Retries once; on overload walks the fallback model chain.
 */
async function streamPlan({
  models,
  system,
  messages,
  signal,
  send,
  fallbackTopic,
}: StreamArgs & { fallbackTopic: string }) {
  let lastErr: string | null = null;
  for (let mi = 0; mi < models.length; mi++) {
    const { model, label } = models[mi];
    for (let attempt = 0; attempt < 2; attempt++) {
      let errMsg: string | null = null;
      let raw = "";
      try {
        const result = streamText({
          model,
          system,
          messages,
          temperature: 0.4,
          maxOutputTokens: 4000,
          maxRetries: 1,
          abortSignal: signal,
          onError: ({ error }) => {
            errMsg ??= errorMessage(error);
          },
        });
        for await (const delta of result.textStream) {
          if (signal.aborted) return;
          raw += delta;
        }
      } catch (err) {
        errMsg ??= errorMessage(err);
      }
      if (signal.aborted) return;

      const plan = extractPlan(raw);
      if (plan && plan.steps.length > 0) {
        if (!plan.topic) plan.topic = fallbackTopic.slice(0, 120);
        send({ type: "plan", plan });
        send({ type: "done" });
        return;
      }
      lastErr = errMsg;
      if (attempt === 0 && !isOverloadedError(errMsg)) {
        console.warn(`[tutor] no valid plan on ${label} (${errMsg ?? "no provider error"}), retrying once. raw:\n` + raw.slice(0, 2000));
        continue;
      }
      break;
    }
    if (mi + 1 < models.length) {
      console.warn(
        `[tutor] plan via ${label} failed (${lastErr ?? "empty"}); trying ${models[mi + 1].label}`,
      );
      send({ type: "meta", model: models[mi + 1].label });
    }
  }
  send({ type: "error", message: lastErr ?? "Could not design the lesson. Please try again." });
}

/**
 * Find the lesson-plan JSON in the planner's raw output. Scans for every complete
 * top-level {...} object (brace depth, ignoring braces inside strings) and returns
 * the last one that validates — robust to reasoning text and fences around it.
 */
function extractPlan(raw: string): LessonPlan | null {
  let best: LessonPlan | null = null;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = LessonPlanSchema.safeParse(JSON.parse(raw.slice(start, i + 1)));
          if (parsed.success && parsed.data.steps.length > 0) best = parsed.data;
        } catch {
          /* not JSON; skip */
        }
        start = -1;
      }
    }
  }
  return best;
}

/** LLM_PROVIDER=mock: stream a canned lesson with realistic pacing, no API key needed. */
function mockResponse(messages: HistoryMessage[], language: string): Response {
  const turn = messages.filter((m) => m.role === "user").length;
  const question = messages[messages.length - 1]?.text ?? "";
  const beats = mockLesson(question, language, turn);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: TutorEvent) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      send({ type: "meta", model: "mock/canned-lesson" });
      for (const beat of beats) {
        await new Promise((r) => setTimeout(r, 350));
        send({ type: "beat", beat });
      }
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}

/**
 * Pulls complete top-level JSON objects out of a growing text stream and emits
 * the ones that validate as beats. Tracks brace depth while ignoring braces
 * inside strings, so it works whether the model streams NDJSON, a JSON array,
 * pretty-printed objects or fenced code — anything brace-delimited.
 */
class BeatScanner {
  private buf = "";
  private depth = 0;
  private start = -1;
  private inStr = false;
  private esc = false;

  constructor(private onBeat: (beat: ReturnType<typeof BeatSchema.parse>) => void) {}

  push(chunk: string) {
    const base = this.buf.length;
    this.buf += chunk;
    for (let i = base; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === "\\") this.esc = true;
        else if (c === '"') this.inStr = false;
        continue;
      }
      if (c === '"') this.inStr = true;
      else if (c === "{") {
        if (this.depth === 0) this.start = i;
        this.depth++;
      } else if (c === "}") {
        this.depth--;
        if (this.depth === 0 && this.start >= 0) {
          this.flush(this.buf.slice(this.start, i + 1));
          this.start = -1;
        }
      }
    }
    // Drop fully-consumed text so the buffer does not grow unbounded.
    if (this.depth === 0) {
      this.buf = "";
    } else if (this.start > 0) {
      this.buf = this.buf.slice(this.start);
      this.start = 0;
    }
  }

  private flush(objText: string) {
    let value: unknown;
    try {
      value = JSON.parse(objText);
    } catch {
      return; // incomplete/garbled object; skip it
    }
    const parsed = BeatSchema.safeParse(value);
    if (parsed.success) this.onBeat(parsed.data);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
