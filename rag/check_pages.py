"""Flag converted textbook pages that may contain invented or missing content.

Each page's transcription is compared with the PDF page's own text layer. In the Hindi
edition that layer is legacy-encoded junk for words, but its digits survive and its length
still tracks how much text is printed, so two signals work for both editions:

  numbers - numbers used more often in the transcription than they appear on the page
            (invented examples or exercises bring their own numbers)
  length  - transcription length relative to the text layer, compared with the book's median
            (invented content makes a page too long; dropped content makes it too short)

Re-convert flagged pages with: convert_textbook.py ... --files <stem> --pages <n> --force

    python rag/check_pages.py --book ncert-class-10-maths --edition english hindi
"""

import argparse
import re
import statistics
import sys
from collections import Counter

import pymupdf

from common import PAGES, SOURCES

NUM = re.compile(r"\d+")


def numbers(text: str) -> Counter:
    # "18,000" and "18000" are the same number; the book uses both.
    return Counter(NUM.findall(re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)))


def number_excess(md_text: str, layer: str) -> list[str]:
    have, used = numbers(layer), numbers(strip_figures(md_text))
    return [n for n, c in used.items() if c > have.get(n, 0) + 1]   # +1: tolerate one re-split


def strip_figures(t: str) -> str:
    # [Figure: ...] lines are the model's own descriptions; the PDF text layer never has them.
    return re.sub(r"^\[Figure:.*$", "", t, flags=re.M)


def visible_len(t: str) -> int:
    # Drop LaTeX command names (\frac, \angle, \triangle...) so formulas are compared by content,
    # not by how much longer LaTeX spells them than the printed symbols.
    t = re.sub(r"\\[A-Za-z]+", "", strip_figures(t))
    return len(re.sub(r"[\s$\\{}^_*#|]", "", t))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--book", required=True)
    p.add_argument("--edition", nargs="+", required=True)
    p.add_argument("--max-extra-numbers", type=int, default=2)
    p.add_argument("--length-band", type=float, default=0.25,
                   help="flag pages whose length ratio is this far from the median (default 25%%)")
    args = p.parse_args()

    flagged = total = 0
    for edition in args.edition:
        docs: dict = {}
        rows = []
        for md in sorted((PAGES / args.book / edition).glob("*/page_*.md")):
            stem, page = md.parent.name, int(md.stem.split("_")[1])
            if stem not in docs:
                docs[stem] = pymupdf.open(SOURCES / args.book / edition / f"{stem}.pdf")
            layer = docs[stem][page - 1].get_text()
            text = md.read_text(encoding="utf-8")
            # Near-empty layer (figure-only page): too little text for a meaningful length test.
            ratio = visible_len(text) / visible_len(layer) if visible_len(layer) >= 80 else None
            rows.append((md, number_excess(text, layer), ratio))
        ratios = [r for _, _, r in rows if r is not None]
        med = statistics.median(ratios) if ratios else 1.0
        print(f"== {edition}: {len(rows)} pages, median length ratio {med:.2f}")
        for md, excess, ratio in rows:
            total += 1
            reasons = []
            if len(excess) > args.max_extra_numbers:
                reasons.append(f"extra numbers {excess[:8]}")
            if ratio is not None and abs(ratio / med - 1) > args.length_band:
                reasons.append(f"length {ratio / med:.0%} of normal")
            if reasons:
                flagged += 1
                print(f"  FLAG {md.parent.name} --pages {int(md.stem.split('_')[1])}: {'; '.join(reasons)}")
    print(f"{flagged} of {total} pages flagged")


if __name__ == "__main__":
    main()
