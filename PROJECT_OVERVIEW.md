# Project overview — Guru (Bharat tutor)

A guided tour of what this repo is, how the pieces fit together, and where to look when you start contributing. For install steps, see [`SETUP.md`](SETUP.md). For a shorter technical summary, see [`README.md`](README.md).

---

## What is this?

**Guru** is an AI whiteboard tutor built for students in India (“Bharat”). You talk or type in Hindi, Hinglish, Tamil, Bengali, English, and more. Guru **explains out loud while drawing on a live whiteboard**, one small step at a time, then checks understanding before moving on. You can draw your own attempt; Guru can see it and respond.

It is inspired by products like Dudely: live board + voice + “don’t move on until you get it.”

**Product name in UI / docs:** Guru · **npm package name:** `bharat-tutor`

---

## What a session feels like

1. You pick a **language**, optional **class + subject** (e.g. Class 10 Maths), and maybe a short student profile (“weak in algebra”).
2. You ask a question by typing or holding the mic (**Space**).
3. Guru streams a sequence of **beats**: each beat is a short spoken line plus drawing ops on the Excalidraw board.
4. Speech and drawing stay aligned because they share the same beat — no clock syncing.
5. You can interrupt (**Esc** / Stop), answer check questions, or draw on the board yourself.
6. If a textbook index is available for your class/subject, answers can be grounded in NCERT content.

---

## Tech stack at a glance

| Layer | Choice |
| --- | --- |
| App framework | **Next.js 16** (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4 (via Turbopack) |
| Whiteboard | **Excalidraw** 0.18 |
| LLM orchestration | **Vercel AI SDK 7** (`streamText`, streamed NDJSON beats) |
| Default / lesson models | NVIDIA (e.g. Nemotron) via OpenAI-compatible API |
| Fast “doubt” answers | Groq (when configured) |
| Other LLMs | Google Gemini, OpenAI, Anthropic (env-switched) |
| Indic speech | **Sarvam** Saaras v4 (STT) + Bulbul (TTS); browser Web Speech as fallback |
| Textbook RAG | Offline Python build (`rag/`) + runtime search in `src/lib/rag.ts` (Nemotron embeddings + BM25) |
| 3D avatar (lipsync) | Three.js / React Three Fiber |

---

## Core idea: “beats”

A tutor turn is not a single blob of text. The model emits an ordered list of **beats**:

```text
beat = { say: "…", lang: "hi-IN", draw: [ops…] }
```

- The server streams each beat as soon as it is complete (NDJSON over `POST /api/tutor`).
- The client queues beats: for beat N it **plays TTS** and **animates draw ops** together.
- Beat 1 is kept short so time-to-first-audio stays low; later TTS is prefetched while earlier beats play.

This is why the product feels like a real tutor drawing while talking, not a chatbot with a static diagram.

---

## Architecture (request path)

```text
  Mic ──► STT ──► text ──┐
  Keyboard ─────────────┤
                        ▼
              POST /api/tutor
              (history + canvas summary + optional student drawing image
               + grade/subject → optional RAG passages)
                        │
                        ▼  LLM streams beats (or plan / teach / doubt stages)
                        │
         ┌──────────────┴──────────────┐
         │ TTS for beat N (prefetch)   │  Excalidraw animates draw ops
         │ Sarvam or speechSynthesis   │  (typing, arrows, highlights, …)
         └──────────────┬──────────────┘
                        ▼
              next beat → until turn done / barge-in
```

**Student drawings:** Guru’s elements are tagged (`customData.tutor`). Everything else is treated as the student’s. Each ask can send a compact board summary plus a JPEG of the region the student changed, so the model can point at “the triangle on the right.”

---

## Tutor modes (lesson flow)

The API supports more than a single “answer me” turn (`mode` on the request):

| Mode | Role |
| --- | --- |
| `ask` | Legacy single-turn explain (also used by `LLM_PROVIDER=mock`) |
| `plan` | Design the lesson, **thinking on** — runs once, streams a `planstep` per step as it is written, then the whole `plan` |
| `teach` | Teach one step of the plan on the board, **thinking off** — has to come back in seconds |
| `explain` | Work a named textbook item with grounding |
| `doubt` | Fast answer to an interruption / conceptual doubt (prefer Groq) |

### How a lesson is paced

A lesson is one long turn, pipelined so the student never hears silence
(`runLesson` in [`src/components/Tutor.tsx`](src/components/Tutor.tsx)):

1. The student answers the familiarity question. Indica immediately speaks local
   filler lines (`PLANNING_LINES`) while the planner thinks, and the board shows
   the plan filling in step by step.
2. The plan arrives. Indica speaks its roadmap — one line per step, written by the
   planner — and writes the step titles up as a contents page. No model call:
   those beats are built from the plan on the client.
3. Step 1 is requested the moment the roadmap starts speaking, so the roadmap is
   what hides its latency. From then on step *i+1* is generated while step *i* is
   still being spoken, one step ahead and no further (`LOOKAHEAD_STEPS`).

Two things make the overlap safe. Every step gets a **fresh page of its own**
(`beginTeachTurn({ newPage: true })`), so a step can be asked for without knowing
what the previous one drew. And beats wait in a queue with their speech already
fetched, so what has been generated and what has been *said* are deliberately
different places in the lesson — the request history follows the former, the
transcript and the board follow the latter.

Everything Indica says is paced by `TTS_PACE` (default 0.9): slow enough for a
student to follow a new idea on a board, which is also what gives generation its
head start.

Pedagogy lives mainly in [`src/lib/prompt.ts`](src/lib/prompt.ts): diagnose → draw → ask; mirror the student’s language; use Indian contexts; avoid dumping the full answer at once.

---

## Curriculum & RAG

- UI curriculum: classes **1–12**, subjects **Maths** and **Science** ([`src/lib/curriculum.ts`](src/lib/curriculum.ts)).
- Selecting both names one book key, e.g. `ncert-class-10-maths`.
- Offline: PDFs → chunks, vectors, structure ([`rag/build_index.py`](rag/build_index.py)). Details: [`rag/README.md`](rag/README.md).
- Online: [`src/lib/rag.ts`](src/lib/rag.ts) retrieves by:
  - **Deterministic** lookup (“example 2 of chapter 1”, page numbers, …)
  - **Semantic** search (embeddings + BM25)
  - **Topic openers** (chapter outline + introduction)

Grounding is **optional**. Missing index or failed retrieval → the turn still runs ungrounded.

---

## Project layout (where to look)

```text
DUDELY/
├── SETUP.md                 ← how to install & run
├── PROJECT_OVERVIEW.md      ← this file
├── README.md                ← concise technical README
├── package.json             ← scripts & JS deps
├── next.config.ts           ← Next / Tailwind / Excalidraw CSS rules
├── scripts/smoke.cjs        ← headless smoke test
├── rag/                     ← offline textbook index build
│   ├── README.md
│   ├── build_index.py
│   ├── common.py
│   └── requirements.txt
└── src/
    ├── app/
    │   ├── page.tsx         ← mounts <Tutor />
    │   ├── layout.tsx
    │   └── api/
    │       ├── tutor/       ← stream beats / lesson stages
    │       ├── stt/         ← Sarvam or Groq Whisper
    │       ├── tts/         ← Sarvam Bulbul
    │       └── config/      ← which LLM/voice backends are live
    ├── components/
    │   ├── Tutor.tsx        ← orchestrator (turns, beats, barge-in)
    │   ├── Whiteboard.tsx   ← Excalidraw wrapper
    │   ├── Composer.tsx, Transcript.tsx, Avatar.tsx, …
    │   └── useVoiceLoop.ts
    └── lib/
        ├── schema.ts        ← beat / draw-op / request zod schemas
        ├── prompt.ts        ← system prompts + canvas block
        ├── llm.ts           ← provider factory
        ├── rag.ts           ← textbook retrieval
        ├── curriculum.ts
        ├── languages.ts
        ├── mock-lesson.ts   ← canned demo when LLM_PROVIDER=mock
        ├── canvas/          ← ops → elements, animation, board summary
        │   ├── ops.ts, player.ts, summary.ts
        │   └── primitives/  ← fraction, circuit, molecule, axes, …
        └── voice/           ← STT, TTS, VAD, playback, lipsync
```

### Draw-op vocabulary

The model emits flat ops (`text`, `rect`, `arrow`, `highlight`, `fraction`, `circuit`, … plus `erase` / `clear`). Flat shape = works across providers’ structured-output quirks. See [`src/lib/schema.ts`](src/lib/schema.ts) and the list in [`README.md`](README.md).

---

## Controls (end-user)

- **Mic** or hold **Space** — talk; release / click again to send
- **Enter** — send typed text
- **Esc** / **Stop** — barge-in (interrupt Guru)
- **Language** — STT/TTS + default reply language
- **Class + subject** — selects NCERT book for RAG
- **Student profile** — shapes explanation level
- **New topic** — wipe board + conversation

---

## Environment & providers (mental model)

| Concern | Env / behavior |
| --- | --- |
| Which LLM? | Keys auto-detect, or force `LLM_PROVIDER` / `LLM_MODEL` |
| Lesson vs doubt | `LESSON_MODEL` (NVIDIA) vs `DOUBT_MODEL` (Groq) when keys exist |
| Voice | `SARVAM_API_KEY` → Sarvam; else browser (STT may use Groq Whisper if only Groq is set) |
| Demo without keys | `LLM_PROVIDER=mock` |
| RAG embeddings | `NVIDIA_API_KEY` (build + query) |

Exact setup steps and a full variable list: [`SETUP.md`](SETUP.md).

---

## Design principles to keep in mind

1. **Beats over timestamps** — sync speech and drawing by meaning chunks.
2. **Mastery, not lecture** — diagnose, draw, ask; don’t dump the answer.
3. **Language mirroring** — Hinglish in → Hinglish out; respect script.
4. **Grounding is additive** — RAG helps when present; never blocks the tutor.
5. **Provider-portable ops** — flat draw schema; validate on the server.
6. **Latency budget** — short first beat; prefetch TTS for the rest.

---

## Roadmap (direction of travel)

From the research notes in the README:

1. Full-duplex voice (e.g. Gemini Live / Realtime WebSocket), still using beats as the payload
2. Hands-free turn-taking with VAD + realtime STT
3. True handwriting animation (`freedraw` along glyph paths)
4. Broader curriculum grounding (more books / better Science extraction)
5. Sessions & memory across days
6. Cost control (lighter models for diagnosis, larger for teaching)

---

## How to orient as a new contributor

| If you want to… | Start here |
| --- | --- |
| Change how Guru teaches | `src/lib/prompt.ts` |
| Change beat / draw schema | `src/lib/schema.ts` → then canvas player |
| Fix board animation | `src/lib/canvas/player.ts`, `ops.ts`, `primitives/` |
| Change turn UI / mic / barge-in | `src/components/Tutor.tsx`, `useVoiceLoop.ts` |
| Swap or tune models | `src/lib/llm.ts` + env vars |
| Improve textbook grounding | `src/lib/rag.ts` + `rag/build_index.py` |
| Add a language voice mapping | `src/lib/languages.ts` + `/api/tts` |
| Demo without APIs | `LLM_PROVIDER=mock` + `src/lib/mock-lesson.ts` |

---

## Related docs

| File | Audience |
| --- | --- |
| [`SETUP.md`](SETUP.md) | Anyone setting up the machine |
| [`README.md`](README.md) | Developers who want the short technical picture |
| [`rag/README.md`](rag/README.md) | Anyone ingesting a new NCERT book |
| [`AGENTS.md`](AGENTS.md) | AI coding agents (Next.js version caveats) |
