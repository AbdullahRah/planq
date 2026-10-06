// Text extraction from the NBC(AE) PDF.
//
// PLANQ_SPEC.md §5 specifies `pdftotext` in raw and `-layout` modes. poppler is
// not installable in this environment, and a system binary would not exist in a
// serverless function either, so both modes are reconstructed here from
// pdfjs-dist, which is already a dependency. The two modes serve the same
// purposes the spec gives them:
//
//   reading()  - clause prose, words joined on measured inter-item gaps
//   layout()   - column-preserving, for the tables §5 says parse best this way
//
// The one real difference from pdftotext: defined terms in this PDF are set in
// italics as separate text items with no space between them, so a naive join
// yields "requiredexitstairs". reading() inserts a space whenever the gap
// between two items is a meaningful fraction of the font size.

import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export interface PageText {
  pdf_page: number;
  /** Prose with words correctly separated. */
  reading: string;
  /** One string per visual line, columns preserved with spaces. */
  layout: string[];
  /** Printed page label from the footer, e.g. "9-21". Null on front matter. */
  printed_page: string | null;
  /** "A" or "B" from the running head, when present. */
  division: string | null;
}

type Positioned = { x: number; y: number; w: number; h: number; s: string };

function positioned(items: TextItem[]): Positioned[] {
  const out: Positioned[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    out.push({
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height || 10,
      s: it.str,
    });
  }
  return out;
}

/**
 * Group items into visual lines. The PDF sets body text on a ~9pt grid, so a
 * 3pt bucket keeps a line together without merging adjacent lines.
 */
function toLines(items: Positioned[]): Positioned[][] {
  const rows = new Map<number, Positioned[]>();
  for (const it of items) {
    const key = Math.round(it.y / 3) * 3;
    const row = rows.get(key);
    if (row) row.push(it);
    else rows.set(key, [it]);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF y grows upward; reading order is top-down
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x));
}

/**
 * Join one line's items into prose. A space goes in when the horizontal gap is
 * at least a fifth of the font size — enough to separate an italic defined term
 * from the word after it, without splitting kerned pairs inside a word.
 */
function joinLine(cells: Positioned[]): string {
  let out = '';
  let prevEnd: number | null = null;
  let prevH = 10;
  for (const c of cells) {
    if (prevEnd != null) {
      const gap = c.x - prevEnd;
      if (gap > Math.max(prevH, c.h) * 0.2) out += ' ';
    }
    out += c.s;
    prevEnd = c.x + c.w;
    prevH = c.h;
  }
  return out;
}

/** Column-preserving rendering, for tables. 4.2pt per character approximates the body font. */
function layoutLine(cells: Positioned[]): string {
  let line = '';
  let cursor = 0;
  for (const c of cells) {
    const col = Math.round(c.x / 4.2);
    if (col > cursor) line += ' '.repeat(col - cursor);
    line += c.s;
    cursor = col + c.s.length;
  }
  return line.trimEnd();
}

// The footer carries the printed page number next to the division, and the two
// swap places by page parity:
//   odd  "National Building Code – 2023 Alberta Edition Volume 2  Division B 9-31"
//   even "9-30  Division B  National Building Code – 2023 Alberta Edition Volume 2"
// Matching only one order silently left printed_page empty on every even page.
const PRINTED_PAGE_AFTER_RE = /\bDivision\s+([AB])\s+([A-Z]?\d+-\d+)\b/;
const PRINTED_PAGE_BEFORE_RE = /\b([A-Z]?\d+-\d+)\s+Division\s+([AB])\b/;
const DIVISION_RE = /\bDivision\s+([AB])\b/;

/**
 * The copyright line is stamped on every page and carries no code content.
 * Dropping it keeps it out of clause text and out of the table parser.
 */
const BOILERPLATE_RE = /His Majesty the King in Right of Canada|Sa Majest|National Building Code – 2023 Alberta Edition/;

export function pageTextFromItems(pdf_page: number, items: TextItem[]): PageText {
  const lines = toLines(positioned(items));

  const layout: string[] = [];
  const reading: string[] = [];
  let printed_page: string | null = null;
  let division: string | null = null;

  for (const cells of lines) {
    const joined = joinLine(cells);
    const after = joined.match(PRINTED_PAGE_AFTER_RE);
    const before = joined.match(PRINTED_PAGE_BEFORE_RE);
    if (after) {
      division = after[1];
      printed_page = after[2];
    } else if (before) {
      printed_page = before[1];
      division = before[2];
    } else {
      const d = joined.match(DIVISION_RE);
      if (d && !division) division = d[1];
    }
    if (BOILERPLATE_RE.test(joined)) continue;
    layout.push(layoutLine(cells));
    reading.push(joined);
  }

  return {
    pdf_page,
    reading: reading.join('\n'),
    layout,
    printed_page,
    division,
  };
}

export interface PdfDoc {
  numPages: number;
  page(n: number): Promise<PageText>;
}

/**
 * Open the code PDF. Uses the legacy build, which is the one that runs under
 * Node without a DOM.
 */
export async function openPdf(filePath: string): Promise<PdfDoc> {
  const { readFileSync } = await import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  return {
    numPages: doc.numPages,
    async page(n: number) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const items = tc.items.filter((i): i is TextItem => 'str' in i);
      const out = pageTextFromItems(n, items);
      page.cleanup();
      return out;
    },
  };
}
