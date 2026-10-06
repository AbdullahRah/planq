// Deterministic analysis core.
//
// The embedding-retrieval compliance path (Qdrant-style pgvector search, rerank,
// an LLM that wrote its own citations) is gone: PLANQ_SPEC.md §2.1 replaces it
// with a structured clause store plus a rules engine, and §G4 forbids a model
// from producing a pass or fail by arithmetic. What remains here is the part
// that was always deterministic.
//
// The staged pipeline (S0 intake, S1 applicability, S2 extraction, S3 rules,
// S4 adversarial verify, S5 report) lands on top of this; see §4 and §11.

import { isDiagnosticMarker, totalAnnotationCount } from './annotations';
import type { ExtractedSheet, Violation } from './types';
import type { BuildingPart } from './rule-engine/occupancy';
import { loadRules } from './rule-engine/loadRules';
import { runRuleEngine, type RuleEngineOutput } from './rule-engine/runner';

export function sheetHasUsableData(sheet: ExtractedSheet): boolean {
  if (
    sheet.rooms.length > 0 ||
    sheet.doors.length > 0 ||
    sheet.corridors.length > 0 ||
    sheet.stairs.length > 0 ||
    sheet.egress_paths.length > 0 ||
    sheet.dimensions.length > 0
  ) {
    return true;
  }
  // Bucketed annotations can carry rescued data even when structured fields
  // are empty — but the pipeline also writes its own failure markers into
  // `other`, and those must not count. A sheet whose only annotation is
  // "EXTRACT_EMPTY: pdf renderer produced no page images" read as usable, so a
  // sheet that could not be read went to the compliance pass anyway and the
  // model wrote findings about a plan it had never seen.
  const markers = sheet.annotations.other.filter(isDiagnosticMarker).length;
  return totalAnnotationCount(sheet.annotations) - markers > 0;
}

/**
 * Collapse repeat findings. A multi-page sheet is merged into one extraction, so
 * the same corridor or door often appears once per page; the UI showed those as
 * separate violations and inflated every count.
 */
export function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = [
      v.type,
      (v.affected_sheets ?? []).join(','),
      v.section_id ?? '',
      (v.location_hint ?? '').toLowerCase().trim(),
      v.description.toLowerCase().replace(/\s+/g, ' ').trim(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Deterministic compliance pass: load the code_rules table and evaluate the
 * sheet's extracted measurements arithmetically. Never throws — an empty or
 * unpopulated rules table just yields no violations.
 */
export async function ruleEnginePass(
  sheet: ExtractedSheet,
  opts: { buildingPart?: BuildingPart } = {},
): Promise<RuleEngineOutput> {
  const empty: RuleEngineOutput = { violations: [], coveredSections: new Set(), skipped: [] };
  if (!sheetHasUsableData(sheet)) return empty;
  const rules = await loadRules();
  if (rules.length === 0) return empty;
  return runRuleEngine(sheet, rules, opts.buildingPart);
}
