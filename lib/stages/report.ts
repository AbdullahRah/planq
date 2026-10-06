// S5, the client report (PLANQ_SPEC.md §S5, §8, §G12).
//
// Written in code, not by a model. §S5 says the report generator may not
// introduce any claim that is not in a finding record, and the cheapest way to
// guarantee that is to assemble it from the records directly. A model asked to
// "write up these findings" will add a connective sentence that is a claim.
//
// §G12: no claim outside a finding record, no em dashes, and the §8 disclaimer
// carried on every report.

import type { Applicability, Finding, FindingStatus, RunAudit } from '../schemas';
import { mayDisplayFail, PRECISION_GATE, type Rule } from '../schemas';

export const DISCLAIMER =
  'This is a pre-submission review to help prepare a permit application. It is not a permit approval or a substitute for review by the authority having jurisdiction or a registered professional. Zoning, structural design, plumbing and electrical were not reviewed unless stated.';

const STATUS_LABEL: Record<FindingStatus, string> = {
  fail: 'Fail',
  needs_confirmation: 'Needs confirmation',
  drawing_conflict: 'Drawing conflict',
  cant_determine: "Can't determine",
  pass: 'Pass',
};

const STATUS_ORDER: FindingStatus[] = [
  'fail',
  'drawing_conflict',
  'needs_confirmation',
  'cant_determine',
  'pass',
];

export interface ReportInput {
  projectName: string;
  applicability: Applicability;
  findings: Finding[];
  rules: Rule[];
  audit: RunAudit;
  /** §S0 warnings: licensing, scale, missing text layer. */
  intakeWarnings: string[];
  /** Conventions the extractor assumed rather than read off the sheet. */
  assumedConventions: string[];
  /** §G9. Null until a named reviewer approves. */
  signOff: { reviewer: string; at: string } | null;
}

/** No em dashes anywhere in generated copy (§G12 and the spec's writing rule). */
function clean(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
}

function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const head = rows[0];
  const sep = head.map(() => '---');
  return [head, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export function buildReport(input: ReportInput): string {
  const { findings, applicability: app, rules, audit } = input;
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const counts = new Map<FindingStatus, number>();
  for (const f of findings) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);

  const sorted = [...findings].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );

  const out: string[] = [];

  out.push(`# Planq pre-submission code review: ${input.projectName}`);
  out.push('');
  out.push(
    `${app.edition} review. Code store ${audit.code_store_hash.slice(0, 12)}. Run ${audit.run_id}.`,
  );
  out.push('');

  // ---- review summary ---------------------------------------------------
  out.push('## Review summary');
  out.push('');
  out.push(
    table([
      ['Status', 'Count'],
      ...STATUS_ORDER.map((s) => [STATUS_LABEL[s], String(counts.get(s) ?? 0)]),
    ]),
  );
  out.push('');

  if (!input.signOff) {
    out.push(
      '> Not released. No report may be issued until a named reviewer has approved it. This draft is for that reviewer.',
    );
    out.push('');
  } else {
    out.push(`Approved by ${input.signOff.reviewer} on ${input.signOff.at}.`);
    out.push('');
  }

  // ---- applicability ----------------------------------------------------
  out.push('## Applicability determination');
  out.push('');
  out.push(
    table([
      ['Question', 'Determination', 'Basis'],
      ['Major occupancy', clean(app.major_occupancy), clean(app.basis.major_occupancy ?? '')],
      [
        'Storeys and building area',
        `${app.storeys} storeys, ${app.building_area_m2} m2 building area`,
        clean(app.basis.building_area ?? ''),
      ],
      ['Technical Part', `Part ${app.code_parts.join(', ')}`, clean(app.basis.code_parts ?? '')],
      [
        'Energy requirements',
        app.energy_path === 'NBC_9.36' ? 'Section 9.36' : 'NECB 2020',
        clean(app.basis.energy_path ?? ''),
      ],
    ]),
  );
  out.push('');
  out.push(`Confidence in this determination: ${(app.confidence * 100).toFixed(0)} percent.`);
  out.push('');

  // ---- findings table ---------------------------------------------------
  out.push('## Findings');
  out.push('');
  out.push(
    table([
      ['ID', 'Status', 'Finding', 'Code reference', 'Drawing reference', 'Action required'],
      ...sorted.map((f) => [
        f.id,
        STATUS_LABEL[f.status],
        clean(f.summary),
        f.clause_ids.join(', ') || 'internal check',
        clean(f.drawing_reference ?? 'not recorded'),
        f.status === 'pass' ? 'None' : clean(f.required_action),
      ]),
    ]),
  );
  out.push('');

  // ---- finding details --------------------------------------------------
  out.push('## Finding details');
  out.push('');
  for (const f of sorted) {
    out.push(`### ${f.id}. ${clean(f.summary)}`);
    out.push('');
    out.push(`**Status.** ${STATUS_LABEL[f.status]}`);
    out.push('');

    if (f.clause_quotes.length > 0) {
      out.push('**Requirement.**');
      for (let i = 0; i < f.clause_quotes.length; i++) {
        out.push(`> ${f.clause_ids[i] ?? ''}: ${f.clause_quotes[i]}`);
      }
      out.push('');
    }

    const computed = Object.entries(f.computed).filter(([, v]) => v !== '' && v != null);
    if (computed.length > 0) {
      out.push('**What the drawings show.**');
      out.push('');
      out.push(table([['Value', 'Reading'], ...computed.map(([k, v]) => [k.replace(/_/g, ' '), String(v)])]));
      out.push('');
    }

    if (f.status !== 'pass') {
      out.push(`**Fix.** ${clean(f.required_action)}`);
      out.push('');
    }

    // §G8: say when a status was held back because a rule is ungated.
    const rule = ruleById.get(f.rule_id);
    if (rule && !mayDisplayFail(rule) && f.status === 'needs_confirmation') {
      out.push(
        `**Why this is not reported as a failure.** The ${rule.id} rule has no measured precision on a benchmark yet, so it may not report a failure automatically. A reviewer decides. The gate is ${(PRECISION_GATE * 100).toFixed(0)} percent precision.`,
      );
      out.push('');
    }

    if (f.verifier !== 'not_run') {
      out.push(
        `**Independent check.** A second model was asked to refute this finding and returned "${f.verifier}". ${clean(f.verifier_reason ?? '')}`,
      );
      out.push('');
    }

    if (f.evidence_crops.length > 0) {
      for (const c of f.evidence_crops) out.push(`![evidence for ${f.id}](${c})`);
      out.push('');
    }
  }

  // ---- information required ---------------------------------------------
  const cantDetermine = sorted.filter((f) => f.status === 'cant_determine');
  if (cantDetermine.length > 0) {
    out.push('## Information required to complete the review');
    out.push('');
    out.push(
      'Each item below could not be assessed because the drawings do not show what the clause turns on. These are not failures; they are gaps that have to be closed before the review can reach a verdict.',
    );
    out.push('');
    out.push(
      table([
        ['ID', 'What is needed', 'Code reference'],
        ...cantDetermine.map((f) => [
          f.id,
          clean(f.required_action),
          f.clause_ids.join(', ') || 'internal check',
        ]),
      ]),
    );
    out.push('');
  }

  // ---- method and limits ------------------------------------------------
  out.push('## Method and limits');
  out.push('');
  out.push(
    `Findings come from a rule engine that compares values printed on the drawings against thresholds transcribed from ${app.edition}, ${audit.code_edition}. Every numeric comparison runs in code. A model reads the drawings and a second model is asked to refute each proposed failure, but no model decides whether a value passes or fails.`,
  );
  out.push('');
  out.push(
    'A missing value produces "Can\'t determine" and never a pass. A value read in only one of two extraction passes cannot support a failure.',
  );
  out.push('');

  if (input.intakeWarnings.length > 0) {
    out.push('**Intake warnings.**');
    out.push('');
    for (const w of input.intakeWarnings) out.push(`- ${clean(w)}`);
    out.push('');
  }

  if (input.assumedConventions.length > 0) {
    out.push('**Notation assumed rather than read.**');
    out.push('');
    out.push(
      'The drawings did not declare these in a legend, so the following meanings were assumed. A finding that depends on one of them should be checked by eye.',
    );
    out.push('');
    for (const a of input.assumedConventions) out.push(`- ${clean(a)}`);
    out.push('');
  }

  const ungated = rules.filter((r) => !mayDisplayFail(r));
  if (ungated.length > 0) {
    out.push(
      `**Precision gating.** ${ungated.length} of ${rules.length} rules have no measured precision yet and therefore cannot report a failure automatically. Their findings appear as "Needs confirmation" regardless of how clear the arithmetic is.`,
    );
    out.push('');
  }

  out.push('**Cost and usage.**');
  out.push('');
  out.push(
    table([
      ['Stage', 'Model', 'Input tokens', 'Output tokens', 'Cost USD'],
      ...audit.usage.map((u) => [
        u.stage,
        u.model,
        String(u.input_tokens),
        String(u.output_tokens),
        u.cost_usd.toFixed(4),
      ]),
      ['Total', '', '', '', audit.total_cost_usd.toFixed(4)],
    ]),
  );
  out.push('');

  out.push('## Disclaimer');
  out.push('');
  out.push(DISCLAIMER);
  out.push('');

  return out.join('\n');
}
