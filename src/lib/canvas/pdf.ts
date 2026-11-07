/**
 * Export the board as a PDF: one landscape page per board page, in reading
 * order, so a finished session downloads as the set of notes it already is.
 *
 * Written by hand rather than with a PDF library, and that is a deliberate
 * trade. Every page of this document is a single full-bleed raster image, which
 * is the one PDF shape simple enough to emit directly: a handful of objects, no
 * fonts, no vector graphics state, no compression beyond what the JPEG already
 * carries. jsPDF would do the same job in fewer lines of ours and a few hundred
 * KB more of theirs, for a document that needs none of the rest of it.
 *
 * The images come from Excalidraw's own `exportToCanvas`, so a page in the PDF
 * is rendered by the same code that drew it on screen — including the hand-drawn
 * stroke style and the board fonts.
 */

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BoardPlayer } from "./player";
import { PAGE_H, PAGE_W } from "./page";

/** A4 landscape at 72 dpi, the unit PDF measures in. 842 x 595. */
const SHEET_W = 841.89;
const SHEET_H = 595.28;
/**
 * Pixels per PDF point when rasterising. 2 puts an A4 landscape page at about
 * 1684x1191, which is ~144 dpi: sharp on screen and when printed, while keeping
 * a 12-page lesson comfortably small.
 */
const RASTER_SCALE = 2;
/** JPEG quality. 0.9 keeps the thin board strokes clean; 0.8 visibly softens them. */
const JPEG_QUALITY = 0.9;

export type PdfPage = { index: number; kind: "teach" | "doubt"; label: string };

/** The subset of Excalidraw's `exportToCanvas` this module uses. Passed in by
 *  the caller so the Excalidraw bundle is only pulled in where it already is. */
/** Excalidraw's own bounds helper: [x1, y1, x2, y2] over a set of elements,
 *  extents included. Passed in with `exportToCanvas` for the same reason. */
export type GetCommonBounds = (elements: readonly ExcalidrawElement[]) => readonly [number, number, number, number];

export type ExportToCanvas = (opts: {
  elements: readonly ExcalidrawElement[];
  appState?: Record<string, unknown>;
  files: null;
  exportPadding?: number;
  getDimensions?: (width: number, height: number) => { width: number; height: number; scale?: number };
}) => Promise<HTMLCanvasElement>;

/**
 * The board's pages in READING order, each with the label the PDF prints on it.
 *
 * Reading order is by row then column, not allocation order — that is what puts
 * a step's doubt pages straight after the step they interrupted, matching what
 * BoardPager shows and what the student actually walked through.
 */
export function pdfPageList(player: BoardPlayer): PdfPage[] {
  const { pages } = player.getPageState();
  const used = pages.filter((p) => p.used);
  const ordered = [...used].sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
  let teach = 0;
  return ordered.map((p) => {
    // Doubt pages are numbered off the lesson page they hang from ("4a"), so the
    // lesson's own page numbers stay 1..n however many doubts were raised.
    if (p.kind === "doubt") return { index: p.index, kind: "doubt" as const, label: `${teach}a` };
    teach += 1;
    return { index: p.index, kind: "teach" as const, label: String(teach) };
  });
}

/** Render one board page to a JPEG data URL, letterboxed onto the sheet. */
async function renderPage(
  player: BoardPlayer,
  index: number,
  exportToCanvas: ExportToCanvas,
  getCommonBounds: GetCommonBounds,
): Promise<string | null> {
  const raw = player.pageElements(index);
  if (!raw.length) return null;

  // Export the FULL text of every line, not whatever the typewriter had got to.
  //
  // `typeText` animates a line in by patching `text` one chunk at a time, and
  // it `break`s out of that loop when the turn is aborted — a doubt, a new
  // topic, the student pressing stop. The element is then left holding the
  // partial string permanently, and exporting it produced pages of lines cut
  // off mid-word ("2. Identifying quadratic equatio"). `originalText` is the
  // line as the model wrote it, so restoring from it is also a repair: the PDF
  // comes out complete even where the board on screen is not.
  const elements = raw.map((e) => {
    if (e.type !== "text") return e;
    const t = e as ExcalidrawElement & { text?: string; originalText?: string };
    const full = t.originalText;
    const shown = t.text ?? "";
    if (!full || full === shown) return e;
    // The stored `width` was measured against the truncated string, and the
    // bounds pass below reads it. Widening it in proportion to the characters
    // being restored keeps the crop box around the line that will actually be
    // drawn. It is an estimate — Excalidraw re-measures the glyphs itself when
    // it renders — but it only ever errs wide, and a crop box slightly too
    // large costs nothing while one too small clips the line again.
    const grow = shown.length > 0 ? full.length / shown.length : 1;
    return { ...t, text: full, width: e.width * grow } as ExcalidrawElement;
  });

  // `exportToCanvas` crops to the elements' own bounding box; it has no notion
  // of our pages. So the page frame is restored here: the crop is drawn back at
  // its PAGE-LOCAL position on a full 1280x720 sheet, which keeps every page
  // the same size and keeps the lesson's own margins.
  const rect = player.pageSceneRect(index);
  // `getDimensions` returns the CANVAS size, not the scene size: Excalidraw does
  // `canvas.width = ret.width` and then renders the scene at `ret.scale`. So the
  // width/height must already include the scale. Returning the unscaled (w, h)
  // with scale 2 draws a 2x scene into a 1x canvas, and only the top-left
  // quarter of every page survives: lines cut off halfway across, and the
  // lower half of the page missing entirely.
  const src = await exportToCanvas({
    elements,
    files: null,
    exportPadding: 0,
    appState: { exportBackground: false, viewBackgroundColor: "transparent" },
    getDimensions: (w, h) => ({
      width: Math.ceil(w * RASTER_SCALE),
      height: Math.ceil(h * RASTER_SCALE),
      scale: RASTER_SCALE,
    }),
  });

  // Where that crop sits inside the page.
  //
  // `getCommonBounds` — the same helper the player uses for page.bottom — and
  // NOT a min() over e.x/e.y. Element extents matter: a wide heading starting
  // right of a short line still sets the crop's right edge, and a bounds box
  // measured from origins alone is wrong the moment the leftmost element is not
  // also the widest. Getting this wrong shifts the whole page sideways and
  // pushes its right-hand content off the sheet, which is exactly how a PDF ends
  // up full of lines cut off mid-word.
  const [bx1, by1] = getCommonBounds(elements);
  const offX = (bx1 - rect.x) * RASTER_SCALE;
  const offY = (by1 - rect.y) * RASTER_SCALE;

  // The page, at raster scale, on white.
  const page = document.createElement("canvas");
  page.width = Math.round(PAGE_W * RASTER_SCALE);
  page.height = Math.round(PAGE_H * RASTER_SCALE);
  const pctx = page.getContext("2d");
  if (!pctx) return null;
  pctx.fillStyle = "#ffffff";
  pctx.fillRect(0, 0, page.width, page.height);

  // Anything that would fall outside the page is a layout escape, not something
  // to crop away: a beat that ran past CONTENT_RIGHT, or a diagram the collision
  // pass nudged over the edge. Scale the crop down to fit rather than lose it —
  // a slightly smaller page reads fine, a page missing the end of every line
  // does not.
  const fit = Math.min(1, page.width / (offX + src.width), page.height / (offY + src.height));
  if (fit < 1) {
    pctx.drawImage(src, offX * fit, offY * fit, src.width * fit, src.height * fit);
  } else {
    pctx.drawImage(src, offX, offY);
  }

  // Letterbox the 16:9 page onto the ~1.41:1 sheet. Centred and aspect-true:
  // a formula stretched 6% horizontally looks wrong in a way that is hard to
  // place, so the sheet gets white margins instead.
  const out = document.createElement("canvas");
  out.width = Math.round(SHEET_W * RASTER_SCALE);
  out.height = Math.round(SHEET_H * RASTER_SCALE);
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  const scale = Math.min(out.width / page.width, out.height / page.height);
  const w = page.width * scale;
  const h = page.height * scale;
  ctx.drawImage(page, (out.width - w) / 2, (out.height - h) / 2, w, h);
  return out.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** The raw bytes behind a JPEG data URL. */
function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Assemble a minimal PDF 1.4 whose every page is one full-sheet JPEG.
 *
 * Object numbering: 1 catalog, 2 page tree, then THREE objects per sheet — the
 * /Page, its content stream, and the JPEG XObject — then the Info dictionary.
 * All three per page are needed: a /Page with no content stream draws nothing,
 * and an /XObject reference that resolves to the content stream is a broken
 * file. The xref table needs each object's exact byte offset, so the body is
 * built as a list of byte chunks whose lengths are measured as they are pushed.
 */
function buildPdf(images: { bytes: Uint8Array; w: number; h: number }[], title: string): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let len = 0;
  const push = (part: string | Uint8Array) => {
    const b = typeof part === "string" ? enc.encode(part) : part;
    chunks.push(b);
    len += b.length;
  };

  const n = images.length;
  const pageObj = (i: number) => 3 + i * 3;
  const contentObj = (i: number) => 4 + i * 3;
  const imageObj = (i: number) => 5 + i * 3;
  const infoObj = 3 + n * 3;
  const offsets: number[] = [];
  const begin = (num: number) => {
    offsets[num] = len;
  };

  push("%PDF-1.4\n");
  // A comment of high bytes, which marks the file as binary for tools that
  // sniff it — without it some readers treat the JPEG streams as text.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  begin(1);
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  begin(2);
  push(
    `2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${images
      .map((_, i) => `${pageObj(i)} 0 R`)
      .join(" ")}] >>\nendobj\n`,
  );

  const box = `0 0 ${SHEET_W.toFixed(2)} ${SHEET_H.toFixed(2)}`;
  images.forEach((img, i) => {
    begin(pageObj(i));
    push(
      `${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${box}]` +
        ` /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >>` +
        ` /Contents ${contentObj(i)} 0 R >>\nendobj\n`,
    );

    // Paint Im0 across the whole MediaBox. The cm matrix IS the placement; the
    // image's own pixel size never appears here, which is why the letterboxing
    // has to be baked into the raster above.
    begin(contentObj(i));
    const draw = `q ${SHEET_W.toFixed(2)} 0 0 ${SHEET_H.toFixed(2)} 0 0 cm /Im0 Do Q\n`;
    push(`${contentObj(i)} 0 obj\n<< /Length ${enc.encode(draw).length} >>\nstream\n${draw}endstream\nendobj\n`);

    // The JPEG goes in verbatim: /DCTDecode means "these bytes are a JPEG", so
    // there is no re-encoding and no second compression pass.
    begin(imageObj(i));
    push(
      `${imageObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
    );
    push(img.bytes);
    push("\nendstream\nendobj\n");
  });

  begin(infoObj);
  // Blank out the characters that would end a PDF literal string early.
  const safe = title.replace(/[\\()]/g, " ").slice(0, 120);
  push(`${infoObj} 0 obj\n<< /Title (${safe}) /Producer (Indica) >>\nendobj\n`);

  const xref = len;
  push(`xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`);
  for (let num = 1; num <= infoObj; num++) {
    push(`${String(offsets[num] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}

/** Turn a topic into a safe file stem. */
function fileStem(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "indica-notes"
  );
}

/**
 * Render every used board page and download them as one landscape PDF.
 *
 * `exportToCanvas` is passed in rather than imported so this module adds nothing
 * to the bundle that loads the board.
 */
export async function downloadBoardPdf(opts: {
  player: BoardPlayer;
  exportToCanvas: ExportToCanvas;
  /** Excalidraw's `getCommonBounds`, for locating each page's crop. */
  getCommonBounds: GetCommonBounds;
  /** Used for the file name and the PDF title. */
  topic?: string | null;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ pages: number } | { error: string }> {
  const list = pdfPageList(opts.player);
  if (!list.length) return { error: "There is nothing on the board yet." };

  const images: { bytes: Uint8Array; w: number; h: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    opts.onProgress?.(i, list.length);
    let url: string | null = null;
    try {
      url = await renderPage(opts.player, list[i].index, opts.exportToCanvas, opts.getCommonBounds);
    } catch {
      // One unrenderable page must not lose the other eleven.
      url = null;
    }
    if (!url) continue;
    images.push({
      bytes: dataUrlBytes(url),
      w: Math.round(SHEET_W * RASTER_SCALE),
      h: Math.round(SHEET_H * RASTER_SCALE),
    });
  }
  if (!images.length) return { error: "Could not render the board pages." };
  opts.onProgress?.(list.length, list.length);

  const title = (opts.topic || "Indica notes").trim();
  const blob = buildPdf(images, title);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `${fileStem(title)}.pdf`;
  a.click();
  // Revoke on a later turn: revoking synchronously can cancel the download in
  // some browsers before they have finished reading the blob.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return { pages: images.length };
}
