"""Convert NCERT textbook PDFs into clean per-page Markdown with a local vision model.

Plain PDF text extraction fails on these books: the Hindi edition uses a legacy font
encoding (extracts as Latin junk, 0% Devanagari) and maths formulas lose their structure.
So each page is rendered to an image and transcribed by a vision model (via Ollama, on
this machine's GPU) into Markdown + LaTeX.

Model choice: on a formula-dense page (stacked fractions, Chapter 8 identities) gemma4:e4b
at 170 DPI got 2 of 6 checkpoints right, including a wrong identity statement; qwen3.5:9b at
250 DPI got 6 of 6, and matched verified pages elsewhere. Qwen is ~6x slower (about 40-90 s
a page), so a whole book is an overnight run; gemma4:e4b is fine for prose-only material.

Existing pages are skipped, so an interrupted run resumes where it stopped. Run
check_pages.py afterwards: models occasionally invent content past the end of a page.

    python rag/convert_textbook.py --book ncert-class-10-maths --edition english hindi
    python rag/convert_textbook.py --book ncert-class-10-maths --edition english --files jemh104 --pages 1-3
"""

import argparse
import base64
import re
import sys
import time
from pathlib import Path

import httpx
import pymupdf

from common import OLLAMA, PAGES, SOURCES, book_title

DEFAULT_MODEL = "qwen3.5:9b"
DPI = 250

PROMPT = """Transcribe this page from the {title} textbook ({language} edition) into Markdown.

Rules:
- Transcribe the text faithfully and completely, in the original language and script{script_note}. Do not translate, summarise or add explanations.
- Write every mathematical expression in LaTeX: inline as $...$, displayed equations as $$...$$.
- Keep the structure: chapter titles as #, section numbers as ## (e.g. "## 4.3 ..."), sub-sections as ###. Mark examples as **Example N** and their solutions as **Solution**. Mark exercise headings as ## EXERCISE N.N and keep question numbering.
- Tables as Markdown tables.
- For each figure or diagram, write one line: [Figure: <short description of what it shows, including any labels and values>]. Keep figure captions (e.g. "Fig. 6.2").
- Leave out running headers (the chapter name or book title printed at the very top of the page), footers and page numbers.
- Transcribe ONLY what is printed on this page. Pages often begin or end in the middle of a sentence: start and stop exactly where the printed text does. Never continue the text, and never add examples, exercises or questions that are not visible on the page.
- Output only the transcription, with no preamble or commentary."""


def page_ranges(spec: str | None, n: int) -> list[int]:
    if not spec:
        return list(range(n))
    pages = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        pages.extend(range(int(a) - 1, int(b or a)))
    return [p for p in pages if 0 <= p < n]


def transcribe(http: httpx.Client, model: str, png: bytes, prompt: str) -> str:
    r = http.post(f"{OLLAMA}/api/chat", json={
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": [base64.b64encode(png).decode()]}],
        "stream": False,
        "think": False,
        "keep_alive": "10m",
        "options": {"temperature": 0, "num_ctx": 16384, "num_predict": 6144},
    })
    if r.status_code != 200:
        raise RuntimeError(r.json().get("error", r.text))
    body = r.json()
    if body.get("done_reason") == "length":
        raise RuntimeError("output hit the length limit; page may be truncated")
    text = body["message"]["content"].strip()
    if not text:
        raise RuntimeError("empty response")
    # Models sometimes wrap the whole page in a ```markdown fence; strip it.
    return re.sub(r"^```(?:markdown|md)?\s*\n|\n?```\s*$", "", text)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--book", required=True, help='textbook key, e.g. "ncert-class-10-maths"')
    p.add_argument("--edition", nargs="+", required=True, help="edition folder(s), e.g. english hindi")
    p.add_argument("--files", nargs="*", help="PDF stems to convert, e.g. jemh104 (default: all)")
    p.add_argument("--pages", help="1-based pages, e.g. 1-3,7 (default: all)")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--dpi", type=int, default=DPI, help=f"page render resolution (default {DPI})")
    p.add_argument("--out", type=Path, default=PAGES, help="output root (default rag/data/pages)")
    p.add_argument("--force", action="store_true", help="re-convert pages that already exist")
    args = p.parse_args()

    http = httpx.Client(timeout=900)
    title = book_title(args.book)
    done = skipped = failed = 0
    started = time.perf_counter()
    for edition in args.edition:
        prompt = PROMPT.format(title=title, language=edition.capitalize(),
                               script_note=" (Hindi in Unicode Devanagari)" if edition == "hindi" else "")
        pdfs = sorted((SOURCES / args.book / edition).glob("*.pdf"))
        if not pdfs:
            print(f"no PDFs in {SOURCES / args.book / edition}")
        if args.files:
            pdfs = [f for f in pdfs if f.stem in set(args.files)]
        for pdf in pdfs:
            doc = pymupdf.open(pdf)
            out_dir = args.out / args.book / edition / pdf.stem
            out_dir.mkdir(parents=True, exist_ok=True)
            for i in page_ranges(args.pages, doc.page_count):
                out = out_dir / f"page_{i + 1:03d}.md"
                if out.exists() and not args.force:
                    skipped += 1
                    continue
                png = doc[i].get_pixmap(dpi=args.dpi).tobytes("png")
                t = time.perf_counter()
                try:
                    out.write_text(transcribe(http, args.model, png, prompt), encoding="utf-8")
                    done += 1
                    print(f"{edition}/{pdf.stem} p{i + 1:3d}  {time.perf_counter() - t:5.1f}s")
                except Exception as e:                           # log and continue; rerun picks it up
                    failed += 1
                    print(f"{edition}/{pdf.stem} p{i + 1:3d}  FAILED: {e}")
    mins = (time.perf_counter() - started) / 60
    print(f"converted {done}, skipped {skipped} existing, failed {failed} in {mins:.1f} min")


if __name__ == "__main__":
    main()
