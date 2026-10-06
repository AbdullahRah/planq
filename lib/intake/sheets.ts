// S0, intake and sheet inventory (PLANQ_SPEC.md §S0).
//
// §S0 says to keep the native text layer when the PDF has one. That matters
// more than it sounds: a native string is the verbatim text G2 demands, it
// carries an exact position for the region, and it needs no model to read. On
// the Chesnut set every value the review turns on is in the text layer, so the
// vision pass exists for drawings that lack one, not as the default.
//
// Rasterization and tiling are still produced for the S2 vision pass and for
// the evidence crops §S5 puts in the report.

import { createHash } from 'node:crypto';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

/** One positioned string as printed on a sheet. */
export interface SheetTextItem {
  text: string;
  /** Page coordinates, origin bottom-left, as the PDF stores them. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetInventory {
  /** Sheet number as printed, falling back to the page index. */
  number: string;
  title: string;
  /** The scale statement as printed. §S0 flags "not to scale" explicitly. */
  scale_statement: string | null;
  not_to_scale: boolean;
  /** Drawing units inferred from the level marks and dimension strings. */
  units: 'metric' | 'imperial' | 'dual' | 'unknown';
  size_pt: { width: number; height: number };
  pdf_page: number;
  text_items: SheetTextItem[];
  /** True when the sheet has a usable native text layer. */
  has_text_layer: boolean;
}

export interface IntakeResult {
  file_sha256: string;
  sheets: SheetInventory[];
  /**
   * Things a reviewer has to know before the set is used, not just logged.
   * §S0 calls out the educational-use title block because it is a licensing
   * problem for a client demo rather than a code problem.
   */
  warnings: string[];
}

const NOT_TO_SCALE_RE = /not\s+to\s+scale/i;
const SCALE_RE = /\bSCALE\s*[:=]?\s*1\s*[:/]\s*(\d+)/i;
const LICENCE_RE = /educational|personal use only|illegal by copyright|redistribute, resell/i;
// A bare apostrophe is not an imperial marker: grid lines are labelled A', B'.
// Requiring feet AND inches together, or an explicit word, stopped every metric
// sheet in the Chesnut set from being reported as units "unknown".
const IMPERIAL_RE = /\d+\s*'\s*-\s*\d+\s*"|\bft\b|\binches\b|\binch\b/i;
const METRIC_RE = /\bNPT\s*=|\bLEVEL\s*=|\d+\s*m\b|\bmm\b/i;

/** Sheet titles sit in the title block; these are the labels that precede them. */
const TITLE_HINT_RE = /^(Architectural floor plans|Elevation-Sections|FACADES AND SECTIONS|ARCHITECTURAL PLAN)$/i;

function pickTitle(items: SheetTextItem[], pdfPage: number): string {
  const hinted = items.find((i) => TITLE_HINT_RE.test(i.text.trim()));
  if (hinted) return hinted.text.trim();
  // Otherwise the largest text on the sheet is almost always its title.
  const biggest = [...items].sort((a, b) => b.height - a.height)[0];
  return biggest?.text.trim() || `Sheet ${pdfPage}`;
}

/**
 * Sheet number as printed. The Chesnut title block prints the label "Sheet
 * number" with the value beside it, so the number is the nearest short numeric
 * string to that label; failing that, the page index.
 */
function pickNumber(items: SheetTextItem[], pdfPage: number): string {
  const label = items.find((i) => /^Sheet$/i.test(i.text.trim()));
  if (label) {
    const near = items
      .filter((i) => /^\d{1,3}$/.test(i.text.trim()))
      .map((i) => ({ i, d: Math.hypot(i.x - label.x, i.y - label.y) }))
      .sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 120) return near.i.text.trim();
  }
  return String(pdfPage).padStart(2, '0');
}

/**
 * Metric, imperial, or both.
 *
 * "Both" is the case that matters and it is common on North American sets: the
 * Chesnut sheets print 10.00 m [32'-9 3/4" ft]. A dual-dimensioned drawing is
 * not ambiguous to a reader, but it is a trap for an extractor - take the
 * bracketed imperial figure for the metric one and every comparison is out by a
 * factor of 3.28. Reporting 'dual' lets the extractor require an explicit unit
 * on each value rather than assuming the sheet's.
 */
function detectUnits(all: string): SheetInventory['units'] {
  const imperial = IMPERIAL_RE.test(all);
  const metric = METRIC_RE.test(all);
  if (metric && imperial) return 'dual';
  if (metric) return 'metric';
  if (imperial) return 'imperial';
  return 'unknown';
}

export function inventoryFromItems(
  pdfPage: number,
  items: TextItem[],
  size: { width: number; height: number },
): SheetInventory {
  const text_items: SheetTextItem[] = items
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({
      text: i.str,
      x: i.transform[4],
      y: i.transform[5],
      width: i.width,
      height: i.height || 8,
    }));

  const all = text_items.map((i) => i.text).join(' ');
  const scaleMatch = all.match(SCALE_RE);
  const notToScale = NOT_TO_SCALE_RE.test(all);

  return {
    number: pickNumber(text_items, pdfPage),
    title: pickTitle(text_items, pdfPage),
    scale_statement: notToScale ? 'Not to scale' : scaleMatch ? `1:${scaleMatch[1]}` : null,
    not_to_scale: notToScale,
    units: detectUnits(all),
    size_pt: size,
    pdf_page: pdfPage,
    text_items,
    // A drawing exported without a text layer yields a handful of stray items
    // at most; a real one yields hundreds.
    has_text_layer: text_items.length >= 20,
  };
}

/**
 * A sheet's text as visual rows, columns preserved with spacing.
 *
 * Reading order is useless for a schedule: the PDF interleaves "GROUND FLOOR:"
 * with unrelated title-block text, so a model handed the flat sequence paired
 * labels with the wrong figures and read the garden area as a storey. Rows keep
 * "GROUND FLOOR: 87.82 m2" together, which is how a person reads it.
 */
export function layoutLines(sheet: SheetInventory): string[] {
  const rows = new Map<number, SheetTextItem[]>();
  for (const i of sheet.text_items) {
    const key = Math.round(i.y / 6) * 6;
    const r = rows.get(key);
    if (r) r.push(i);
    else rows.set(key, [i]);
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top-down: PDF y grows upward
    .map(([, cells]) => {
      cells.sort((a, b) => a.x - b.x);
      let line = '';
      let cursor = 0;
      for (const c of cells) {
        const col = Math.round(c.x / 5);
        if (col > cursor) line += ' '.repeat(Math.min(col - cursor, 40));
        line += c.text.trim();
        cursor = col + c.text.trim().length;
      }
      return line.trimEnd();
    })
    .filter((l) => l.trim().length > 0);
}

export async function intake(filePath: string): Promise<IntakeResult> {
  const { readFileSync } = await import('node:fs');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const buf = readFileSync(filePath);
  const file_sha256 = createHash('sha256').update(buf).digest('hex');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;

  const sheets: SheetInventory[] = [];
  const warnings: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i): i is TextItem => 'str' in i);
    const sheet = inventoryFromItems(p, items, { width: vp.width, height: vp.height });
    sheets.push(sheet);

    const all = items.map((i) => i.str).join(' ');
    if (LICENCE_RE.test(all)) {
      warnings.push(
        `Sheet ${sheet.number}: the title block restricts this drawing to educational or personal use. It cannot be used in a client demo or redistributed.`,
      );
    }
    if (sheet.not_to_scale) {
      warnings.push(
        `Sheet ${sheet.number}: title block says "Not to scale". Nothing may be measured off this sheet; only printed dimension strings are usable.`,
      );
    }
    if (!sheet.has_text_layer) {
      warnings.push(
        `Sheet ${sheet.number}: no native text layer, so facts must come from the vision pass and carry its lower confidence.`,
      );
    }
    if (sheet.units === 'unknown') {
      warnings.push(`Sheet ${sheet.number}: drawing units could not be determined from the sheet.`);
    }
    if (sheet.units === 'dual') {
      warnings.push(
        `Sheet ${sheet.number}: dimensions are dual-unit (metric with imperial in brackets). Only values carrying their own unit are used; a bare number is treated as unreadable rather than assumed metric.`,
      );
    }
    page.cleanup();
  }

  // Deduplicate: the same licence notice sits on every sheet of a set.
  return { file_sha256, sheets, warnings: [...new Set(warnings)] };
}
