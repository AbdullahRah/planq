// Table extraction (PLANQ_SPEC.md §5: "tables parse best from -layout").
//
// Five of the §6 rules read their threshold from a table rather than from
// sentence prose — the door sizes in Table 9.5.5.1. and the ceiling heights in
// Table 9.5.3.1. — so the clause store is incomplete without these.
//
// Shape in the source:
//
//     Table 9.5.5.1.
//     Size of Doors
//     Forming Part of Sentence 9.5.5.1.(1)
//     At Entrance to:                         Minimum Width, mm   Minimum Height, mm
//     Dwelling unit ... (required entrance)
//                                                   810                1 980
//     ...
//     Notes to Table 9.5.5.1.:
//
// Rows are ragged on purpose: a long label wraps and pushes its values onto the
// next visual line, so forcing a column count would drop values. Cells are kept
// as printed and the row stays as wide as it is.

import type { PageText } from './extract';
import type { TableRecord } from '../schemas';

const TABLE_START_RE = /^Table\s+((?:[A-Z]-)?\d{1,2}\.[\d.]*\d\.?)\s*$/;
const FORMING_PART_RE = /^Forming\s+Part\s+of\s+(?:Sentences?|Articles?|Clauses?)\s+([\d.()]+)/i;
const NOTES_RE = /^Notes?\s+to\s+Table/i;
/** A heading that ends the table: a new article, subsection or section. */
const HEADING_RE = /^(?:Section\s+)?\d{1,2}\.\d{1,2}\.[\d.]*\s+\S/;

/** Split a layout line into cells on runs of two or more spaces. */
function cells(line: string): string[] {
  return line
    .trim()
    .split(/\s{2,}/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export interface ParsedTable extends TableRecord {
  /** The sentence or article id this table forms part of, as printed. */
  forming_part_of: string | null;
}

/**
 * Pull every table out of a run of pages. A table may span a page break, so the
 * accumulator carries across pages and closes on a notes line or a heading.
 */
export function parseTables(pages: PageText[]): ParsedTable[] {
  const out: ParsedTable[] = [];
  let open: ParsedTable | null = null;
  let sawTitle = false;

  const close = () => {
    if (open && open.rows.length > 0) out.push(open);
    open = null;
    sawTitle = false;
  };

  for (const page of pages) {
    for (const raw of page.layout) {
      const line = raw.trimEnd();
      const trimmed = line.trim();
      if (!trimmed) continue;

      const start = trimmed.match(TABLE_START_RE);
      if (start) {
        close();
        open = {
          id: start[1].endsWith('.') ? start[1] : `${start[1]}.`,
          title: '',
          rows: [],
          pdf_page: page.pdf_page,
          forming_part_of: null,
        };
        sawTitle = false;
        continue;
      }

      if (!open) continue;

      if (NOTES_RE.test(trimmed)) {
        close();
        continue;
      }

      const forming = trimmed.match(FORMING_PART_RE);
      if (forming) {
        open.forming_part_of = forming[1].replace(/\.$/, '');
        continue;
      }

      // The line straight after "Table x.y.z." is the table's name.
      if (!sawTitle) {
        open.title = trimmed;
        sawTitle = true;
        continue;
      }

      // A new article or section heading means the table ended without a
      // notes line.
      if (HEADING_RE.test(trimmed)) {
        close();
        continue;
      }

      const row = cells(line);
      if (row.length > 0) open.rows.push(row);
    }
  }

  close();
  return out;
}

/** Flatten a table to searchable text, for the §6 threshold verification. */
export function tableText(t: TableRecord): string {
  return [t.title, ...t.rows.map((r) => r.join(' | '))].join('\n');
}

/**
 * Index tables by the article they belong to. A table's own id matches its
 * article ("Table 9.5.5.1." belongs to article "9.5.5.1."), and
 * `forming_part_of` confirms it; the id is the fallback when that line is
 * missing or wrapped oddly.
 */
export function tablesByArticle(tables: ParsedTable[]): Map<string, ParsedTable[]> {
  const byArticle = new Map<string, ParsedTable[]>();
  for (const t of tables) {
    const fromForming = t.forming_part_of?.match(/^(\d{1,2}(?:\.\d{1,2}){3})/);
    const article = fromForming ? `${fromForming[1]}.` : t.id;
    const list = byArticle.get(article);
    if (list) list.push(t);
    else byArticle.set(article, [t]);
  }
  return byArticle;
}
