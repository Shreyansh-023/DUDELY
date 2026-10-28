# Setup guide — Guru (Bharat tutor)

End-to-end steps to run the full project: Next.js app, LLM/voice APIs, optional NCERT RAG index, and a smoke test.

---

## 1. Prerequisites

| Tool | Version / notes |
| --- | --- |
| **Node.js** | 20+ recommended (Next.js 16) |
| **npm** | Comes with Node |
| **Git** | To clone the repo |
| **Chrome** | Best for Web Speech fallback (mic + TTS) if you skip Sarvam |
| **Python 3.10+** | Only needed if you want textbook RAG |

Optional API accounts (pick what you need):

- **NVIDIA** — recommended for lesson models + RAG embeddings ([integrate.api.nvidia.com](https://integrate.api.nvidia.com))
- **Google AI** — Gemini (`GOOGLE_GENERATIVE_AI_API_KEY`)
- **Groq** — fast doubt answers + Whisper STT fallback
- **Sarvam AI** — Indic STT/TTS (`SARVAM_API_KEY`)
- **OpenAI / Anthropic** — alternative LLM providers

---

## 2. Clone and install

```bash
git clone <your-repo-url> DUDELY
cd DUDELY
npm install
```

This installs Next.js 16, React 19, Excalidraw, Vercel AI SDK, and related deps from `package.json`.

---

## 3. Environment variables

Create a file at the repo root named `.env.local` (or `.env` — Next.js loads both; git ignores `.env*`).

### Minimum for a real tutor session

```bash
# At least ONE LLM key (NVIDIA is preferred by auto-detection)
NVIDIA_API_KEY=nvapi-...

# OR one of:
# GOOGLE_GENERATIVE_AI_API_KEY=...
# GROQ_API_KEY=...
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
```

### Recommended full stack

```bash
# --- LLM ---
NVIDIA_API_KEY=nvapi-...          # lesson planning / teaching (Nemotron) + RAG embeddings
GROQ_API_KEY=gsk_...              # fast "doubt" answers + Whisper STT fallback

# Optional overrides
# LLM_PROVIDER=nvidia|google|groq|openai|anthropic|mock
# LLM_MODEL=moonshotai/kimi-k3
# LESSON_MODEL=nvidia/nemotron-3-ultra-550b-a55b
# DOUBT_MODEL=openai/gpt-oss-120b

# --- Voice (Indic STT/TTS) ---
SARVAM_API_KEY=...                # Saaras v4 STT + Bulbul TTS; without it → browser Web Speech

# Optional Sarvam tuning
# SARVAM_STT_MODEL=saaras:v4
# SARVAM_TTS_MODEL=...
# SARVAM_TTS_SPEAKER=...
# TTS_PACE=0.9                    # 0.5..1.5, how fast Indica speaks; paces Sarvam AND
#                                 # browser speech. Below 1 on purpose: a student needs
#                                 # time to look at what was just drawn, and the slower
#                                 # delivery is what lets the next lesson step finish
#                                 # generating before the current one stops speaking.
# SARVAM_TTS_PACE=0.9             # legacy name for the same thing; TTS_PACE wins
# SARVAM_TTS_PITCH=0.0
# SARVAM_TTS_LOUDNESS=1.0

# --- RAG (textbook grounding) ---
# NVIDIA_API_KEY is required for embeddings at build + query time
# RAG_EMBED_MODEL=nvidia/nemotron-3-embed-1b
# RAG_INDEX_DIR=rag/data/index
# RAG_TOP_K=3
# RAG_EMBED_TIMEOUT_MS=2500
# NVIDIA_EMBED_URL=https://integrate.api.nvidia.com/v1/embeddings
```

### No API keys (UI + whiteboard demo only)

```bash
LLM_PROVIDER=mock
```

Then run the app. You get a canned pizza-fractions lesson so you can see beats, drawing, and voice sync. Auto-ask on load: `http://localhost:3000/?q=why+is+2/4+equal+to+1/2`

---

## 4. Run the web app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

| Script | Purpose |
| --- | --- |
| `npm run dev` | Local development |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |

**Checks after start:**

1. Page loads with whiteboard + composer.
2. Pick a language and (optionally) class + subject.
3. Type a question or hold **Space** / click the mic to speak.
4. Without keys, the UI still loads but prompts for an LLM key (unless `LLM_PROVIDER=mock`).

---

## 5. Optional — NCERT textbook RAG

Grounding is additive: the tutor works without an index. With an index, answers can cite examples, theorems, exercises, and chapter outlines.

### 5.1 Install Python deps

```bash
pip install -r rag/requirements.txt
```

Needs `NVIDIA_API_KEY` in `.env` / `.env.local` or the shell environment.

### 5.2 Add chapter PDFs

Download NCERT chapter PDFs (copyright; do not commit them — `rag/data/` is gitignored).

**Maths classes 1–9** (current NCF English editions) — automated:

```bash
# Windows PowerShell
$env:PYTHONPATH="rag"; python rag/download_ncert_maths.py --grades 1 2 3 4 5 6 7 8 9

# macOS / Linux
PYTHONPATH="rag" python rag/download_ncert_maths.py --grades 1 2 3 4 5 6 7 8 9
```

Or place PDFs manually:

```
rag/data/sources/<book>/<edition>/*.pdf
```

| Book key | Example PDF stem |
| --- | --- |
| `ncert-class-1-maths` … `ncert-class-9-maths` | see `rag/download_ncert_maths.py` / `rag/README.md` |
| `ncert-class-10-maths` | `jemh104.pdf` (chapter 4) |
| `ncert-class-9-science` | `iesc101.pdf` (chapter 1) |

Book keys match `textbookKey(grade, subject)` in `src/lib/curriculum.ts` (e.g. Class 10 Maths → `ncert-class-10-maths`). Edition folder is usually `english`.

### 5.3 Build the index

```bash
# Windows PowerShell — all maths 1–9
$env:PYTHONPATH="rag"; python rag/build_index.py --grades 1 2 3 4 5 6 7 8 9 --edition english

# Single book
$env:PYTHONPATH="rag"; python rag/build_index.py --book ncert-class-10-maths --edition english

# macOS / Linux
PYTHONPATH="rag" python rag/build_index.py --grades 1 2 3 4 5 6 7 8 9 --edition english
```

Output lands in:

```
rag/data/index/<book>/<edition>/
  meta.json
  chunks.json
  vectors.f32
  structure.json
```

### 5.4 Use it in the app

1. Restart `npm run dev` if it was already running.
2. In the UI, pick the matching **Class + Subject** (e.g. Class 10 + Maths).
3. Ask something like “example 2 of chapter 1” or a concept question.

Full runbook (pattern tuning, Hindi editions, troubleshooting): see [`rag/README.md`](rag/README.md).

---

## 6. Optional — smoke test

With the server running:

```bash
node scripts/smoke.cjs http://localhost:3000 "why is 2/4 equal to 1/2?" .tmp/smoke.png
```

Uses headless Chrome (DevTools Protocol). Prints console errors, transcript, Excalidraw scene elements, and saves a screenshot.

---

## 7. Switching models

```bash
# Fast tokens
LLM_PROVIDER=groq
LLM_MODEL=llama-3.3-70b-versatile

# Gemini
LLM_PROVIDER=google
LLM_MODEL=gemini-3.5-flash

# Claude
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
```

If `LLM_PROVIDER` is unset, the app auto-picks from available keys in this order: **NVIDIA → Google → Groq → OpenAI → Anthropic**.

Staged lesson flow (plan / teach / explain) prefers `LESSON_MODEL` on NVIDIA; doubt mode prefers `DOUBT_MODEL` on Groq when those keys exist.

---

## 8. Troubleshooting

| Symptom | What to try |
| --- | --- |
| UI asks for an API key | Set at least one LLM key in `.env.local` and restart `npm run dev` |
| Mic / TTS weak or missing | Use Chrome, or set `SARVAM_API_KEY` |
| Tutor ignores the textbook | Build index for that class/subject; confirm `rag/data/index/<book>/english/` exists |
| `No module named 'common'` when building RAG | Run with `PYTHONPATH="rag"` |
| `NVIDIA_API_KEY not set` during RAG build | Export the key or put it in root `.env` |
| First request slow in dev | Normal — Next compiles the route on first hit |
| Excalidraw CSS looks broken | Do not broaden Tailwind to rewrite `node_modules` CSS (see `next.config.ts`) |

---

## 9. Quick checklist

- [ ] `npm install`
- [ ] `.env.local` with at least one LLM key (or `LLM_PROVIDER=mock`)
- [ ] `npm run dev` → http://localhost:3000
- [ ] (Optional) Sarvam key for Indic voice
- [ ] (Optional) `pip install -r rag/requirements.txt` + build one book index
- [ ] (Optional) Smoke test with `scripts/smoke.cjs`

You are set up when you can ask a question and see Guru speak while drawing on the whiteboard.
