#!/usr/bin/env ts-node
// Populate the code_rules table from the curated data/nbc-rules.json. Follows
// the scripts/ingest.ts pattern: load env first, lazy-import the admin client,
// upsert by id so re-runs are idempotent.
import path from 'path';
import { promises as fs } from 'fs';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv();

const OPERATORS = new Set(['gte', 'lte', 'eq', 'between']);
const SEVERITIES = new Set(['critical', 'major', 'minor']);

interface RuleRow {
  id: string;
  section: string;
  title?: string | null;
  part?: string | null;
  jurisdiction?: string;
  element_type: string;
  attribute: string;
  operator: string;
  value: number;
  value_max?: number | null;
  conditions?: Record<string, unknown>;
  severity: string;
  message: string;
}

function validate(r: RuleRow, i: number): string[] {
  const errs: string[] = [];
  if (!r.id) errs.push(`[${i}] missing id`);
  if (!r.section) errs.push(`[${i}] missing section`);
  if (!r.element_type) errs.push(`[${i}] missing element_type`);
  if (!r.attribute) errs.push(`[${i}] missing attribute`);
  if (!OPERATORS.has(r.operator)) errs.push(`[${i}] bad operator "${r.operator}"`);
  if (typeof r.value !== 'number') errs.push(`[${i}] value must be a number`);
  if (r.operator === 'between' && typeof r.value_max !== 'number') {
    errs.push(`[${i}] 'between' rule needs numeric value_max`);
  }
  if (!SEVERITIES.has(r.severity)) errs.push(`[${i}] bad severity "${r.severity}"`);
  if (!r.message) errs.push(`[${i}] missing message`);
  return errs;
}

async function main() {
  const filePath = path.resolve(process.cwd(), process.argv[2] ?? 'data/nbc-rules.json');
  const raw = await fs.readFile(filePath, 'utf8');
  const rules = JSON.parse(raw) as RuleRow[];
  if (!Array.isArray(rules)) throw new Error('nbc-rules.json must be a JSON array');

  const errors = rules.flatMap(validate);
  if (errors.length) {
    console.error('Validation failed:\n' + errors.join('\n'));
    process.exit(1);
  }

  const { supabaseAdmin } = await import('../lib/supabase');
  const rows = rules.map((r) => ({
    id: r.id,
    section: r.section,
    title: r.title ?? null,
    part: r.part ?? '9',
    jurisdiction: r.jurisdiction ?? 'NBC_Alberta_2019',
    element_type: r.element_type,
    attribute: r.attribute,
    operator: r.operator,
    value: r.value,
    value_max: r.value_max ?? null,
    conditions: r.conditions ?? {},
    severity: r.severity,
    message: r.message,
  }));

  const { error } = await supabaseAdmin.from('code_rules').upsert(rows, { onConflict: 'id' });
  if (error) {
    console.error('Upsert failed:', error.message);
    process.exit(1);
  }
  console.log(`Upserted ${rows.length} rule(s) into code_rules from ${path.basename(filePath)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
