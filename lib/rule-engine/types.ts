// Deterministic rule engine types. A CodeRule mirrors a row in the code_rules
// table (supabase/migrations/005_rules_engine.sql); a NormalizedElement is the
// flattened, numeric-attribute view of an ExtractedSheet that the runner checks.

export type RuleOperator = 'gte' | 'lte' | 'eq' | 'between';

export type ElementType = 'stair' | 'door' | 'corridor' | 'room' | 'egress' | 'guard';

export interface RuleConditions {
  occupancy_type?: string;
  building_part?: 'Part3' | 'Part9';
}

export interface CodeRule {
  id: string;
  section: string;
  title: string | null;
  part: string | null;
  jurisdiction: string;
  element_type: ElementType;
  attribute: string;
  operator: RuleOperator;
  value: number;
  value_max: number | null;
  conditions: RuleConditions;
  severity: 'critical' | 'major' | 'minor';
  message: string;
}

export interface NormalizedElement {
  type: ElementType;
  id: string; // e.g. "stair#0", "door@Main Entry"
  sheet: string;
  attributes: Record<string, number>;
  occupancy?: string;
  building_part?: 'Part3' | 'Part9';
}
