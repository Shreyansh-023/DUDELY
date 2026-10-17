# Textbook ingestion runbook

How to turn a new NCERT PDF (e.g. **Class 9 Science**) into a retrieval index the tutor
uses for grounding — covering **all** grounding mechanisms: deterministic lookup,
outline + Introduction analogy, and semantic search.

Everything the app needs at query time is in `src/lib/rag.ts`; everything built offline is
here in `rag/`. `rag/data/` is git-ignored (NCERT PDFs are copyright; the index regenerates).

---

## 0. TL;DR (happy path)

```bash
pip install -r rag/requirements.txt                 # pymupdf + httpx (one-time)
# NVIDIA_API_KEY must be in .env or the environment (used for embeddings)

# Maths classes 1–9 (downloads current NCF English PDFs, then embeds):
PYTHONPATH="rag" python rag/download_ncert_maths.py --grades 1 2 3 4 5 6 7 8 9
PYTHONPATH="rag" python rag/build_index.py --grades 1 2 3 4 5 6 7 8 9 --edition english

# Or put chapter PDFs manually, e.g. rag/data/sources/ncert-class-9-science/english/*.pdf
PYTHONPATH="rag" python rag/build_index.py --book ncert-class-9-science --edition english
```

Then open the app, pick **Class 9 + Science**, and it's grounded. No app-code change — the
UI already supports grades 1–12 × {maths, science} (`src/lib/curriculum.ts`).

**But read §3–4 before trusting the result** — a new book (especially the rewritten
"Exploration" series) may not follow the same heading conventions, and the structural
extraction is tuned to NCERT Maths. Always verify the counts (§5).

---

## 1. How grounding works — what the preprocessing must produce

A student question is answered by one of three paths, all fed by files this build produces:

| Query kind | Example | Powered by | Build output |
| --- | --- | --- | --- |
| **Deterministic** (names a unit by position) | "example 2 of chapter 1", "theorem 1.2", "exercise 1.1 q3", "section 8.2", "page 45" | exact lookup, **no embedding call** | `structure.json` + `printedPage` on `chunks.json` |
| **Semantic** (a concept) | "what is a quadratic equation", "why is √2 irrational" | Nemotron embedding + BM25, fused by RRF | `vectors.f32` + `chunks.json` |
| **Topic opener** (starting a topic) | "teach me trigonometry" | chapter **outline** + **Introduction** section (the book's hook/analogy) | `structure.json` (`sections`, `outlines`) |

On top of that, **every grounded turn** also gets the dominant chapter's one-line **outline**
as framing, so the tutor teaches in the book's order and knows the prerequisites.

So a complete ingestion must produce, per book/edition:

```
rag/data/index/<book>/<edition>/
  meta.json        # {book, edition, embedModel, dim, count}
  chunks.json      # [{id, stem, chapter, label, pages, printedPage, kind, text}]  — all prose, semantic + page lookup
  vectors.f32      # little-endian float32 [count × dim], L2-normalized — semantic search
  structure.json   # {examples, theorems, exercises, sections, outlines}   — deterministic + outline/intro
```

`<book>` is the key from `textbookKey(grade, subject)` in `src/lib/curriculum.ts`, e.g.
`ncert-class-9-science`. `<edition>` is the language folder: `english` (or `hindi`).

---

## 2. Get the PDFs

NCERT chapter PDFs live at `https://ncert.nic.in/textbook/pdf/<stem>.pdf`. The stem prefix
encodes class+subject; the **last two digits are the chapter number**, which the build reads
via the regex `(\d\d)\D*$` on the filename.

| Book | Stem prefix | Example |
| --- | --- | --- |
| Class 1 Maths (Joyful Mathematics) | `aejm1` | `aejm101.pdf` = ch 1 |
| Class 2 Maths (Joyful Mathematics) | `bejm1` | `bejm101.pdf` = ch 1 |
| Class 3 Maths (Maths Mela) | `cemm1` | `cemm101.pdf` = ch 1 |
| Class 4 Maths (Maths Mela) | `demm1` | `demm101.pdf` = ch 1 |
| Class 5 Maths (Maths Mela) | `eemm1` | `eemm101.pdf` = ch 1 |
| Class 6 Maths (Ganita Prakash) | `fegp1` | `fegp101.pdf` = ch 1 |
| Class 7 Maths (Ganita Prakash) | `gegp1` | `gegp101.pdf` = ch 1 |
| Class 8 Maths (Ganita Prakash Part I) | `hegp1` | `hegp101.pdf` = ch 1 |
| Class 9 Maths (Ganita Manjari) | `iemh1` | `iemh101.pdf` = ch 1 |
| Class 10 Maths (English) | `jemh1` | `jemh104.pdf` = ch 4 |
| Class 9 Science (English) | `iesc1` | `iesc101.pdf` = ch 1 |

`rag/download_ncert_maths.py` fetches classes 1–9 English Maths for you.

Find the exact stems from the book's page on ncert.nic.in (or probe `curl -sI`). Put one PDF
per chapter into:

```
rag/data/sources/<book>/<edition>/
```

A non-numeric stem like `...ps` (prelims) or `...an` (answers) has no chapter number; its
pages are still chunked for semantic search but get no chapter label or structural units.

---

## 3. Inspect the PDF's conventions FIRST (do not skip)

The structural extraction is tuned to NCERT **Maths** headings. Before building, check what
the new book actually contains, because conventions differ by subject and edition:

```bash
python -I -c "
import pymupdf, re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')   # Windows + Devanagari safe
doc = pymupdf.open(sys.argv[1]); txt='\n'.join(doc[i].get_text() for i in range(doc.page_count))
for n,p in [('Example N',r'Example\s+\d+'),('Theorem N.N',r'Theorem\s+\d+\.\d+'),
            ('EXERCISE N.N',r'EXERCISE\s+\d+\.\d+'),('Exercises',r'(?i)\bexercises?\b'),
            ('Activity',r'Activity'),('section ^N.N Title',r'(?m)^\s*\d+\.\d+\s+[A-Z]'),
            ('running header',r'(?i)mathematics|science|exploration')]:
    print(f'  {n:20}: {len(re.findall(p,txt))}')
print(txt[:600])
" rag/data/sources/<book>/<edition>/<one-chapter>.pdf
```

**What we already learned by doing this:**
- Class 10 Maths: `Example N :`, `Theorem N.N :`, `EXERCISE N.N`, `N.N Title` sections, header
  `… MATHEMATICS <page>` — all captured by the current patterns. ✅
- Class 9 Science ("**Exploration**", new 2024 book): has `Example N`, but **`Activity` boxes**
  (not captured), **no `Theorem`**, exercises **not** styled `EXERCISE N.N`, section headings
  in a different form, and header `Exploration|Grade 9` (not `MATHEMATICS`). So the Maths
  patterns will **under-capture** — you must tune them (§4) or you'll get a semantic-only index.

---

## 4. Tune the patterns per subject (only if §3 shows a mismatch)

All patterns are at the top of `rag/build_index.py`. Edit these for a new subject/edition:

| Symbol | Current (Maths) | Change for a new book when… |
| --- | --- | --- |
| `TITLES` | `{"ncert-class-10-maths": {1:"Real Numbers", …}}` | **always** add an entry `{"<book>": {1:"…", …}}` for nice labels (else labels fall back to "Chapter N") |
| `_MAJOR` | matches `Example N :`, `Theorem N.N :`, `EXERCISE N.N` | add the book's units, e.g. `Activity\s+[\d.]+`, or `(?i)Exercises` for the end-of-chapter style |
| `_SECTION` | `^\s*(\d+)\.(\d+)\s+([A-Z]…)` | if sections aren't `N.N Title` at line start (Science often isn't), adjust to the book's heading form |
| `_QNUM` | `^\s*(\d{1,2})\.\s` (questions in an exercise) | usually fine; tweak if question numbering differs |
| `_HDR_EVEN` / `_HDR_ODD` | keyed on `MATHEMATICS` | point at the book's running header (`SCIENCE`, `Exploration`) so **printed page** detection works; otherwise printed page falls back to the PDF page index |

Then, in `src/lib/rag.ts`, the query-side parser (`parseStructuralRefs`) already handles
`example / theorem / exercise / section / page / chapter`. If you add a new unit type (e.g.
**activity**), add: a key in `structure.json` (build side), a `Structure` field + a branch in
`resolveStructural`, and an `activity\s+…` rule in `parseStructuralRefs` (rag.ts).

> Query keywords recognise **English, Hinglish and Hindi (Devanagari)** — `example / udaharan /
> उदाहरण`, `chapter / adhyay / अध्याय`, `theorem / प्रमेय`, `exercise / प्रश्नावली`, `section`,
> `page / पृष्ठ`, plus opener words (`teach / sikhao / सिखाओ`, …); Devanagari digits (`उदाहरण २`)
> are normalised. Because a reference is numeric and the numbering is identical across editions,
> a Hindi/Hinglish request resolves into the **English** index with no Hindi book needed (the
> tutor then teaches that unit in the student's language). See `parseStructuralRefs` / `OPENER`
> in `src/lib/rag.ts`; add more aliases or another language there.

---

## 5. Build and verify

```bash
PYTHONPATH="rag" python rag/build_index.py --book ncert-class-9-science --edition english
```

The script prints a summary per book, e.g.:

```
wrote 285 chunks x 2048d + structure (114 examples, 9 theorems, 32 exercises, 54 sections)
```

**Verify — this is the real acceptance test:**
1. **Counts are non-trivial.** If examples/sections/exercises are ~0 for a book that clearly
   has them, your patterns don't match this book → go back to §4. (A semantic-only index still
   works, but you lose deterministic lookup and the opener analogy.)
2. **Spot-check a unit** resolves to the right text:
   ```bash
   node -e 'const s=JSON.parse(require("fs").readFileSync("rag/data/index/<book>/english/structure.json","utf8"));
            console.log(s.outlines["1"]); console.log(s.examples["1"]?.["2"]?.text?.slice(0,160));'
   ```
3. **Probe retrieval** (optional) with a few questions and confirm the right chapter/unit comes
   back (see `rag/build_index.py` header and the diagnostic scripts used during development).

---

## 6. Editions (English vs Hindi)

This plain-text path (`PyMuPDF get_text`) is for the **English** edition. The **Hindi** edition
uses a legacy font that extracts as Latin junk (0% Devanagari) and mangles formulas, so it
needs a **vision OCR** step (render each page → transcribe with a vision model) before this
build. That ingestion is out of scope for this plain-text script; add Hindi only after a page →
Markdown transcription step exists. Nemotron itself is cross-lingual, so once a Hindi index
exists, Hindi/Hinglish questions retrieve from it; until then they fall back to the English
index (which still works, just in English).

---

## 7. Rebuilding / yearly revisions

- NCERT revises books periodically. To refresh: replace the PDFs and re-run the build.
- **Re-embed the whole book** when you change it — you cannot mix old and new vectors.
- **Never change the embedding model for only part of a book.** Vectors from different models
  aren't comparable. If you switch models, rebuild every book and keep `meta.embedModel` honest
  (it must match `RAG_EMBED_MODEL` / the default in `src/lib/rag.ts`, currently
  `nvidia/nemotron-3-embed-1b`, dim 2048).

---

## 8. Config & environment

| Var | Where | Default | Purpose |
| --- | --- | --- | --- |
| `NVIDIA_API_KEY` | `.env` / env | — (required) | Nemotron embeddings (build + query) |
| `RAG_EMBED_MODEL` | env | `nvidia/nemotron-3-embed-1b` | embedding model (must match the built index) |
| `RAG_INDEX_DIR` | env | `rag/data/index` | where the app reads indexes |
| `RAG_TOP_K` | env | `3` | semantic passages per turn |
| `RAG_EMBED_TIMEOUT_MS` | env | `2500` | query-embed timeout → falls back to BM25-only |
| `NVIDIA_EMBED_URL` | env | `https://integrate.api.nvidia.com/v1/embeddings` | NIM endpoint |

Embeddings run **off Groq** (Groq has no embedding endpoint); generation stays 100% on Groq.
At query time the only non-Groq call is one stateless embedding request for the question, and
deterministic (structural) lookups skip even that.

---

## 9. Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| `structure.json` has ~0 examples/sections | Patterns don't match this book's headings → §3 inspect, §4 tune |
| Printed-page lookup ("page 45") is wrong | `_HDR_EVEN/_HDR_ODD` keyed on `MATHEMATICS` → point at the book's header |
| Build error `No module named 'common'` | run with `PYTHONPATH="rag"` (or from the `rag/` dir) |
| `NVIDIA_API_KEY not set` | add it to `.env` at repo root or export it |
| Tutor ignores the book | class+subject must name a built index: `textbookKey(grade,subject)` → `rag/data/index/<key>/english/` must exist |
| Devanagari test query retrieves wrong passages via `curl` | shell mangles non-ASCII args — send the JSON body from a UTF-8 **file** (`--data-binary @body.json`), not an inline `-d` string |
| First request very slow | Next.js compiles the route on first hit (dev only); subsequent calls are fast |
