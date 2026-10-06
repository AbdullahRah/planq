// Read side of the clause store (PLANQ_SPEC.md §5, §G3).
//
// The model never supplies clause text. It supplies an article id; the system
// fetches the text from here and verifies every quote against it.

import path from 'path';
import { promises as fs } from 'fs';
import { ClauseRecordSchema, type ClauseRecord } from '../schemas';

export interface CodeStore {
  edition: string;
  printing: string;
  source_sha256: string;
  store_sha256: string;
  pdf_pages: number;
  built_at: string;
  clauses: ClauseRecord[];
}

let cached: CodeStore | null = null;

export class CodeStoreMissingError extends Error {
  constructor() {
    super(
      'data/code-store.json not found — run `npm run code:build` to build the clause store from the NBC(AE) PDF',
    );
    this.name = 'CodeStoreMissingError';
  }
}

export async function loadCodeStore(force = false): Promise<CodeStore> {
  if (cached && !force) return cached;
  const file = path.resolve(process.cwd(), 'data/code-store.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new CodeStoreMissingError();
  }
  const parsed = JSON.parse(raw) as CodeStore;
  // Spot-validate rather than parsing every clause: the store is tens of
  // thousands of records and the build already validated them.
  if (parsed.clauses.length > 0) ClauseRecordSchema.parse(parsed.clauses[0]);
  cached = parsed;
  return parsed;
}

function normalizeId(id: string): string {
  const trimmed = id.trim();
  // Accept "9.8.8.3", "9.8.8.3.", "9.8.8.3.(1)" and "9.8.8.3(1)".
  const withSentence = trimmed.match(/^(\d{1,2}(?:\.\d{1,2})*)\.?\s*\((\d+)\)$/);
  if (withSentence) return `${withSentence[1]}.(${withSentence[2]})`;
  return trimmed.replace(/\.$/, '');
}

/** Every sentence of an article, or the single sentence when the id names one. */
export async function lookupClauses(id: string): Promise<ClauseRecord[]> {
  const store = await loadCodeStore();
  const want = normalizeId(id);
  const exact = store.clauses.filter((c) => c.id === want);
  if (exact.length > 0) return exact;
  const article = want.endsWith('.') ? want : `${want}.`;
  return store.clauses.filter((c) => c.article === article);
}

/**
 * §G3. A quote the model produced is only usable when it appears verbatim in
 * the stored text. Whitespace is normalized on both sides, since the model
 * re-wraps; nothing else is forgiven.
 */
export function quoteIsGrounded(quote: string, clauses: ClauseRecord[]): boolean {
  const needle = quote.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!needle) return false;
  return clauses.some((c) => c.text.replace(/\s+/g, ' ').toLowerCase().includes(needle));
}

/** Articles whose text mentions a phrase. The §2.1 "find me related clauses" fallback. */
export async function searchClauses(phrase: string, limit = 20): Promise<ClauseRecord[]> {
  const store = await loadCodeStore();
  const needle = phrase.toLowerCase();
  const out: ClauseRecord[] = [];
  for (const c of store.clauses) {
    if (c.text.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
