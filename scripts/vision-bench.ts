#!/usr/bin/env ts-node
// Compare extraction models on one sheet (S2 only, both passes).
//
//   npm run bench:vision -- data/Two-story-house-with-dining-room-in-back.pdf 01 \
//     openai/gpt-6-luna anthropic/claude-sonnet-5.5
//
// Prints facts read, how many were read the same way twice, cost and time per
// model. Models run one after another so their timings do not interfere.

import path from 'path';
import { config as loadEnv } from 'dotenv';

import { intake } from '../lib/intake/sheets';
import { readConventions } from '../lib/intake/legend';
import { readSheet } from '../lib/review';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main(): Promise<void> {
  const [pdf, sheetNo, ...models] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!pdf || !sheetNo || models.length === 0) {
    console.error('usage: vision-bench <pdf> <sheet number> <model> [model ...]');
    process.exit(1);
  }

  const { sheets } = await intake(pdf);
  const sheet = sheets.find((s) => s.number === sheetNo);
  if (!sheet) throw new Error(`no sheet ${sheetNo}; sheets are ${sheets.map((s) => s.number).join(', ')}`);
  const conventions = readConventions(sheets);

  const rows: string[] = [];
  for (const model of models) {
    process.env.PLANQ_MODEL_EXTRACTION = model;
    const t0 = Date.now();
    try {
      const r = await readSheet({ filePath: pdf, kind: 'pdf', sheet, conventions, budgetUsd: 2 });
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const cost = r.usage.reduce((s, u) => s + u.cost_usd, 0);
      const stable = r.facts.filter((f) => f.stable).length;
      rows.push(`${model.padEnd(40)} facts ${String(r.facts.length).padStart(3)}  stable ${String(stable).padStart(3)}  $${cost.toFixed(4)}  ${secs}s  calls ${r.usage.length}`);
      for (const f of r.facts) {
        console.log(`  ${model}  ${f.stable ? '=' : '~'} ${f.kind.padEnd(22)} ${String(f.value).padEnd(8)} ${f.unit ?? ''}  ${f.subject}  «${f.source_text}»`);
      }
    } catch (err) {
      rows.push(`${model.padEnd(40)} FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }

  console.log(`\nSheet ${sheetNo}, "${sheet.title}"`);
  for (const r of rows) console.log(r);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
