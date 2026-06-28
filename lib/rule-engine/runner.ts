// The deterministic core: evaluate normalized elements against code_rules and
// emit Violations in the existing shape (lib/types.ts). Always high-confidence —
// these are arithmetic comparisons, not model output.

import type { ExtractedSheet, Violation } from '../types';
import { flattenSheet } from './flatten';
import type { CodeRule, NormalizedElement } from './types';

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

// A rule applies to an element when the element_type matches and every stated
// condition (occupancy_type / building_part) is satisfied. Conditions referring
// to building_part are skipped when the element's part is unknown, so we don't
// silently drop checks for sheets with no stated occupancy.
function ruleApplies(rule: CodeRule, el: NormalizedElement): boolean {
  if (rule.element_type !== el.type) return false;
  const cond = rule.conditions ?? {};
  if (cond.building_part && el.building_part && cond.building_part !== el.building_part) {
    return false;
  }
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
}

export function runRuleEngine(sheet: ExtractedSheet, rules: CodeRule[]): RuleEngineOutput {
  const elements = flattenSheet(sheet);
  const violations: Violation[] = [];
  const coveredSections = new Set<string>();

  for (const el of elements) {
    for (const rule of rules) {
      if (!ruleApplies(rule, el)) continue;
      const value = el.attributes[rule.attribute];
      if (value == null) continue; // attribute not present on this element
      if (passes(value, rule)) continue;

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

  return { violations, coveredSections };
}
