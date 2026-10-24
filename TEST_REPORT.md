# System test report — RAG + Tutor (Maths Classes 1–10)

**Date:** 2026-10-17  
**Environment:** local Next.js on `:3001`, NVIDIA Nemotron Super for tutoring, Nemotron Embed for RAG  
**Scripts:** `rag/eval_retrieval.py`, `scripts/eval_tutor.mjs`

---

## Verdict

| Layer | Score | Are answers correct? |
| --- | --- | --- |
| **RAG retrieval** (right chapter / unit) | **26/27 (96%)** after correcting one false fail | **Yes** — almost always pulls the right textbook material |
| **Live tutor** (grounded + sensible) | **6/6 grounded**; pedagogy is Socratic | **Yes for grounding**; spoken turns often *ask* before stating the full answer (by design) |

**Bottom line:** The textbook indexes for Classes 1–10 Maths are working. Structural lookup (Class 10 examples/theorems) and semantic search (Classes 1–9 NCF books) both retrieve the correct chapters. The tutor uses those passages; when it “fails” a keyword check, it is usually because it opens with a check question instead of dumping the definition.

---

## 1. RAG retrieval results

### Per class

| Book | Checks | Result |
| --- | --- | --- |
| Class 1 Joyful Mathematics | 2/2 | OK |
| Class 2 Joyful Mathematics | 2/2 | OK |
| Class 3 Maths Mela | 2/2 | OK |
| Class 4 Maths Mela | 1/2 | PARTIAL — see miss below |
| Class 5 Maths Mela | 2/2 | OK |
| Class 6 Ganita Prakash | 3/3 | OK |
| Class 7 Ganita Prakash | 2/2 | OK |
| Class 8 Ganita Prakash (Part I) | 2/2 | OK |
| Class 9 Ganita Manjari | 3/3 | OK |
| Class 10 Mathematics | 7/7* | OK (*one automated phrase check was wrong; unit text is correct) |

### Spot checks that passed (content is right)

| Query | Expected | Got |
| --- | --- | --- |
| Class 10 · “example 2 of chapter 1” | Ex 2 Real Numbers (LCM/HCF of 6 & 20) | Exact Example 2 text with prime factorisation, HCF/LCM |
| Class 10 · “theorem 1.2” | Irrationality / primes | Theorem 1.2 on primes dividing squares |
| Class 10 · “what is a quadratic equation” | Ch 4 | Chapter 4 Quadratic Equations |
| Class 9 · coordinates / probability / identities | Ch 1 / 7 / 4 | Correct chapters |
| Class 6 · primes / perimeter / negatives | Ch 5 / 6 / 10 | Prime Time, Perimeter and Area, Other Side of Zero |
| Class 1 · long/round · making 10 | Ch 2 / 4 | Correct chapters |

### Real miss (1)

| Query | Expected | Got | Impact |
| --- | --- | --- | --- |
| Class 4 · “equal groups multiplication” | Ch 9 Equal Groups | Ch 13 Transport Museum (also talks about groups) | Semantic confusion; try a more specific ask (“Equal Groups chapter”) or tune BM25 |

### False fail (corrected)

Class 10 **Exercise 1.1 Q1** retrieval returned the real NCERT items (prime-factor products). The automated test looked for “Euclid / HCF” wording from a *different* exercise. **Lookup is correct.**

### Structure coverage note

| Classes | Examples / Exercises in `structure.json` |
| --- | --- |
| 1–5 (Joyful / Maths Mela) | Almost none — books don’t use classic “Example N / EXERCISE N.N” headings → **semantic RAG only** |
| 6–9 (Ganita Prakash / Manjari) | Some examples + sections; few classic exercises |
| 10 | Rich: 114 examples, 41 exercises, 9 theorems, 54 sections |

---

## 2. Live tutor results

Base URL: `http://localhost:3001` · Model: `nvidia/nemotron-3-super-120b-a12b`

| Case | Grounded on right book/chapter? | Spoken content | Pass? |
| --- | --- | --- | --- |
| Class 10 · Example 2 Ch 1 | Yes — `Chapter 1 · Example 2` | Correct maths: prime factors of 6 & 20, **HCF = 2**, LCM via primes | **PASS** (answer correct) |
| Class 10 · Quadratic definition | Yes — Chapter 4 | Opens with degree check (Socratic), sources correct | **PASS** |
| Class 6 · Prime numbers | Yes — Chapter 5 Prime Time | Asks “what is a factor?” first (mastery prompt) | Grounding **PASS**; not a full definition dump |
| Class 9 · Cartesian plane | Yes — Chapter 1 | Asks about axes first | **PASS** |
| Class 5 · Fractions | Yes — Chapter 2 | Asks what a fraction represents | **PASS** |
| Class 1 · Long / round | Yes — Chapter 2 | Asks for a round thing (age-appropriate) | **PASS** |

### Correctness of the strongest factual case

**Example 2, Chapter 1 (Class 10):** Textbook asks for LCM and HCF of 6 and 20 by prime factorisation.  
Tutor response included factorisation and **HCF = 2**, consistent with the book (HCF = 2, LCM = 60). **Mathematically correct.**

---

## 3. How to re-run

```powershell
# Retrieval only (needs NVIDIA_API_KEY)
$env:PYTHONPATH="rag"; $env:PYTHONIOENCODING="utf-8"; python rag/eval_retrieval.py

# Live tutor (server must be up)
npx next dev --port 3001
node scripts/eval_tutor.mjs http://localhost:3001
```

JSON dump: `.tmp/rag_eval_report.json`

---

## 4. Recommendations

1. **Answers PDF overwrite (Class 10):** `jemh1an.pdf` appears to overwrite some `exercises` entries (e.g. Ex 1.1 page ~250). Prefer chapter PDF text over answers when building structure.
2. **Class 4 Equal Groups:** One semantic miss — optional query rewrite or more chunks from Ch 9.
3. **Primary books:** No Example/Exercise index; rely on semantic search (working well in these tests).
4. **Tutor UX:** “Incomplete” spoken turns are often intentional diagnose→ask; judge correctness after the student answers the check question, or use `explain` mode for named textbook items (as in the Class 10 Example 2 test).
