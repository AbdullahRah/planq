#!/usr/bin/env ts-node
// Review a drawing set from the command line (PLANQ_SPEC.md §4).
//
//   npm run review data/Two-story-house-with-dining-room-in-back.pdf
//   npm run review -- --no-vision <pdf>      text layer only, no model vision
//   npm run review -- --no-verify <pdf>      skip S4, for a cheaper dry run
//   npm run review -- --out report.md <pdf>  write the S5 report
//   npm run review -- --deadline 280 <pdf>   stop starting work as the API route would
//   npm run review -- --budget 12 <pdf>      dollar ceiling, for a full permit set
//
// The pipeline itself is lib/review.ts, shared with the API route so the two
// cannot drift. This file is presentation only.

import path from 'path';
import { promises as fs } from 'fs';
import { config as loadEnv } from 'dotenv';

import { detectInputKind, runReview } from '../lib/review';
import { buildReport } from '../lib/stages/report';
import { BudgetExceededError, StageFailedError } from '../lib/stages/runner';
import { PART9_RULES } from '../lib/rules/part9';
import type { FindingStatus } from '../lib/schemas';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

const STATUS_ORDER: FindingStatus[] = [
  'fail',
  'drawing_conflict',
  'needs_confirmation',
  'cant_determine',
  'pass',
];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv.slice(2).find((a) => /\.(pdf|png|jpe?g|tiff?|webp)$/i.test(a));
  if (!file) {
    console.error(
      'usage: npm run review <drawing.pdf|image> [--no-vision] [--no-verify] [--out report.md]',
    );
    process.exit(1);
  }

  const kind = detectInputKind(file);
  if (!kind) {
    console.error(`${file} is not a PDF or a raster image. DWG and IFC are not supported yet.`);
    process.exit(1);
  }

  const outPath = opt('out');
  const absolute = path.resolve(process.cwd(), file);

  console.log(`Planq review  ${path.basename(file)}\n`);

  const result = await runReview({
    filePath: absolute,
    kind,
    name: path.basename(file),
    useVision: !flag('no-vision'),
    useVerify: !flag('no-verify'),
    ...(opt('deadline') ? { deadline: Date.now() + Number(opt('deadline')) * 1000 } : {}),
    ...(opt('budget') ? { budgetUsd: Number(opt('budget')) } : {}),
    onProgress: (stage, detail) => console.log(`${stage}  ${detail}`),
  });

  console.log(`\nrun ${result.run_id} · ${result.code_edition} · store ${result.code_store_hash.slice(0, 12)}`);

  for (const s of result.sheets) {
    console.log(
      `   sheet ${s.number}  "${s.title}"  ${s.scale_statement ?? 'no scale stated'}  ${s.units}  ${
        s.has_text_layer ? `${s.text_item_count} text items` : 'no text layer'
      }`,
    );
  }
  for (const w of result.warnings) console.log(`   ! ${w}`);

  if (result.declared_conventions.length > 0) {
    console.log(`\nNotation declared by the sheets:`);
    for (const d of result.declared_conventions) console.log(`   ${d}`);
  }
  if (result.assumed_conventions.length > 0) {
    console.log(`Notation assumed: ${result.assumed_conventions.join(', ')}`);
  }

  if (result.stopped_reason) {
    console.log(`\nSTOPPED: ${result.stopped_reason}`);
    console.log('Run status: needs_manual_review');
    printUsage(result);
    process.exit(0);
  }

  const app = result.applicability!;
  console.log(
    `\nApplicability: Part ${app.code_parts.join(', ')}, ${
      app.energy_path === 'NBC_9.36' ? 'Section 9.36' : 'NECB 2020'
    }, ${app.storeys} storeys, building area ${app.building_area_m2} m2 (confidence ${app.confidence.toFixed(2)})`,
  );
  for (const [k, v] of Object.entries(app.basis)) console.log(`   ${k}: ${v}`);

  console.log(`\nFacts read: ${result.facts.length}`);
  for (const f of result.facts) {
    console.log(
      `   ${f.stable ? ' ' : '~'} ${f.kind.padEnd(30)} ${String(f.value).padStart(7)} ${(f.unit ?? '').padEnd(5)} ${f.subject}`,
    );
  }

  console.log(
    `\nFindings: ${result.findings.length}   ${STATUS_ORDER.map((s) => `${s} ${result.counts[s]}`).join('   ')}`,
  );
  if (result.verification.checked > 0) {
    console.log(
      `Verifier: ${result.verification.checked} checked, ${result.verification.downgraded} downgraded, ${result.verification.skipped} could not be verified`,
    );
  }

  const sorted = [...result.findings].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  for (const f of sorted) {
    if (f.status === 'pass') continue;
    console.log(`\n${f.id.padEnd(4)} ${f.status.toUpperCase().padEnd(19)} ${f.rule_id}`);
    console.log(`     ${f.summary}`);
    console.log(
      `     clause ${f.clause_ids.join(', ')}${f.drawing_reference ? `   ${f.drawing_reference}` : ''}`,
    );
    if (f.verifier !== 'not_run') console.log(`     verifier: ${f.verifier}, ${f.verifier_reason}`);
  }

  printUsage(result);

  if (outPath) {
    const md = buildReport({
      projectName: path.basename(file, path.extname(file)),
      applicability: app,
      findings: result.findings,
      rules: PART9_RULES,
      audit: result.audit,
      intakeWarnings: result.warnings,
      assumedConventions: result.assumed_conventions,
      // §G9: nothing is released until a named reviewer approves it.
      signOff: null,
    });
    await fs.writeFile(path.resolve(process.cwd(), outPath), md);
    console.log(`\nReport written to ${outPath} (unreleased draft, §G9 sign-off pending)`);
  }
}

function printUsage(result: Awaited<ReturnType<typeof runReview>>): void {
  console.log(
    `\nUsage: ${result.audit.usage.length} model call(s), $${result.audit.total_cost_usd.toFixed(4)}`,
  );
  for (const u of result.audit.usage) {
    console.log(
      `   ${u.stage.padEnd(22)} ${u.model.padEnd(18)} in ${String(u.input_tokens).padStart(7)} out ${String(u.output_tokens).padStart(6)} cache ${String(u.cache_read_input_tokens).padStart(7)} $${u.cost_usd.toFixed(4)}`,
    );
  }
}

main().catch((err) => {
  if (err instanceof BudgetExceededError || err instanceof StageFailedError) {
    console.error(`\n${err.message}`);
    console.log('Run status: needs_manual_review');
    process.exit(2);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
