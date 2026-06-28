// Load all code_rules once per analysis via the service-role client. The rule
// set is small (tens of rows), so we fetch everything and filter in memory in
// the runner rather than issuing a query per element.

import { supabaseAdmin } from '../supabase';
import type { CodeRule, RuleConditions } from './types';

export async function loadRules(): Promise<CodeRule[]> {
  const { data, error } = await supabaseAdmin
    .from('code_rules')
    .select(
      'id, section, title, part, jurisdiction, element_type, attribute, operator, value, value_max, conditions, severity, message',
    );

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[rule-engine] failed to load code_rules', error.message);
    return [];
  }

  return (data ?? []).map((r) => ({
    id: r.id,
    section: r.section,
    title: r.title ?? null,
    part: r.part ?? null,
    jurisdiction: r.jurisdiction ?? 'NBC_Alberta_2019',
    element_type: r.element_type,
    attribute: r.attribute,
    operator: r.operator,
    value: Number(r.value),
    value_max: r.value_max != null ? Number(r.value_max) : null,
    conditions: (r.conditions ?? {}) as RuleConditions,
    severity: r.severity,
    message: r.message,
  }));
}
