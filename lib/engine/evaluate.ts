// S3, the rule engine (PLANQ_SPEC.md §S3).
//
// This is where a verdict is actually decided, and the guardrails that make the
// verdict trustworthy all live here:
//
//   G4  every numeric comparison runs in code, after unit normalization. The
//       model is never asked whether a number is too small.
//   G5  absence is not a result. A rule with no supporting fact yields
//       cant_determine, never pass and never fail.
//   G6  an unstable fact (present in only one of the two extraction runs, or
//       with differing values) cannot support a fail.
//   G8  a rule whose measured precision is below the gate cannot display fail;
//       its fails are reported as needs_confirmation.
//   G3  clause quotes are not authored here. The engine names clause ids and
//       the store supplies the text.
//
// Judgment rules are evaluated elsewhere: this module marks them pending so the
// caller can run the S3 model pass, which returns structure only.

import type {
  Applicability,
  Fact,
  Finding,
  FindingStatus,
  NegativeEvidence,
  Rule,
} from '../schemas';
import { mayDisplayFail } from '../schemas';
import { convert, UnitMismatchError } from './units';

export interface EvaluateInput {
  rules: Rule[];
  facts: Fact[];
  negative: NegativeEvidence[];
  applicability: Applicability;
  /** Resolves a named predicate in a rule's applies_when. Unknown name = not applicable. */
  predicates?: Record<string, boolean | undefined>;
}

export interface EvaluateOutput {
  findings: Finding[];
  /** Rules needing the S3 model pass before they produce a finding. */
  pending_judgment: Array<{ rule: Rule; fact_ids: string[] }>;
  /** Rules skipped because the building is out of their scope, with the reason. */
  skipped: Array<{ rule_id: string; reason: string }>;
}

function factNumber(f: Fact, toUnit: string): number | null {
  if (typeof f.value !== 'number') return null;
  // A fact with no unit is only usable when the rule's unit is dimensionless.
  if (!f.unit) return toUnit === 'count' || toUnit === 'ratio' ? f.value : null;
  try {
    return convert(f.value, f.unit, toUnit);
  } catch (err) {
    if (err instanceof UnitMismatchError) return null;
    throw err;
  }
}

function compare(
  value: number,
  test: { operator: string; value: number; value_max?: number },
): boolean {
  switch (test.operator) {
    case 'gte':
      return value >= test.value;
    case 'lte':
      return value <= test.value;
    case 'eq':
      return value === test.value;
    case 'between':
      return test.value_max != null && value >= test.value && value <= test.value_max;
    default:
      return false;
  }
}

/** Does this rule apply to this building at all? */
function applicability(
  rule: Rule,
  app: Applicability,
  predicates: Record<string, boolean | undefined>,
): { applies: boolean; reason?: string; unresolved?: string } {
  const when = rule.applies_when;
  if (when.code_part && !app.code_parts.includes(when.code_part)) {
    return {
      applies: false,
      reason: `rule is Part ${when.code_part}; this building is governed by Part ${app.code_parts.join(', ')}`,
    };
  }
  if (when.occupancy && !app.major_occupancy.toLowerCase().includes(when.occupancy.toLowerCase())) {
    return {
      applies: false,
      reason: `rule needs occupancy "${when.occupancy}"; this building is "${app.major_occupancy}"`,
    };
  }
  if (when.predicate) {
    const v = predicates[when.predicate];
    if (v === false) {
      return { applies: false, reason: `predicate ${when.predicate} is false for this building` };
    }
    if (v === undefined) {
      // An unresolved predicate must not produce a verdict.
      //
      // This previously let the rule run, on the reasoning that a missing fact
      // would land it on cant_determine anyway. That was wrong, and it showed:
      // door-width-entrance requires its 810 mm threshold only for a door
      // serving a required entrance or stair, so with the predicate unresolved
      // every 800 mm bathroom and closet door in the set was reported as 10 mm
      // short of a requirement that does not apply to it. A rule whose scope is
      // unknown yields cant_determine for the facts it would have judged, which
      // is what §G5 means by absence not being a result.
      return { applies: true, unresolved: when.predicate };
    }
  }
  return { applies: true };
}

/**
 * §G8. A rule below the precision gate may not show a fail, so its fail is
 * reported one step down, where a reviewer decides.
 */
function gate(status: FindingStatus, rule: Rule): FindingStatus {
  if (status !== 'fail') return status;
  return mayDisplayFail(rule) ? 'fail' : 'needs_confirmation';
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `F${seq}`;
}

export function resetFindingIds(): void {
  seq = 0;
}

export function evaluate(input: EvaluateInput): EvaluateOutput {
  const { rules, facts, negative, applicability: app } = input;
  const predicates = input.predicates ?? {};

  const findings: Finding[] = [];
  const pending_judgment: EvaluateOutput['pending_judgment'] = [];
  const skipped: EvaluateOutput['skipped'] = [];

  const negByRule = new Map(negative.map((n) => [n.rule_id, n]));

  for (const rule of rules) {
    const scope = applicability(rule, app, predicates);
    if (!scope.applies) {
      skipped.push({ rule_id: rule.id, reason: scope.reason ?? 'not applicable' });
      continue;
    }
    const unresolved = scope.unresolved;

    const base = {
      rule_id: rule.id,
      clause_ids: rule.clause_ids,
      // Quotes are filled by the caller from the store (§G3). The engine never
      // writes clause text.
      clause_quotes: [] as string[],
      required_action: rule.required_action,
      verifier: 'not_run' as const,
      reviewer_state: 'unreviewed' as const,
      evidence_crops: [] as string[],
    };

    // ---- judgment: needs the model, handled by the caller -----------------
    if (rule.test.kind === 'judgment') {
      const relevant = facts.filter((f) => rule.test.kind === 'judgment' && rule.test.fact_kinds.includes(f.kind));
      pending_judgment.push({ rule, fact_ids: relevant.map((f) => f.id) });
      continue;
    }

    // ---- presence: is the required information on the drawings at all? ----
    if (rule.test.kind === 'presence') {
      const required = rule.test.fact_kinds;
      const have = required.filter((k) => facts.some((f) => f.kind === k));
      const missing = required.filter((k) => !have.includes(k));

      if (missing.length > 0) {
        const neg = negByRule.get(rule.id);
        findings.push({
          ...base,
          id: nextId(),
          status: 'cant_determine',
          summary: `${rule.title}: the drawings do not show ${missing.join(', ')}.`,
          fact_ids: facts.filter((f) => have.includes(f.kind)).map((f) => f.id),
          computed: { missing: missing.join(', '), searched: neg?.searched_for.join(', ') ?? '' },
          drawing_reference: neg?.sheets_searched.join(', '),
        });
        continue;
      }

      const supporting = facts.filter((f) => required.includes(f.kind));
      findings.push({
        ...base,
        id: nextId(),
        status: unresolved ? 'cant_determine' : 'pass',
        summary: `${rule.title}: the required information is stated on the drawings.`,
        fact_ids: supporting.map((f) => f.id),
        computed: { stated: required.join(', ') },
        drawing_reference: drawingRef(supporting),
      });
      continue;
    }

    // ---- consistency: the same measurement across sheets must agree -------
    if (rule.test.kind === 'consistency') {
      const relevant = facts.filter((f) => rule.test.kind === 'consistency' && f.kind === rule.test.fact_kind);
      const bySheet = new Map<string, typeof relevant>();
      for (const f of relevant) {
        const key = f.provenance === 'drawing_text' ? f.sheet : (f.container ?? 'ifc');
        const list = bySheet.get(key);
        if (list) list.push(f);
        else bySheet.set(key, [f]);
      }

      if (bySheet.size < 2) {
        // One sheet cannot disagree with itself. §G5: that is not a pass.
        findings.push({
          ...base,
          id: nextId(),
          status: 'cant_determine',
          summary: `${rule.title}: the measurement appears on ${bySheet.size} sheet(s), so it cannot be cross-checked.`,
          fact_ids: relevant.map((f) => f.id),
          computed: { sheets: [...bySheet.keys()].join(', ') || 'none' },
          drawing_reference: drawingRef(relevant),
        });
        continue;
      }

      const values = [...bySheet.entries()].map(([sheet, fs]) => ({
        sheet,
        value: typeof fs[0].value === 'number' ? fs[0].value : NaN,
        fact: fs[0],
      }));
      const distinct = new Set(values.map((v) => v.value));

      if (distinct.size > 1) {
        findings.push({
          ...base,
          id: nextId(),
          status: 'drawing_conflict',
          summary: `${rule.title}: ${values.map((v) => `sheet ${v.sheet} shows ${v.value}`).join(', ')}. The sheets disagree.`,
          fact_ids: values.map((v) => v.fact.id),
          computed: Object.fromEntries(values.map((v) => [`sheet_${v.sheet}`, v.value])),
          drawing_reference: values.map((v) => `Sheet ${v.sheet}`).join(', '),
        });
      } else {
        findings.push({
          ...base,
          id: nextId(),
          status: 'pass',
          summary: `${rule.title}: every sheet shows ${[...distinct][0]}.`,
          fact_ids: values.map((v) => v.fact.id),
          computed: { agreed: [...distinct][0] },
          drawing_reference: values.map((v) => `Sheet ${v.sheet}`).join(', '),
        });
      }
      continue;
    }

    // ---- numeric: the arithmetic case, §G4 --------------------------------
    if (rule.test.kind !== 'numeric') continue;
    const test = rule.test;
    const candidates = facts.filter((f) => f.kind === test.fact_kind);

    if (candidates.length === 0) {
      // §G5: nothing measured is cant_determine, not pass.
      const neg = negByRule.get(rule.id);
      findings.push({
        ...base,
        id: nextId(),
        status: 'cant_determine',
        summary: `${rule.title}: no ${test.fact_kind.replace(/_mm$|_m2$/, '').replace(/_/g, ' ')} is shown on the drawings.`,
        fact_ids: [],
        computed: {
          required: `${test.operator} ${test.value}${test.value_max != null ? `-${test.value_max}` : ''} ${test.unit}`,
          searched: neg?.searched_for.join(', ') ?? '',
        },
        drawing_reference: neg?.sheets_searched.join(', '),
      });
      continue;
    }

    for (const fact of candidates) {
      // Scope unknown: record what was measured and what the threshold would be,
      // and let a reviewer or the S2 pass settle whether the rule applies.
      if (unresolved) {
        const value = factNumber(fact, test.unit);
        findings.push({
          ...base,
          id: nextId(),
          status: 'cant_determine',
          summary: `${rule.title}: ${subjectOf(fact)} is ${value == null ? fact.source_text : `${round(value)} ${test.unit}`}, but whether this rule applies depends on ${unresolved.replace(/_/g, ' ')}, which the drawings do not establish.`,
          fact_ids: [fact.id],
          computed: {
            measured: value == null ? String(fact.value) : round(value),
            required_if_applicable: `${test.value}${test.value_max != null ? ` to ${test.value_max}` : ''} ${test.unit}`,
            unresolved,
          },
          drawing_reference: drawingRef([fact]),
        });
        continue;
      }

      const value = factNumber(fact, test.unit);
      if (value == null) {
        findings.push({
          ...base,
          id: nextId(),
          status: 'cant_determine',
          summary: `${rule.title}: "${fact.source_text}" on ${subjectOf(fact)} could not be read as a ${test.unit} measurement.`,
          fact_ids: [fact.id],
          computed: { raw: String(fact.value), unit: fact.unit ?? '(none)' },
          drawing_reference: drawingRef([fact]),
        });
        continue;
      }

      const ok = compare(value, test);
      const required = `${test.value}${test.value_max != null ? ` to ${test.value_max}` : ''} ${test.unit}`;

      if (ok) {
        findings.push({
          ...base,
          id: nextId(),
          status: 'pass',
          summary: `${rule.title}: ${subjectOf(fact)} is ${round(value)} ${test.unit} against ${required}.`,
          fact_ids: [fact.id],
          computed: { measured: round(value), required },
          drawing_reference: drawingRef([fact]),
        });
        continue;
      }

      // §G6: an unstable fact cannot carry a fail.
      const status: FindingStatus = fact.stable ? 'fail' : 'needs_confirmation';
      findings.push({
        ...base,
        id: nextId(),
        status: gate(status, rule),
        summary: `${rule.title}: ${subjectOf(fact)} is ${round(value)} ${test.unit}, against a required ${required}.`,
        fact_ids: [fact.id],
        computed: {
          measured: round(value),
          required,
          shortfall: round(Math.abs(value - test.value)),
          ...(fact.stable ? {} : { stability: 'fact appeared in only one extraction run' }),
        },
        drawing_reference: drawingRef([fact]),
      });
    }
  }

  return { findings, pending_judgment, skipped };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function subjectOf(f: Fact): string {
  return f.subject || f.kind;
}

/** Where a reviewer should look: sheet for a drawing fact, container for geometry. */
function drawingRef(facts: Fact[]): string | undefined {
  const parts = new Set<string>();
  for (const f of facts) {
    if (f.provenance === 'drawing_text') parts.add(`Sheet ${f.sheet}`);
    else parts.add(f.container ? `${f.container} (IFC)` : 'IFC model');
  }
  return parts.size > 0 ? [...parts].join(', ') : undefined;
}

/**
 * §G3. Fill each finding's clause_quotes from the store, and drop any quote the
 * store does not contain. Called after evaluate() with the store's clause text.
 */
export function attachClauseQuotes(
  findings: Finding[],
  textFor: (clauseId: string) => string | undefined,
): Finding[] {
  return findings.map((f) => ({
    ...f,
    clause_quotes: f.clause_ids
      .map((id) => textFor(id))
      .filter((t): t is string => Boolean(t)),
  }));
}
