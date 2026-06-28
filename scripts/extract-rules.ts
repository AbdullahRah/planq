#!/usr/bin/env ts-node
// Draft extractor: scan the NBC Alberta 2019 PDF for Part 9 dimensional clauses
// and emit candidate rules to data/nbc-rules.draft.json. Output is NOISY and
// MUST be curated by hand into data/nbc-rules.json before ingest — a
// deterministic, always-high-confidence engine cannot run on unreviewed regex
// hits. See lib/rule-engine/.
import path from 'path';
import { promises as fs } from 'fs';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv();

const SECTION_RE = /\b9\.\d+(?:\.\d+){0,3}\b/g;
const DIM_RE = /(not\s+less\s+than|not\s+more\s+than|at\s+least|minimum|maximum|min\.|max\.)/i;
const MEASURE_RE = /(\d+(?:\.\d+)?)\s*(mm|m\b)/i;

interface Candidate {
  section: string;
  direction: 'min' | 'max' | 'unknown';
  value: number;
  unit: string;
  snippet: string;
}

function directionOf(clause: string): Candidate['direction'] {
  const l = clause.toLowerCase();
  if (/not\s+less\s+than|at\s+least|minimum|min\./.test(l)) return 'min';
  if (/not\s+more\s+than|maximum|max\./.test(l)) return 'max';
  return 'unknown';
}

async function main() {
  const pdfPath = path.resolve(
    process.cwd(),
    'data/2019NBCAE-V1_National_Building_Code2019_Alberta_Edition.pdf',
  );
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = await fs.readFile(pdfPath);
  const parsed = await pdfParse(buffer);
  const text = parsed.text ?? '';
  console.log(`Parsed ${parsed.numpages} pages, ${text.length} chars.`);

  // Sentence-ish clauses, then keep only Part 9 dimensional ones.
  const clauses = text.split(/(?<=[.;:])\s+|\n{2,}/);
  const candidates: Candidate[] = [];
  let lastSection = '';

  for (const clause of clauses) {
    const secMatches = clause.match(SECTION_RE);
    if (secMatches) lastSection = secMatches[secMatches.length - 1];
    if (!DIM_RE.test(clause)) continue;
    const measure = clause.match(MEASURE_RE);
    if (!measure) continue;
    const value = Number(measure[1]) * (measure[2].toLowerCase() === 'm' ? 1000 : 1);
    candidates.push({
      section: lastSection || '9.?',
      direction: directionOf(clause),
      value,
      unit: 'mm',
      snippet: clause.replace(/\s+/g, ' ').trim().slice(0, 240),
    });
  }

  const outPath = path.resolve(process.cwd(), 'data/nbc-rules.draft.json');
  await fs.writeFile(outPath, JSON.stringify(candidates, null, 2));
  console.log(`Wrote ${candidates.length} candidate(s) to ${outPath}.`);
  console.log('NEXT: review + curate into data/nbc-rules.json, then `npm run ingest-rules`.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
