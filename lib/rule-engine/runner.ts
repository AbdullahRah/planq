// The deterministic core: evaluate normalized elements against code_rules and
// emit Violations in the existing shape (lib/types.ts). Always high-confidence —
// these are arithmetic comparisons, not model output.

import type { ExtractedSheet, Violation } from '../types';
import { flattenSheet, type FlattenNote } from './flatten';
import type { CodeRule, NormalizedElement } from './types';
import type { BuildingPart } from './occupancy';

function passes(value: number, rule: CodeRule): boolean {
  switch (rule.operator) {
    case 'gte':
      return value >= rule.value;
    case 'lte':
      return value <= rule.value;
    case 'eq':
      return value === rule.value;
    case 'between':
      return rule.value_max != null && value >= rule.value && value <= rule.value_max;
    default:
      return true;
  }
}

// Which NBC Part a rule belongs to. `conditions.building_part` wins when the row
// states it; otherwise fall back to the rule's own `part` column, because the
// seeded rule set (data/nbc-rules.json) carries part: "9" with no conditions —
// without this fallback every Part 9 housing limit fires on Part 3 buildings.
function rulePartOf(rule: CodeRule): 'Part3' | 'Part9' | undefined {
  if (rule.conditions?.building_part) return rule.conditions.building_part;
  if (rule.part === '9') return 'Part9';
  if (rule.part === '3') return 'Part3';
  return undefined;
}

// A rule applies to an element when the element_type matches and every stated
// condition (occupancy_type / building_part) is satisfied. Conditions referring
// to building_part are skipped when the element's part is unknown, so we don't
// silently drop checks for sheets with no stated occupancy.
function ruleApplies(rule: CodeRule, el: NormalizedElement): boolean {
  if (rule.element_type !== el.type) return false;
  const part = rulePartOf(rule);
  if (part && el.building_part && part !== el.building_part) return false;
  const cond = rule.conditions ?? {};
  if (cond.occupancy_type && el.occupancy) {
    if (!el.occupancy.toLowerCase().includes(cond.occupancy_type.toLowerCase())) return false;
  }
  return true;
}

function fillMessage(template: string, rule: CodeRule, value: number): string {
  return template
    .replace(/\{value\}/g, String(value))
    .replace(/\{min\}/g, String(rule.value))
    .replace(/\{max\}/g, rule.value_max != null ? String(rule.value_max) : '');
}

export interface RuleEngineOutput {
  violations: Violation[];
  // `${section}` keys covered by a deterministic finding, used to dedupe the LLM
  // pass so it doesn't re-report the same section for the same sheet.
  coveredSections: Set<string>;
  // Measurements the guardrails refused to evaluate, so an empty result can be
  // explained ("nothing flagged" vs "nothing was measurable").
  skipped: FlattenNote[];
}

export function runRuleEngine(
  sheet: ExtractedSheet,
  rules: CodeRule[],
  // Supplied when the Part was resolved outside the sheet text; see
  // lib/occupancy-resolve.ts. Undefined keeps the existing regex behaviour.
  partOverride?: BuildingPart,
): RuleEngineOutput {
  const skipped: FlattenNote[] = [];
  const elements = flattenSheet(sheet, skipped, partOverride);
  const violations: Violation[] = [];
  const coveredSections = new Set<string>();
  // A multi-page sheet merges every page's extraction into one array, so the
  // same stair or door often appears several times. Collapse identical findings
  // (same rule, same element, same measured value) into one remark.
  const emitted = new Set<string>();

  for (const el of elements) {
    for (const rule of rules) {
      if (!ruleApplies(rule, el)) continue;
      const value = el.attributes[rule.attribute];
      if (value == null) continue; // attribute not present on this element
      if (passes(value, rule)) continue;

      const key = `${rule.id}|${el.type}|${el.id}|${value}`;
      if (emitted.has(key)) continue;
      emitted.add(key);

      coveredSections.add(rule.section);
      violations.push({
        type: 'compliance',
        severity: rule.severity,
        description: fillMessage(rule.message, rule, value),
        section_id: rule.section,
        code_citation: `NBC ${rule.jurisdiction} Part ${rule.part ?? '9'}, ${rule.section}${
          rule.title ? ` — ${rule.title}` : ''
        }`,
        affected_sheets: [sheet.sheet_name],
        location_hint: el.id,
        source: 'rule_engine',
      });
    }
  }

  return { violations, coveredSections, skipped };
}
