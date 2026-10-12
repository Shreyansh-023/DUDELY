import { streamText, type ModelMessage } from "ai";
import type { Grade, SubjectId } from "@/lib/curriculum";
import { detectProvider, getModel } from "@/lib/llm";
import { mockLesson } from "@/lib/mock-lesson";
import { buildSystemPrompt, buildUserTurn } from "@/lib/prompt";
import { BeatSchema, TutorRequestSchema, type HistoryMessage, type TutorEvent } from "@/lib/schema";

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
  const { messages, canvas, language, profile } = parsed.data;
  const grade = (parsed.data.grade ?? null) as Grade | null;
  const subject = (parsed.data.subject ?? null) as SubjectId | null;

  // The chosen class + subject name one NCERT textbook. The RAG backend (built
  // separately) uses this to restrict vector search to that book's embeddings.
  // When that service is ready, derive the key with textbookKey(grade, subject),
  // retrieve the top passages for the latest question, and pass them into
  // buildSystemPrompt as a `context` argument.
  // TODO(rag): const book = textbookKey(grade, subject);
  //            const passages = book ? await retrieveTextbookContext(book, messages.at(-1)?.text) : [];

  if (detectProvider() === "mock") return mockResponse(messages, language);

  let model: ReturnType<typeof getModel>;
  try {
    model = getModel();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  const system = buildSystemPrompt({ language, profile, grade, subject });
  const last = messages.length - 1;
  const modelMessages: ModelMessage[] = messages.map((m, i) => {
    if (m.role === "assistant") return { role: "assistant", content: m.text || "(drew on the board)" };
    return { role: "user", content: i === last ? buildUserTurn({ text: m.text, canvas }) : m.text };
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: TutorEvent) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      send({ type: "meta", model: model.label });
      try {
        // Models occasionally emit an empty or malformed beat stream. As long as
        // nothing has been sent to the client yet (zero beats), one silent retry
        // is safe and fixes most of these turns.
        for (let attempt = 0; attempt < 2; attempt++) {
          let errMsg: string | null = null; // buffered so a dead first attempt can retry silently
          let beatCount = 0;
          let raw = "";
          try {
            const result = streamText({
              model: model.model,
              system,
              messages: modelMessages,
              temperature: 0.6,
              maxOutputTokens: 3000,
              abortSignal: req.signal,
              onError: ({ error }) => {
                errMsg ??= errorMessage(error);
              },
            });
            // The model emits beats as NDJSON. We extract each complete top-level JSON
            // object from the text stream (tolerant of arrays, commas, code fences and
            // pretty-printing) and validate it ourselves, so no provider-side structured
            // output is involved — that path has been unreliable across Gemini/Groq/NVIDIA.
            const scanner = new BeatScanner((beat) => {
              beatCount++;
              send({ type: "beat", beat });
            });
            for await (const delta of result.textStream) {
              if (req.signal.aborted) break;
              raw += delta;
              scanner.push(delta);
            }
          } catch (err) {
            errMsg ??= errorMessage(err);
          }

          if (req.signal.aborted) break;
          if (beatCount > 0) {
            // The client saw beats, so a retry would duplicate them; report honestly.
            if (errMsg) send({ type: "error", message: errMsg });
            else send({ type: "done" });
            break;
          }
          if (attempt === 0) {
            console.warn(
              `[tutor] no valid beats (${errMsg ?? "no provider error"}), retrying once. raw output follows:\n` +
                raw.slice(0, 3000),
            );
            continue;
          }
          send({
            type: "error",
            message: errMsg ?? "The tutor did not produce a valid response. Please try again.",
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
