# Guru — AI whiteboard tutor for Bharat

A Dudely-style tutor: you talk (or type) in Hindi, Hinglish, Tamil, Bengali, English…, and Guru
**explains out loud while drawing on a live whiteboard**, one small step at a time, then asks you a
question before moving on. Draw your own attempt on the board and Guru looks at it.

```
Next.js 16 (App Router) · Excalidraw canvas · Vercel AI SDK 7 (Gemini / Groq / OpenAI / Claude)
Sarvam AI for Indic speech (Saaras v4 STT, Bulbul v4 Flash TTS) with free browser fallbacks
```

## Run it

```bash
npm install
cp .env.example .env.local     # add GOOGLE_GENERATIVE_AI_API_KEY (and SARVAM_API_KEY for Indic voice)
npm run dev                    # http://localhost:3000
```

`npm run dev` starts two processes: Next, and the live-transcription relay on port 8787
(see below). `npm run dev:next` / `npm run dev:relay` run them separately.

Without any Sarvam key the app still works end-to-end using the browser's Web Speech API
(Chrome recommended). Without any LLM key the UI loads but asks you for a key.

**No keys at all?** `LLM_PROVIDER=mock npm run dev` serves a canned pizza-fractions lesson so you
can see the whiteboard animation and voice sync working. `/?q=your+question` auto-asks on load.

**Smoke test** (headless Chrome over DevTools Protocol, needs a running server):

```bash
node scripts/smoke.cjs http://localhost:3000 "why is 2/4 equal to 1/2?" .tmp/smoke.png
```

It prints console errors, the transcript, the Excalidraw scene elements and saves a screenshot.

## How it works

```
 mic ──► STT ──► text ──┐
                        ▼
            POST /api/tutor  (history + CANVAS summary + image of what you drew)
                        │
                        ▼  LLM streams an ARRAY OF "BEATS" (structured output)
            beat = { say: "…", lang: "hi-IN", draw: [ops…] }
                        │  (each beat is pushed to the browser the moment it is complete)
                        ▼
    ┌───────────────────┴──────────────────┐
    │ TTS for beat N (prefetched on arrival) │ Excalidraw animates beat N's ops
    │ plays …                               │ (text types out, arrows grow, shapes fade in)
    └───────────────────┬──────────────────┘
                        ▼  both done → next beat
```

**Why beats instead of timestamps.** Speech and drawing stay in sync because they are chunked
by *meaning*: the sentence "this is the force vector" and the arrow it refers to are in the same
beat and start together. No clock alignment needed, and it survives TTS latency jitter.

**Latency budget.** Beat 1 is forced to be under 10 words, so time-to-first-audio is
`LLM time-to-first-element + one short TTS call`. Later beats' TTS is fetched while earlier beats
play, so there are no gaps.

**The "Dudely feel"** is in [src/lib/prompt.ts](src/lib/prompt.ts): a mastery prompt that forbids
direct answers and enforces DIAGNOSE → DRAW → ASK every turn, mirrors the student's language and
script (Hinglish in, Hinglish out), and uses Indian contexts.

**Student drawings.** Everything Guru draws is tagged `customData.tutor`; everything else is the
student's. On each ask, the client builds a compact text list of the board (ids, positions, text)
plus a JPEG of the region the student just changed, and sends both. The model can then say
"the triangle you drew on the right…" and annotate it with highlights/arrows.

## Live transcription (words appear as you speak)

Batch STT can only show you the sentence *after* you stop talking — you record, you upload,
you wait. ChatGPT and friends instead hold a socket open, push raw PCM up every ~100ms and
paint the recogniser's partial hypotheses as they arrive, revising them in place. Indica does
the same:

```
 mic ─► AudioWorklet (resample → 16kHz mono PCM16, 100ms chunks)
          │
          ▼  WebSocket (binary frames)
     scripts/stt-relay.mjs  ──►  wss://api.sarvam.ai/speech-to-text-realtime/ws
          │                 ◄──  transcript.partial / transcript.final
          ▼
   composer textarea (chat) · caption strip (voice mode)
```

The relay is a separate process for two reasons: a Next.js route handler can't hold a
WebSocket open (the connection dies with the response), and `SARVAM_API_KEY` must never
reach the browser. `npm run dev` starts it for you; in production run `npm run dev:relay`
alongside the server, or point `STT_RELAY_URL` at wherever you deploy it.

**It is strictly additive.** The mic keeps recording to a blob the whole time, so if the
relay is down, Web Audio is unavailable, or the socket is refused, the turn falls back to the
old `POST /api/stt` path and nobody notices except that the words show up later. When the
stream *does* produce a transcript it's used directly and the upload is skipped, so there's
no double billing. The browser Web Speech fallback already streamed interim results; those
now land in the composer too.

Three mic behaviours, deliberately different:

| Gesture | While speaking | On stop |
| --- | --- | --- |
| Mic button (chat) | text streams into the composer, read-only | stays in the box, editable — you press send |
| Hold `Space` (chat) | same | sends immediately on release |
| Voice mode | the box on the stage fills line by line | same box unlocks: edit, **retry** (↻) or **send** (↑ / Enter) |

Voice mode never sends straight through. One box owns the lower third from the first syllable to
the moment it is asked: it opens empty ("Listening…"), fills with the recogniser's partials while
read-only, holds the last of them through the upload, then unlocks — focused, caret at the end —
with retry and send beside it. It is centred on the stage and grows sideways to ~48rem before
wrapping downwards, so a one-word answer and a three-line question both look deliberate.

Keeping it one element is the point: no pop-in, no layout jump at the handover. Recognition is
not perfect, least of all on code-mixed Hinglish, and a misheard word would otherwise become the
question Indica answers. Retry bins the transcript and reopens the mic; nothing reaches the model
until send.

## Project layout

| Path | What |
| --- | --- |
| `src/lib/schema.ts` | Beat / draw-op schema (zod) shared by server and client |
| `src/lib/prompt.ts` | Mastery system prompt + CANVAS block builder |
| `src/lib/llm.ts` | Provider factory (Gemini default; Groq, OpenAI, Anthropic via env) |
| `src/lib/canvas/ops.ts` | Draw ops → Excalidraw element skeletons |
| `src/lib/canvas/player.ts` | Animates ops onto the live scene (typing, growing arrows, fades) |
| `src/lib/canvas/summary.ts` | Board → text summary; student-region snapshot for vision |
| `src/lib/voice/stt.ts`, `tts.ts` | Mic recording / Web Speech fallback; audio playback / speechSynthesis fallback |
| `src/lib/voice/live-stt.ts` | Streaming STT client — mic → PCM → relay → partial transcripts |
| `public/pcm-worklet.js` | AudioWorklet: mic audio → 16 kHz mono linear16, 100ms chunks |
| `scripts/stt-relay.mjs` | WebSocket relay to Sarvam realtime STT (holds the key) |
| `src/app/api/tutor` | Streams NDJSON beats from the LLM (`Output.array` + `elementStream`) |
| `src/app/api/stt`, `tts` | Sarvam Saaras v4 / Groq Whisper; Sarvam Bulbul v4 Flash |
| `src/components/Tutor.tsx` | Orchestrator: turn lifecycle, beat queue, barge-in, push-to-talk |
| `src/components/Whiteboard.tsx` | Client-only Excalidraw wrapper |

## Draw-op vocabulary (what the model emits)

```jsonc
{"op":"text","id":"t1","x":80,"y":80,"text":"F = m × a","size":"lg","color":"purple"}
{"op":"rect","id":"b1","x":700,"y":100,"w":160,"h":80,"text":"Mass"}
{"op":"arrow","id":"a1","x":860,"y":140,"x2":1000,"y2":140,"text":"F","color":"red"}
{"op":"highlight","id":"h1","x":690,"y":90,"w":180,"h":100}
{"op":"erase","ids":["h1"]}
{"op":"clear"}
```

Flat on purpose: one object type with optional fields survives every provider's structured-output
implementation (Gemini response schema, OpenAI JSON schema, Groq JSON mode, Anthropic tools).

## Controls

- **Mic button** or **hold Space**: talk. Release / click again to send.
- **Enter**: send typed text. **Esc** or **Stop**: interrupt Guru mid-explanation (barge-in).
- **Language** selector: session language for STT/TTS and the default reply language.
- **Student profile**: "Class 10 CBSE, weak in algebra" — shapes the level of explanation.
- **New topic**: wipes the board and the conversation.

## Switching models

```bash
LLM_PROVIDER=groq  LLM_MODEL=llama-3.3-70b-versatile   # fastest tokens/sec
LLM_PROVIDER=google LLM_MODEL=gemini-3.8-flash          # smarter Flash
LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-5-5
```

## Roadmap (what the research says to do next)

1. **Full-duplex voice** — replace the STT→LLM→TTS pipeline with Gemini Live (`gemini-3.8-live`) or
   OpenAI Realtime over WebSocket; keep the beat format as the tool-call payload. Sub-second
   turn-taking and natural barge-in.
2. **Hands-free turn-taking** — add VAD (e.g. Silero via onnxruntime-web) so the mic auto-stops;
   Sarvam's `saaras:v3-realtime` WebSocket gives partial transcripts.
3. **Real handwriting** — animate `freedraw` strokes along glyph paths (Excalidraw exposes
   `getFreeDrawSvgPath`) instead of typing text, for a true "hand on the board" look.
4. **Curriculum grounding** — RAG over NCERT/state-board chapters so examples match the syllabus.
5. **Sessions & memory** — persist board + transcript per student; carry over diagnosed gaps.
6. **Cost control** — Flash-Lite for diagnosis turns, bigger model for teaching turns; cap beats.

## Research notes (Oct 2026)

- Dudely: live whiteboard + voice + "checks that you actually understand before it moves on";
  free tier 10 min/day ([f4.fund](https://f4.fund/startups/dudely)).
- Sarvam AI: STT `saaras:v4` (22 Indic languages + Indian/Global English, auto-detect via
  `language_code=unknown`), realtime `saaras:v3-realtime` over WebSocket; TTS `bulbul:v4-flash`
  (~1/3 the cost of v3, ₹1/1K chars) with 200+ voices and pace/pitch/loudness control. Personas are
  `name_language_style` ids (e.g. `ishita_hi_edtech`), `output_audio_codec` mp3/wav/flac/aac
  ([docs.sarvam.ai](https://docs.sarvam.ai)).
- Gemini: `gemini-3.8-flash` is the current stable Flash, `gemini-3.8-live` the Live API model,
  `gemini-3.5-flash` / `-lite` cheaper legacy ([ai.google.dev](https://ai.google.dev/gemini-api/docs/models)).
- Groq: `llama-3.3-70b-versatile`, `openai/gpt-oss-120b`; STT `whisper-large-v3-turbo`
  ([console.groq.com](https://console.groq.com/docs/models)).
- Vercel AI SDK 7: `streamText` + `Output.array({ element })` exposes `elementStream`, each
  element validated and emitted as soon as it is complete.
- Excalidraw 0.18: `convertToExcalidrawElements` (skeleton → elements), `updateScene` with
  `CaptureUpdateAction.NEVER`, `exportToBlob`, `getCommonBounds`, `getVisibleSceneBounds`.
- The MCP Excalidraw servers (`yctimlin/mcp_excalidraw`) expose `create_element {type,x,y,width,
  height,text,strokeColor,…}`; this project uses the same idea but as a streamed, animated,
  speech-aligned op list instead of discrete MCP tool calls.
