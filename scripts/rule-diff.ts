#!/usr/bin/env ts-node
// Validate data/nbc-rules.json against the ingested code corpus.
//
// The rule engine is deterministic and fast because its thresholds are
// hardcoded. That is also its failure mode: when the code corpus is updated to a
// new edition, the rules keep firing the old numbers while the RAG pass cites the
// new text, and the two halves of a compliance report quietly disagree. Nothing
// errors — the deterministic half is just confidently out of date.
//
// This script reports, per rule: whether its cited section still exists in the
// corpus, and whether its threshold still appears in that section's text. It
// never edits a rule; a mismatch is a prompt for a human to read the clause.
//
// Usage:
//   npm run rules:diff
//   npm run rules:diff -- --jurisdiction NBC-AE-2019
import path from 'path';
import fs from 'fs';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { supabaseAdmin } from '../lib/supabase';

interface Rule {
  id: string;
  section: string;
  title: string;
  element_type: string;
  attribute: string;
  operator: string;
  value?: number;
  value_max?: number;
}

interface Chunk {
  section_id: string | null;
  section_title: string | null;
  content: string | null;
  jurisdiction?: string | null;
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const jurisdiction = flag('jurisdiction');

/** Millimetre magnitudes present in a clause, however the code writes them. */
function magnitudesMm(text: string): number[] {
  const found = new Set<number>();
  const push = (n: number) => {
    if (Number.isFinite(n) && n > 0) found.add(Math.round(n * 100) / 100);
  };

  for (const m of text.matchAll(/(\d[\d\s,]*(?:\.\d+)?)\s*mm\b/gi)) {
    push(Number(m[1].replace(/[\s,]/g, '')));
  }
  // "2.4 m" and "1 200 mm" both appear in code text; normalise metres to mm.
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*m\b(?!m)/gi)) {
    push(Number(m[1]) * 1000);
  }
  return Array.from(found).sort((a, b) => a - b);
}

async function chunksForSection(section: string): Promise<Chunk[]> {
  let q = supabaseAdmin
    .from('building_code_chunks')
    .select('section_id, section_title, content, jurisdiction')
    .or(`section_id.eq.${section},section_id.like.${section}.%`);
  if (jurisdiction) q = q.eq('jurisdiction', jurisdiction);
  const { data, error } = await q.limit(20);
  if (error) {
    console.error(`  ! query failed for §${section}: ${error.message}`);
    return [];
  }
  return (data ?? []) as Chunk[];
}

(async () => {
  const rulesPath = path.resolve(process.cwd(), 'data/nbc-rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as Rule[];

  console.log(`Rules:  ${rulesPath} (${rules.length} rules)`);
  console.log(`Corpus: building_code_chunks${jurisdiction ? ` [jurisdiction=${jurisdiction}]` : ' [all jurisdictions]'}\n`);

  // Edition mixing check. Two editions in one table means retrieval returns
  // whichever embeds closer, so a citation is no longer reproducible.
  const { data: jRows } = await supabaseAdmin
    .from('building_code_chunks')
    .select('jurisdiction')
    .limit(10000);
  const jCounts = new Map<string, number>();
  for (const r of (jRows ?? []) as Chunk[]) {
    const k = r.jurisdiction ?? '(null)';
    jCounts.set(k, (jCounts.get(k) ?? 0) + 1);
  }
  if (jCounts.size > 1 && !jurisdiction) {
    console.log('WARNING: more than one jurisdiction tag is present in the corpus:');
    for (const [k, n] of jCounts) console.log(`  ${k}: ${n} chunks`);
    console.log('  Retrieval does not filter by jurisdiction, so citations may mix editions.');
    console.log('  Re-run with --jurisdiction <tag> to check one edition.\n');
  }

  let missing = 0;
  let mismatched = 0;
  let confirmed = 0;

  for (const rule of rules) {
    const chunks = await chunksForSection(rule.section);
    const wanted = [rule.value, rule.value_max].filter(
      (v): v is number => typeof v === 'number',
    );

    if (chunks.length === 0) {
      missing += 1;
      console.log(`MISSING   ${rule.id}`);
      console.log(`          §${rule.section} "${rule.title}" is not in the corpus.`);
      console.log(`          The rule still fires ${rule.operator} ${wanted.join('-')}mm with nothing to cite.\n`);
      continue;
    }

    const text = chunks.map((c) => `${c.section_title ?? ''}\n${c.content ?? ''}`).join('\n');
    const present = magnitudesMm(text);
    const hit = wanted.filter((w) => present.some((p) => Math.abs(p - w) < 0.5));

    if (hit.length === wanted.length) {
      confirmed += 1;
      console.log(`OK        ${rule.id}  §${rule.section}  ${wanted.join('-')}mm found in clause text`);
    } else {
      mismatched += 1;
      const absent = wanted.filter((w) => !hit.includes(w));
      console.log(`MISMATCH  ${rule.id}`);
      console.log(`          §${rule.section} "${rule.title}" exists, but ${absent.join(', ')}mm does not appear in it.`);
      console.log(`          Magnitudes in the clause: ${present.length > 0 ? present.join(', ') : '(none found)'}`);
      console.log(`          Read the clause and confirm the rule's threshold.\n`);
    }
  }

  console.log(`\n${confirmed} confirmed, ${mismatched} to review, ${missing} missing (of ${rules.length}).`);
  if (missing > 0 || mismatched > 0) {
    console.log('Nothing was changed. Update data/nbc-rules.json by hand after reading the clauses.');
  }
  // Review items are findings, not script failures — exit non-zero only when a
  // cited section is gone entirely, which means the corpus and rules disagree
  // about what the code even contains.
  process.exit(missing > 0 ? 1 : 0);
})();
