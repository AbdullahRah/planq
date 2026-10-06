// The typed JSON contract between pipeline stages (PLANQ_SPEC.md §4, §5).
//
// Every stage reads and writes one of these and validates it. A failed
// validation retries once with the error appended, then the run stops as
// needs_manual_review (§4, §G11).

import { z } from 'zod';

export const EDITION = 'NBC(AE) 2023' as const;
export const PRINTING = 'second, April 2026 revisions' as const;

/** Expected page count of the NBC(AE) 2023 single-PDF file. G1 fails closed on a mismatch. */
export const NBCAE_2023_PAGES = 1578;

// ---------------------------------------------------------------------------
// Code store (§5)
// ---------------------------------------------------------------------------

export const TableRecordSchema = z.object({
  id: z.string(), // "9.5.5.1."
  title: z.string(),
  /** Rows as printed, each cell a trimmed string. Column count is not forced: footnote rows are ragged. */
  rows: z.array(z.array(z.string())),
  pdf_page: z.number().int().positive(),
});
export type TableRecord = z.infer<typeof TableRecordSchema>;

export const ClauseRecordSchema = z.object({
  id: z.string(), // "9.8.8.3.(1)"
  article: z.string(), // "9.8.8.3."
  title: z.string(),
  text: z.string(), // exact text, normalized whitespace only
  tables: z.array(TableRecordSchema).default([]),
  notes: z.array(z.string()).default([]),
  cross_refs: z.array(z.string()).default([]),
  pdf_page: z.number().int().positive(),
  printed_page: z.string(), // "9-30"
  edition: z.literal(EDITION),
  printing: z.literal(PRINTING),
  sha256: z.string().length(64),
});
export type ClauseRecord = z.infer<typeof ClauseRecordSchema>;

// ---------------------------------------------------------------------------
// Facts (§5)
// ---------------------------------------------------------------------------

/**
 * Where a fact's value came from. The spec's §S2 rule — only read printed
 * dimension strings, never measure — exists because pixel-measuring a raster
 * drawing is unreliable. It does not apply to parametric IFC geometry, which
 * carries exact numbers, so geometry facts are a distinct provenance kind
 * rather than drawing facts with a faked bounding box.
 */
export const FactProvenanceSchema = z.enum(['drawing_text', 'ifc_geometry']);
export type FactProvenance = z.infer<typeof FactProvenanceSchema>;

const FactBase = {
  id: z.string(),
  kind: z.string(), // "guard_height_mm", "door_width_mm", "riser_count", ...
  value: z.union([z.number(), z.string(), z.boolean()]),
  unit: z.string().optional(),
  subject: z.string(), // "rooftop terrace guard"
  /** Run index for the §G6 double extraction. Geometry facts are exact and always run 1. */
  run: z.union([z.literal(1), z.literal(2)]),
  stable: z.boolean(),
};

/** A value read verbatim off a drawing sheet. Needs sheet, region and source text (§G2). */
export const DrawingFactSchema = z.object({
  ...FactBase,
  provenance: z.literal('drawing_text'),
  sheet: z.string(), // "02"
  tile: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  source_text: z.string().min(1), // verbatim from the sheet
});

/** A value queried out of an IFC model. The entity path replaces the bbox as evidence. */
export const IfcFactSchema = z.object({
  ...FactBase,
  provenance: z.literal('ifc_geometry'),
  /** "IfcDoor#1842.OverallWidth" — reproducible by re-querying the model. */
  entity_path: z.string().min(1),
  ifc_global_id: z.string().min(1),
  /** The storey or spatial container, so a finding can still say where. */
  container: z.string().optional(),
  source_text: z.string().min(1), // "IfcDoor.OverallWidth=800"
});

export const FactSchema = z.discriminatedUnion('provenance', [DrawingFactSchema, IfcFactSchema]);
export type Fact = z.infer<typeof FactSchema>;
export type DrawingFact = z.infer<typeof DrawingFactSchema>;
export type IfcFact = z.infer<typeof IfcFactSchema>;

/**
 * Negative evidence (§S2). Recorded per rule so "not shown on the drawings" is
 * a fact the engine can act on, rather than an absence it has to guess about.
 * This is what turns most findings into cant_determine instead of a false pass.
 */
export const NegativeEvidenceSchema = z.object({
  rule_id: z.string(),
  searched_for: z.array(z.string()).min(1),
  not_found: z.array(z.string()),
  sheets_searched: z.array(z.string()),
});
export type NegativeEvidence = z.infer<typeof NegativeEvidenceSchema>;

// ---------------------------------------------------------------------------
// Applicability (§S1)
// ---------------------------------------------------------------------------

export const ApplicabilitySchema = z.object({
  major_occupancy: z.string(), // "Group C, residential"
  storeys: z.number().int().positive(),
  building_area_m2: z.number().positive(),
  /** Which technical Parts govern. A house is ["9"]. */
  code_parts: z.array(z.string()).min(1),
  edition: z.literal(EDITION),
  energy_path: z.enum(['NBC_9.36', 'NECB_2020']),
  confidence: z.number().min(0).max(1),
  /** The clause justifying each choice, keyed by the field it justifies. */
  basis: z.record(z.string(), z.string()),
  notes: z.array(z.string()).default([]),
});
export type Applicability = z.infer<typeof ApplicabilitySchema>;

// ---------------------------------------------------------------------------
// Findings (§5)
// ---------------------------------------------------------------------------

export const FindingStatusSchema = z.enum([
  'fail',
  'needs_confirmation',
  'drawing_conflict',
  'cant_determine',
  'pass',
]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const VerifierVerdictSchema = z.enum(['upheld', 'refuted', 'uncertain', 'not_run']);
export type VerifierVerdict = z.infer<typeof VerifierVerdictSchema>;

export const FindingSchema = z.object({
  id: z.string(), // "F1"
  rule_id: z.string(),
  status: FindingStatusSchema,
  summary: z.string().min(1),
  clause_ids: z.array(z.string()), // must exist in the code store
  clause_quotes: z.array(z.string()), // substring-verified against the store (§G3)
  fact_ids: z.array(z.string()), // must exist and be stable for a fail (§G6)
  computed: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  evidence_crops: z.array(z.string()).default([]),
  required_action: z.string(),
  verifier: VerifierVerdictSchema.default('not_run'),
  verifier_reason: z.string().optional(),
  reviewer_state: z.enum(['unreviewed', 'confirmed', 'dismissed']).default('unreviewed'),
  drawing_reference: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Statuses that §G7 sends to the adversarial verifier. */
export const VERIFIABLE_STATUSES: FindingStatus[] = ['fail', 'needs_confirmation'];

/**
 * One step down the severity ladder, for §G7: a finding the verifier could not
 * uphold must not keep its original strength. A fail becomes needs_confirmation;
 * anything weaker lands on cant_determine, which is the honest floor.
 */
export function downgrade(status: FindingStatus): FindingStatus {
  switch (status) {
    case 'fail':
      return 'needs_confirmation';
    case 'needs_confirmation':
    case 'drawing_conflict':
      return 'cant_determine';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Rules (§6)
// ---------------------------------------------------------------------------

export const NumericTestSchema = z.object({
  kind: z.literal('numeric'),
  fact_kind: z.string(),
  operator: z.enum(['gte', 'lte', 'eq', 'between']),
  /** Threshold in the fact's canonical unit. Transcribed by a human (§6). */
  value: z.number(),
  value_max: z.number().optional(),
  unit: z.string(),
});

export const JudgmentTestSchema = z.object({
  kind: z.literal('judgment'),
  /** The question put to the model. It returns structure only; §G4 keeps arithmetic in code. */
  question: z.string(),
  fact_kinds: z.array(z.string()),
});

/**
 * Two or more facts of the same kind that must agree across sheets.
 *
 * This was a judgment test, which was wrong: comparing a riser count of 16 on
 * the plan with 17 on the section is arithmetic, and §G4 says arithmetic runs
 * in code. Asking a model whether two numbers differ adds cost, latency and a
 * failure mode in exchange for nothing.
 */
export const ConsistencyTestSchema = z.object({
  kind: z.literal('consistency'),
  fact_kind: z.string(),
  /** Facts are only compared when they come from different sheets. */
  across: z.literal('sheets'),
});

export const PresenceTestSchema = z.object({
  kind: z.literal('presence'),
  /** Facts that must exist for a pass. Absence is cant_determine, never a pass (§G5). */
  fact_kinds: z.array(z.string()).min(1),
});

export const RuleTestSchema = z.discriminatedUnion('kind', [
  NumericTestSchema,
  JudgmentTestSchema,
  PresenceTestSchema,
  ConsistencyTestSchema,
]);

export const RuleSchema = z.object({
  id: z.string(), // "guard-height"
  clause_ids: z.array(z.string()).min(1),
  title: z.string(),
  /** Conditions checked in code before the rule runs at all (§S3). */
  applies_when: z
    .object({
      code_part: z.string().optional(),
      occupancy: z.string().optional(),
      /** Free-form predicate name resolved in the engine, e.g. "has_storage_garage". */
      predicate: z.string().optional(),
    })
    .default({}),
  test: RuleTestSchema,
  /** Where the human transcriber read the threshold, so a test can cite it (§6). */
  transcribed_from: z.object({
    printed_page: z.string(),
    pdf_page: z.number().int().positive(),
  }),
  required_action: z.string(),
  /**
   * Measured precision on the benchmark and when it was measured (§G8). Only a
   * rule at or above the gate may display `fail` automatically; everything else
   * is shown as needs_confirmation.
   */
  precision: z.number().min(0).max(1).nullable().default(null),
  precision_measured_at: z.string().nullable().default(null),
});
export type Rule = z.infer<typeof RuleSchema>;

/** §G8: the precision a rule must reach before its fails are shown as fails. */
export const PRECISION_GATE = 0.95;

export function mayDisplayFail(rule: Rule): boolean {
  return rule.precision != null && rule.precision >= PRECISION_GATE;
}

// ---------------------------------------------------------------------------
// Run audit trail (§G10)
// ---------------------------------------------------------------------------

export const StageUsageSchema = z.object({
  stage: z.string(),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative(),
  prompt_version: z.string(),
});
export type StageUsage = z.infer<typeof StageUsageSchema>;

export const RunAuditSchema = z.object({
  run_id: z.string(),
  input_file_hashes: z.record(z.string(), z.string()),
  code_edition: z.literal(EDITION),
  code_store_hash: z.string(),
  usage: z.array(StageUsageSchema).default([]),
  total_cost_usd: z.number().nonnegative().default(0),
  status: z.enum(['running', 'complete', 'needs_manual_review', 'over_budget']),
  started_at: z.string(),
  finished_at: z.string().nullable().default(null),
});
export type RunAudit = z.infer<typeof RunAuditSchema>;

// ---------------------------------------------------------------------------
// Validation helper (§4)
// ---------------------------------------------------------------------------

export class StageValidationError extends Error {
  constructor(
    readonly stage: string,
    readonly issues: string,
  ) {
    super(`[${stage}] schema validation failed: ${issues}`);
    this.name = 'StageValidationError';
  }
}

/**
 * Validate a stage's output. §4 allows exactly one retry with the validation
 * error appended to the prompt, so the caller gets the message to append rather
 * than a thrown-away error.
 */
export function validateStage<T extends z.ZodTypeAny>(
  stage: string,
  schema: T,
  value: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; error: StageValidationError } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: new StageValidationError(stage, issues) };
}
