#!/usr/bin/env ts-node
// Harness for the TypeSafe verification gate — no network, no credits, no Jev
// calls. The judgements below are the shapes lib/verify.ts gets back from
// jev-latest; this is where a threshold change or a policy change gets caught.
//
// lib/supabase.ts builds its client at module load and throws on an empty URL,
// so stub the env before importing the module under test.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'stub-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-key';
// verificationEnabled() keys off this; the judge is injected, so no key is used.
process.env.TYPESAFE_API_KEY ||= 'stub-typesafe-key';

import { applyPolicy, codeTextForSection, planDataForSheet, verifyViolations, type Judgment } from '../lib/verify';
import { THRESHOLDS } from '../lib/typesafe';
import { emptyAnnotations } from '../lib/annotations';
import type { CodeChunk, ExtractedSheet, Violation } from '../lib/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SHEET: ExtractedSheet = {
  sheet_name: 'A-101.pdf',
  file_type: 'pdf',
  rooms: [{ name: 'BEDROOM 2', dimensions: '3000 mm x 3600 mm' }],
  doors: [{ location: 'D-1 bedroom', width: '762 mm' }],
  corridors: [{ location: 'main hall', width: '860 mm' }],
  stairs: [],
  egress_paths: [],
  dimensions: [],
  annotations: emptyAnnotations(),
  occupancy_type: 'Group C',
  building_type: 'single detached dwelling',
};

const CHUNKS: CodeChunk[] = [
  {
    id: 'c1',
    section_id: '9.9.3.3',
    section_title: 'Width of Corridors',
    content: 'The unobstructed width of a public corridor shall be not less than 1 100 mm.',
  },
  {
    id: 'c2',
    section_id: '9.5.5',
    section_title: 'Doorway Sizes',
    content:
      'Doorways serving bathrooms shall have a width of not less than 610 mm. See also 9.9.3.3. for corridors.',
  },
  { id: 'c3', section_id: '3.4.3.2', section_title: 'Exit Width', content: 'Part 3 exit widths.' },
];

console.log('\ncodeTextForSection:');
{
  const t = codeTextForSection(CHUNKS, '9.9.3.3');
  check('returns the labelled section', t.includes('1 100 mm'));
  check(
    'also returns chunks whose body mentions the section',
    t.includes('bathrooms'),
    'the chunker mislabels chunks, so body mentions matter',
  );
  check('ignores unrelated sections', !t.includes('Part 3 exit widths'));
  check('unknown section yields nothing', codeTextForSection(CHUNKS, '7.1.2.3') === '');
  check('empty section id yields nothing', codeTextForSection(CHUNKS, '') === '');
}

console.log('\nplanDataForSheet:');
{
  const d = planDataForSheet(SHEET);
  check('keeps measurable elements', Array.isArray(d.doors) && (d.doors as unknown[]).length === 1);
  check('keeps occupancy', d.occupancy_type === 'Group C');
  check('drops annotation bulk', !('annotations' in d));
}

console.log('\napplyPolicy — a supported, grounded finding:');
{
  const p = applyPolicy({ relation: 'supports', relation_confidence: 0.93, grounded: 0.88 });
  check('is kept', p.action === 'keep');
  check('is marked verified', p.verification.verdict === 'verified');
  check('records the probabilities', p.verification.relation_confidence === 0.93);
}

console.log('\napplyPolicy — a contradicted finding:');
{
  const p = applyPolicy({ relation: 'contradicts', relation_confidence: 0.91, grounded: 0.9 });
  check('is dropped', p.action === 'drop');
  check('is marked contradicted', p.verification.verdict === 'contradicted');
  check('carries a reason', Boolean(p.verification.note));
}

console.log('\napplyPolicy — the cited section says nothing:');
{
  const p = applyPolicy({ relation: 'says_nothing', relation_confidence: 0.95, grounded: 0.9 });
  check('keeps the observation', p.action === 'strip_citation');
  check('is marked unsupported', p.verification.verdict === 'unsupported');
}

console.log('\napplyPolicy — the plan does not contain the element:');
{
  const p = applyPolicy({ relation: 'supports', relation_confidence: 0.99, grounded: 0.04 });
  check('is dropped even though the code supports it', p.action === 'drop');
  check('is marked ungrounded', p.verification.verdict === 'ungrounded');
}

console.log('\napplyPolicy — low confidence never decides alone:');
{
  const below = THRESHOLDS.citationAutoAccept - 0.01;
  const supports = applyPolicy({ relation: 'supports', relation_confidence: below, grounded: 0.9 });
  check('an unconfident "supports" is kept for review', supports.action === 'keep');
  check('and is not called verified', supports.verification.verdict === 'needs_review');

  const contra = applyPolicy({ relation: 'contradicts', relation_confidence: below, grounded: 0.9 });
  check('an unconfident "contradicts" does not delete a finding', contra.action === 'keep');
  check('and is flagged for review', contra.verification.verdict === 'needs_review');
}

console.log('\napplyPolicy — no citation to check:');
{
  const p = applyPolicy({ grounded: 0.9 });
  check('grounding alone can verify', p.action === 'keep' && p.verification.verdict === 'verified');
  const weak = applyPolicy({ grounded: 0.3 });
  check('weak grounding needs review', weak.verification.verdict === 'needs_review');
}

console.log('\napplyPolicy — an outage never deletes findings:');
{
  const p = applyPolicy({ error: 'connection reset' });
  check('is kept', p.action === 'keep');
  check('is marked unchecked', p.verification.verdict === 'unchecked');
  check('says why', (p.verification.note ?? '').includes('connection reset'));
}

console.log('\nverifyViolations end-to-end (injected judge):');
{
  const violations: Violation[] = [
    {
      type: 'compliance',
      severity: 'major',
      description: 'Corridor is 860 mm, below the 1 100 mm minimum.',
      section_id: '9.9.3.3',
      code_citation: 'NBC Part 9, 9.9.3.3',
      source: 'llm',
    },
    {
      type: 'compliance',
      severity: 'major',
      description: 'Bedroom door is 762 mm, below the required 900 mm.',
      section_id: '9.5.5',
      code_citation: 'NBC Part 9, 9.5.5',
      source: 'llm',
    },
    {
      type: 'compliance',
      severity: 'critical',
      description: 'The elevator lobby lacks a fire separation.',
      section_id: '9.9.3.3',
      code_citation: 'NBC Part 9, 9.9.3.3',
      source: 'llm',
    },
  ];

  const scripted: Record<string, Judgment> = {
    'Corridor is 860 mm, below the 1 100 mm minimum.': {
      relation: 'supports',
      relation_confidence: 0.94,
      grounded: 0.92,
      model: 'jev-1.13.0',
    },
    'Bedroom door is 762 mm, below the required 900 mm.': {
      // 9.5.5 states 610 mm for bathrooms — it does not carry a 900 mm rule.
      relation: 'contradicts',
      relation_confidence: 0.88,
      grounded: 0.85,
      model: 'jev-1.13.0',
    },
    'The elevator lobby lacks a fire separation.': {
      relation: 'says_nothing',
      relation_confidence: 0.9,
      grounded: 0.05,
      model: 'jev-1.13.0',
    },
  };

  verifyViolations(violations, SHEET, CHUNKS, async (v) => scripted[v.description]).then((out) => {
    check('the supported finding survives', out.violations.length === 1);
    check('it keeps its citation', out.violations[0]?.section_id === '9.9.3.3');
    check('it is marked verified', out.violations[0]?.verification?.verdict === 'verified');
    check('it records the model', out.violations[0]?.verification?.model === 'jev-1.13.0');
    check('two findings are removed', out.dropped.length === 2);
    check(
      'the ungrounded one is reported as such',
      out.dropped.some((d) => d.verification.verdict === 'ungrounded'),
    );
    check(
      'the contradicted one is reported as such',
      out.dropped.some((d) => d.verification.verdict === 'contradicted'),
    );
    check(
      'nothing is dropped without a stated reason',
      out.dropped.every((d) => Boolean(d.verification.note)),
    );

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
}
