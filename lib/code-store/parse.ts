// Parse the NBC(AE) PDF into clause records (PLANQ_SPEC.md §5).
//
// Structure the document actually uses, learned from the body pages:
//
//   Section 9.8.      Stairs, Ramps, Handrails and Guards
//   9.8.1.            Application                      <- subsection
//   9.8.1.1.          General                          <- article
//      1)  Except as provided in Sentence (2) ...      <- sentence
//       a)  900 mm, or                                 <- clause
//
// A clause record is one sentence, so its id is article + "(n)", matching the
// "9.8.8.3.(1)" form §5 asks for. Sentences are what rules cite.

import { createHash } from 'node:crypto';
import type { PageText } from './extract';
import { parseTables, tablesByArticle, type ParsedTable } from './tables';
import { EDITION, PRINTING, type ClauseRecord } from '../schemas';

/** "9.8.1.1." followed by a title on the same line. Four numeric components. */
const ARTICLE_RE = /^(\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,2}\.)\s+(\S.*)$/;
/** "9.8.1." followed by a title. Three components. */
const SUBSECTION_RE = /^(\d{1,2}\.\d{1,2}\.\d{1,2}\.)\s+(\S.*)$/;
/** "Section 9.8.   Title" */
const SECTION_RE = /^Section\s+(\d{1,2}\.\d{1,2}\.)\s+(\S.*)$/;
/** A sentence opener: "1)" or "12)". */
const SENTENCE_RE = /^(\d{1,2})\)\s*(.*)$/;
/** A lettered clause under a sentence: "a)" / "ii)". */
const SUBCLAUSE_RE = /^([a-z]{1,2}|[ivx]{1,4})\)\s*(.*)$/;
/**
 * A page's running head: an article id and the division name in either order,
 * with nothing else on the line. Also matches a bare article id, which appears
 * on pages whose head carries no division.
 */
const RUNNING_HEAD_RE =
  /^(?:Division\s+[AB]\s+\d{1,2}\.[\d.]+\.|\d{1,2}\.[\d.]+\.\s+Division\s+[AB]|\d{1,2}\.[\d.]+\.)$/;
/** Cross references to other articles, sections or tables. */
const CROSS_REF_RE = /\b(?:Articles?|Sentences?|Subsections?|Sections?|Tables?|Clauses?)\s+((?:[A-Z]-)?\d{1,2}\.[\d.]*\d\.?(?:\([\d a-z]+\))?)/g;
/** Appendix note markers, e.g. "(See Note A-9.8.8.3.(1))". */
const NOTE_RE = /\(See\s+Note\s+(A-[\d.()]+)\)/g;

export interface ParsedPage {
  page: PageText;
  /** Article ids whose headings appear on this page. */
  articles: string[];
}

interface Accum {
  article: string;
  title: string;
  pdf_page: number;
  printed_page: string;
  division: string | null;
  sentences: Map<number, string[]>;
  order: number[];
}

function flush(acc: Accum | null, out: ClauseRecord[]): void {
  if (!acc) return;
  for (const n of acc.order) {
    const parts = acc.sentences.get(n);
    if (!parts) continue;
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const cross_refs = new Set<string>();
    for (const m of text.matchAll(CROSS_REF_RE)) cross_refs.add(m[1].replace(/\.$/, ''));
    const notes = new Set<string>();
    for (const m of text.matchAll(NOTE_RE)) notes.add(m[1]);

    out.push({
      id: `${acc.article}(${n})`,
      article: acc.article,
      title: acc.title,
      text,
      tables: [],
      notes: [...notes],
      cross_refs: [...cross_refs],
      pdf_page: acc.pdf_page,
      printed_page: acc.printed_page,
      edition: EDITION,
      printing: PRINTING,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }
}

/**
 * Parse a run of pages into clause records.
 *
 * Articles continue across page breaks, so the accumulator is not reset at a
 * page boundary; it is reset only when a new article heading appears.
 */
export function parseClauses(pages: PageText[]): {
  clauses: ClauseRecord[];
  articleTitles: Map<string, string>;
  tables: Map<string, ParsedTable[]>;
} {
  const clauses: ClauseRecord[] = [];
  const articleTitles = new Map<string, string>();
  let acc: Accum | null = null;
  let current: number | null = null;

  for (const page of pages) {
    for (const rawLine of page.reading.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // The running head pairs an article id with the division name, and the two
      // swap places by page parity ("9.8.8.3. Division B" on even pages,
      // "Division B 9.8.9.1." on odd). It is not a heading. Matching only the
      // Division-first order let the even-page head parse as an article whose
      // title was literally "Division B", which then swallowed the sentences
      // continuing from the previous page.
      if (RUNNING_HEAD_RE.test(line)) continue;

      const section = line.match(SECTION_RE);
      if (section) {
        flush(acc, clauses);
        acc = null;
        current = null;
        continue;
      }

      const article = line.match(ARTICLE_RE);
      if (article) {
        flush(acc, clauses);
        const id = article[1];
        const title = article[2].replace(/\s+/g, ' ').trim();
        articleTitles.set(id, title);
        acc = {
          article: id,
          title,
          pdf_page: page.pdf_page,
          printed_page: page.printed_page ?? '',
          division: page.division,
          sentences: new Map(),
          order: [],
        };
        current = null;
        continue;
      }

      // A subsection heading ends the previous article but starts no clauses.
      if (SUBSECTION_RE.test(line) && !ARTICLE_RE.test(line)) {
        flush(acc, clauses);
        acc = null;
        current = null;
        continue;
      }

      if (!acc) continue;

      const sentence = line.match(SENTENCE_RE);
      if (sentence) {
        const n = Number(sentence[1]);
        current = n;
        if (!acc.sentences.has(n)) {
          acc.sentences.set(n, []);
          acc.order.push(n);
        }
        if (sentence[2].trim()) acc.sentences.get(n)!.push(sentence[2].trim());
        continue;
      }

      if (current == null) continue;

      // Lettered sub-clauses and plain continuation lines both belong to the
      // sentence in progress. Sub-clause markers are kept: rules cite them.
      const sub = line.match(SUBCLAUSE_RE);
      acc.sentences.get(current)!.push(sub ? `${sub[1]}) ${sub[2]}`.trim() : line);
    }
  }

  flush(acc, clauses);

  // Attach each article's tables to every sentence of that article. Five of the
  // §6 rules read their threshold out of a table, so a clause record without
  // its table cannot support them.
  const byArticle = tablesByArticle(parseTables(pages));
  for (const c of clauses) {
    const tables = byArticle.get(c.article);
    if (tables) {
      c.tables = tables.map((t) => ({
        id: t.id,
        title: t.title,
        rows: t.rows,
        pdf_page: t.pdf_page,
      }));
    }
  }

  return { clauses, articleTitles, tables: byArticle };
}

// ---------------------------------------------------------------------------
// G1: corpus completeness
// ---------------------------------------------------------------------------

export class CorpusIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusIncompleteError';
  }
}

export interface G1Report {
  pdf_pages: number;
  clauses: number;
  articles: number;
  /** Articles cited by this build's rules that were not found in the parse. */
  missing_articles: string[];
}

/**
 * Fail closed when the parse does not match the source (§G1). The prototype's
 * failure this guards against: reading a truncated slice of the PDF and
 * concluding Part 9 was missing.
 */
export function assertCorpusComplete(
  report: G1Report,
  expectedPages: number,
  requiredArticles: string[],
): void {
  const problems: string[] = [];

  if (report.pdf_pages !== expectedPages) {
    problems.push(
      `page count is ${report.pdf_pages}, expected ${expectedPages} — the file is not the edition this build asserts`,
    );
  }
  if (report.missing_articles.length > 0) {
    problems.push(
      `${report.missing_articles.length} article(s) cited by rules are absent from the parsed index: ${report.missing_articles
        .slice(0, 12)
        .join(', ')}${report.missing_articles.length > 12 ? ', …' : ''}`,
    );
  }
  if (report.clauses === 0) {
    problems.push('no clauses parsed at all');
  }
  // A real Part 9 parse yields thousands of sentences. A few hundred means the
  // parser matched headings but dropped bodies, which looks like success.
  if (report.clauses > 0 && report.clauses < 2000) {
    problems.push(
      `only ${report.clauses} clauses parsed, which is too few for a ${expectedPages}-page code — the parser is dropping content`,
    );
  }

  if (problems.length > 0) {
    throw new CorpusIncompleteError(`corpus completeness check failed:\n  - ${problems.join('\n  - ')}`);
  }

  void requiredArticles;
}
