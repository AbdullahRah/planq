#!/usr/bin/env ts-node
// Live evaluation of the TypeSafe verification gate against the real NBC
// Alberta 2019 corpus in building_code_chunks.
//
// scripts/verify-test.ts proves the policy with scripted judgements. This
// proves the judgements themselves: eight findings go through the real gate,
// four of them sound and four planted to fail in a specific way. It calls the
// live Jev API and costs a few thousand input tokens.
//
//   npx ts-node --project tsconfig.scripts.json scripts/verify-eval.ts
//
// Each case declares the verdict a reviewer would give. The run prints the
// gate's verdict beside it so a disagreement is visible rather than averaged
// away, and exits non-zero if the gate got any case wrong.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '../lib/supabase';
import { codeTextForSection, judgeFinding, applyPolicy } from '../lib/verify';
import { emptyAnnotations } from '../lib/annotations';
import type { CodeChunk, ExtractedSheet, Violation } from '../lib/types';

// The plan every finding is judged against. Deliberately small, so a finding
// about anything not listed here should come back ungrounded.
const SHEET: ExtractedSheet = {
  sheet_name: 'A-201-egress.pdf',
  file_type: 'pdf',
  rooms: [{ name: 'STORAGE GARAGE', dimensions: '6000 mm x 6500 mm' }],
  doors: [{ location: 'D-4 bathroom', width: '710 mm' }],
  corridors: [{ location: 'public corridor, level 1', width: '860 mm' }],
  stairs: [],
  egress_paths: [],
  dimensions: [{ element: 'storage garage clear height', value: '1.8', unit: 'm' }],
  annotations: emptyAnnotations(),
  occupancy_type: 'Group C residential',
  building_type: 'row housing, 3 storeys',
};

type Verdict = 'verified' | 'unsupported' | 'contradicted' | 'ungrounded' | 'needs_review' | 'unchecked';

interface Case {
  id: string;
  planted: boolean;
  why: string;
  expect: Verdict;
  violation: Violation;
}

const CASES: Case[] = [
  {
    id: 'corridor_width',
    planted: false,
    why: '9.9.3.3 really does set 1 100 mm, and the plan really shows 860 mm',
    expect: 'verified',
    violation: {
      type: 'compliance',
      severity: 'major',
      description:
        'The public corridor on level 1 is 860 mm wide, below the 1 100 mm minimum width required for a public corridor.',
      section_id: '9.9.3.3',
      source: 'llm',
    },
  },
  {
    id: 'garage_clear_height',
    planted: false,
    why: 'clear height in a storage garage must be at least 2 m; the plan shows 1.8 m',
    expect: 'verified',
    violation: {
      type: 'compliance',
      severity: 'major',
      description:
        'The storage garage has a clear height of 1.8 m, below the 2 m minimum clear height required in exits and access to exits in storage garages.',
      section_id: '9.9.4.1',
      source: 'llm',
    },
  },
  {
    id: 'bathroom_door',
    planted: false,
    why: 'sound: 760 mm door on an 860 mm hallway, plan shows 710 mm — but the normative text is diluted by an explanatory Note, so it lands under the 0.8 cutoff and goes to a human',
    expect: 'needs_review',
    violation: {
      type: 'compliance',
      severity: 'major',
      description:
        'Bathroom door D-4 is 710 mm wide, below the 760 mm minimum door width required for a room containing residential bathroom facilities served by a minimum 860 mm hallway.',
      section_id: '9.5.5.3',
      source: 'llm',
    },
  },
  {
    id: 'corridor_inflated_limit',
    planted: true,
    why: 'PLANTED: states the corridor minimum as 1 500 mm when 9.9.3.3 says 1 100 mm',
    expect: 'contradicted',
    violation: {
      type: 'compliance',
      severity: 'critical',
      description:
        'The public corridor on level 1 is 860 mm wide, below the 1 500 mm minimum width required for a public corridor.',
      section_id: '9.9.3.3',
      source: 'llm',
    },
  },
  {
    id: 'corridor_cited_for_doors',
    planted: true,
    why: 'PLANTED: a real door observation citing the corridor-width section, which says nothing about it',
    expect: 'unsupported',
    violation: {
      type: 'compliance',
      severity: 'major',
      description:
        'Bathroom door D-4 is 710 mm wide, below the minimum width required for a doorway of this type.',
      section_id: '9.9.3.3',
      source: 'llm',
    },
  },
  {
    id: 'fire_separation_nonsequitur',
    planted: true,
    // Both legs reject this one: the cited section says nothing about fire
    // separations, and the plan carries no fire-separation data to have
    // observed. Grounding is checked first, so that is the verdict recorded.
    // corridor_cited_for_doors is the case that isolates the citation leg.
    why: 'PLANTED: a fire-separation claim citing the corridor-WIDTH section, on a plan with no fire-separation data',
    expect: 'ungrounded',
    violation: {
      type: 'compliance',
      severity: 'critical',
      description:
        'The public corridor on level 1 is not separated from the remainder of the floor area by a fire separation having a 1 h fire-resistance rating.',
      section_id: '9.9.3.3',
      source: 'llm',
    },
  },
  {
    id: 'stair_not_on_plan',
    planted: true,
    why: 'PLANTED: the plan contains no stairs at all, so there is nothing to have measured',
    expect: 'ungrounded',
    violation: {
      type: 'compliance',
      severity: 'major',
      description:
        'The interior stair has a run of 210 mm, below the 255 mm minimum run required for private stairs.',
      section_id: '9.8.4.2',
      source: 'llm',
    },
  },
  {
    id: 'room_not_on_plan',
    planted: true,
    why: 'PLANTED: there is no bedroom on this sheet',
    expect: 'ungrounded',
    violation: {
      type: 'compliance',
      severity: 'major',
      description:
        'Bedroom 3 has a floor area of 5.2 m², below the minimum area required for a bedroom.',
      section_id: '9.5.7.1',
      source: 'llm',
    },
  },
];

async function loadChunks(): Promise<CodeChunk[]> {
  // Stand in for a retrieval: every Part 9 chunk, so codeTextForSection has to
  // find the cited section the same way it does in production — including the
  // mislabelled chunks whose body belongs to a different section than the label.
  const { data, error } = await supabaseAdmin
    .from('building_code_chunks')
    .select('id, section_id, section_title, content')
    .like('section_id', '9.%')
    .limit(1200);
  if (error) throw new Error(`could not load chunks: ${error.message}`);
  return (data ?? []) as CodeChunk[];
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set — add it to .env.local');
    process.exit(1);
  }

  const chunks = await loadChunks();
  console.log(`loaded ${chunks.length} Part 9 chunks from building_code_chunks\n`);

  let correct = 0;
  let wrong = 0;
  const soundDeleted: string[] = [];
  const plantedPassed: string[] = [];
  const started = Date.now();

  for (const c of CASES) {
    const codeText = codeTextForSection(chunks, c.violation.section_id!);
    const judgment = await judgeFinding(c.violation, codeText, SHEET);
    const { action, verification } = applyPolicy(judgment);

    const hit = verification.verdict === c.expect;
    if (hit) correct += 1;
    else wrong += 1;

    // The two outcomes that actually matter, independent of label agreement:
    //   a sound finding must never be deleted;
    //   a planted finding must never pass as verified with its citation intact.
    if (!c.planted && action === 'drop') {
      soundDeleted.push(c.id);
    }
    if (c.planted && verification.verdict === 'verified' && action === 'keep') {
      plantedPassed.push(c.id);
    }

    const tag = c.planted ? 'planted' : 'sound  ';
    console.log(`${hit ? 'ok  ' : 'MISS'} ${c.id.padEnd(26)} ${tag}  expected=${c.expect.padEnd(13)} got=${verification.verdict.padEnd(13)} action=${action}`);
    console.log(`       ${c.why}`);
    console.log(
      `       relation=${verification.relation ?? '—'} conf=${verification.relation_confidence?.toFixed(2) ?? '—'} grounded=${verification.grounded?.toFixed(2) ?? '—'} codeText=${codeText.length}ch model=${verification.model ?? '—'}`,
    );
    if (judgment.error) console.log(`       ERROR: ${judgment.error}`);
    console.log();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`verdicts matched: ${correct}/${CASES.length} (${wrong} differed)`);
  console.log(
    `sound findings deleted:     ${soundDeleted.length === 0 ? 'none' : soundDeleted.join(', ')}`,
  );
  console.log(
    `planted findings passed:    ${plantedPassed.length === 0 ? 'none' : plantedPassed.join(', ')}`,
  );
  console.log(`${seconds}s total`);

  // A differing verdict is worth reading; a breach of either safety property
  // is what fails the run.
  const unsafe = soundDeleted.length > 0 || plantedPassed.length > 0;
  process.exit(unsafe ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
