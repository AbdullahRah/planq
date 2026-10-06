// S1, applicability (PLANQ_SPEC.md §S1). Haiku.
//
// Decides which code Part governs and whether Section 9.36 or NECB governs
// energy. This is the most load-bearing single decision in a run: get the Part
// wrong and every rule that follows is drawn from the wrong body of the code.
//
// So the model is given the clause text that controls the decision rather than
// being asked to recall it, the numeric thresholds are compared in code (§G4),
// and low confidence stops the run (§S1) instead of guessing.

import { z } from 'zod';
import { ApplicabilitySchema, EDITION, type Applicability } from '../schemas';
import { layoutLines, type SheetInventory } from '../intake/sheets';
import { runStage, type RunLedger } from './runner';

const PROMPT_VERSION = 's1-2026-10-05';

/** What the model is asked for: observations, not the verdict. */
const ObservationsSchema = z.object({
  major_occupancy: z.string(),
  occupancy_group: z.string(),
  storeys_above_grade: z.number().int().min(0).max(60),
  /**
   * Per-storey areas as the schedule prints them. The footprint is computed
   * from these in code rather than asked for: asked directly for a building
   * area, the model returned the 200 m2 lot ("WIDTH 10.00 m, LENGTH 20.00 m,
   * TOTAL AREA 200.00 m2") instead of the largest storey.
   */
  storey_areas: z.array(z.object({ label: z.string(), area_m2: z.number().min(0) })),
  /** The site or lot, kept separate so it cannot be mistaken for the footprint. */
  site_area_m2: z.number().min(0).nullable(),
  has_storage_garage: z.boolean(),
  has_fuel_burning_appliance: z.boolean().nullable(),
  sprinklered: z.boolean().nullable(),
  /** Verbatim strings the above was read from, for the audit trail. */
  evidence: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  /** Anything contradictory on the sheets. §S1 stops the run on a conflict. */
  conflicts: z.array(z.string()),
});

const OBSERVATIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    major_occupancy: { type: 'string' },
    occupancy_group: { type: 'string' },
    storeys_above_grade: { type: 'integer' },
    storey_areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, area_m2: { type: 'number' } },
        required: ['label', 'area_m2'],
      },
    },
    site_area_m2: { type: ['number', 'null'] },
    has_storage_garage: { type: 'boolean' },
    has_fuel_burning_appliance: { type: ['boolean', 'null'] },
    sprinklered: { type: ['boolean', 'null'] },
    evidence: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    conflicts: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'major_occupancy',
    'occupancy_group',
    'storeys_above_grade',
    'storey_areas',
    'site_area_m2',
    'has_storage_garage',
    'has_fuel_burning_appliance',
    'sprinklered',
    'evidence',
    'confidence',
    'conflicts',
  ],
} as const;

const SYSTEM = `You read building drawings and report what they state about the building's size and use. You do not decide which code Part applies; that is computed from your observations.

Report only what the sheets state. Rules:

1. storey_areas lists one entry per storey the area schedule gives a figure for, using the schedule's own label, for example "GROUND FLOOR" or "FIRST LEVEL". Copy the figures; do not add them up and do not pick a winner. The building area is computed from this list, not by you.
2. Only list a row in storey_areas when it names a storey of the building. A garden, a lot, a site, a yard or a terrace is not a storey; leave those out.
3. site_area_m2 is the LOT or SITE area, the area of the property. It is a different thing from the area of the building and the two are easy to confuse: a schedule that prints "WIDTH 10.00 m", "LENGTH 20.00 m" and "TOTAL AREA 200.00 m2" is describing the lot, not the building. If the sheets give a lot area, put it here and nowhere else.
4. storeys_above_grade counts storeys above grade only. A basement listed at zero area is not a storey.
5. evidence must quote the verbatim strings you read these values from, such as an area schedule row or a title block line.
6. If the sheets state nothing about a field, use a conservative value and lower your confidence; do not invent a figure. Use null where the schema allows it and the sheets are silent.
7. If two sheets disagree, list the disagreement in conflicts. Do not pick a winner.
8. confidence is your confidence that these observations match the drawings, from 0 to 1.

Return only JSON matching the schema.`;

/**
 * The clause text that controls the decision, passed in rather than recalled.
 * Supplied by the caller from the code store so §G3's discipline holds here too:
 * the system owns the clause text, the model never writes it.
 */
export interface ApplicabilityClauses {
  /** Division A 1.3.3.3.(1), the Part 9 scope. */
  part9Scope: string;
  /** NECB 1.1.1.1.(1) scope, when available. */
  necbScope?: string;
}

export interface ApplicabilityResult {
  applicability: Applicability;
  /** Predicates the rule engine needs, answered from the same observations. */
  predicates: Record<string, boolean | undefined>;
  /** Set when §S1 requires a human before the run may continue. */
  stop?: string;
}

/** §1.3.3.3.(1) thresholds, transcribed by a human from the spec's §3. */
const PART9_MAX_STOREYS = 3;
const PART9_MAX_BUILDING_AREA_M2 = 600;
/** Below this, §S1 stops the run and asks a human. */
const MIN_CONFIDENCE = 0.6;

export async function determineApplicability(
  sheets: SheetInventory[],
  clauses: ApplicabilityClauses,
  ledger: RunLedger,
): Promise<ApplicabilityResult> {
  // Only the text, not the images: S1 reads schedules and title blocks, which
  // are text. The vision pass handles what is only visible graphically.
  //
  // Laid out in visual rows rather than reading order. The flat sequence
  // interleaves the area schedule with title-block text, and the model paired
  // "GROUND FLOOR" with the garden's figure as a result.
  const sheetText = sheets
    .map(
      (s) =>
        `--- sheet ${s.number} "${s.title}" (${s.units}, ${s.scale_statement ?? 'no scale stated'}) ---\n` +
        layoutLines(s).join('\n'),
    )
    .join('\n\n');

  const obs = await runStage({
    stage: 'applicability',
    promptVersion: PROMPT_VERSION,
    system: SYSTEM,
    schema: ObservationsSchema,
    jsonSchema: OBSERVATIONS_JSON_SCHEMA,
    maxTokens: 4000,
    thinking: true,
    ledger,
    content: [
      {
        type: 'text',
        text:
          `The governing scope clause, quoted from ${EDITION}:\n\n` +
          `Division A 1.3.3.3.(1): ${clauses.part9Scope}\n` +
          (clauses.necbScope ? `NECB 1.1.1.1.(1): ${clauses.necbScope}\n` : '') +
          `\nDrawing text follows. Report your observations only.\n\n${sheetText}`,
      },
    ],
  });

  // ---- the decision itself, in code (§G4) --------------------------------
  // Building area is the greatest horizontal area of a storey (the footprint),
  // which 1.3.3.3.(1)'s 600 m2 limit is measured against. Computed here from
  // the per-storey figures so the model never has to distinguish it from the
  // total floor area or from the lot.
  const occupiedStoreys = obs.storey_areas.filter((s) => s.area_m2 > 0);
  const buildingArea = occupiedStoreys.length > 0
    ? Math.max(...occupiedStoreys.map((s) => s.area_m2))
    : 0;
  const totalFloorArea = occupiedStoreys.reduce((a, s) => a + s.area_m2, 0) || null;

  const obsStoreys = obs.storeys_above_grade;
  const withinPart9 =
    obsStoreys > 0 &&
    obsStoreys <= PART9_MAX_STOREYS &&
    buildingArea > 0 &&
    buildingArea <= PART9_MAX_BUILDING_AREA_M2;

  const residential = /residential|dwelling|house|group c/i.test(
    `${obs.major_occupancy} ${obs.occupancy_group}`,
  );

  const code_parts = withinPart9 && residential ? ['9'] : ['3'];
  // NECB 1.1.1.1.(1) limits NECB to Part 3 buildings, so a Part 9 house is
  // always Section 9.36. This follows from the Part, never from the model.
  const energy_path = code_parts.includes('9') ? 'NBC_9.36' : 'NECB_2020';

  const applicability: Applicability = {
    major_occupancy: obs.major_occupancy,
    storeys: Math.max(1, obsStoreys),
    building_area_m2: Math.max(0.01, buildingArea),
    code_parts,
    edition: EDITION,
    energy_path,
    confidence: obs.confidence,
    basis: {
      code_parts: `1.3.3.3.(1); ${obsStoreys} storeys, building area ${buildingArea} m2, both within the 3 storey / 600 m2 limits`,
      energy_path:
        energy_path === 'NBC_9.36'
          ? '9.36.; NECB 1.1.1.1.(1) limits NECB to Part 3 buildings, so it does not apply'
          : 'NECB 1.1.1.1.(1)',
      major_occupancy: obs.occupancy_group,
      building_area:
        `largest of ${occupiedStoreys.map((s) => `${s.label} ${s.area_m2} m2`).join(', ') || 'no stated storey areas'}` +
        (totalFloorArea != null
          ? `; total floor area ${Math.round(totalFloorArea * 100) / 100} m2 is not compared against the 600 m2 limit`
          : '') +
        (obs.site_area_m2 != null ? `; lot area ${obs.site_area_m2} m2 is not the building area` : ''),
    },
    notes: [
      ...obs.evidence,
      ...obs.conflicts.map(
        (c) =>
          `Discrepancy in the area schedule, immaterial to which Part governs because every reading stays within the 3 storey and 600 m2 limits: ${c}`,
      ),
    ],
  };

  const predicates: Record<string, boolean | undefined> = {
    has_storage_garage: obs.has_storage_garage,
    has_garage_or_fuel_appliance:
      obs.has_storage_garage || obs.has_fuel_burning_appliance === true
        ? true
        : obs.has_fuel_burning_appliance === null
          ? undefined
          : false,
    not_sprinklered: obs.sprinklered == null ? undefined : !obs.sprinklered,
    // Which doors serve a required entrance or stair is a per-door question the
    // vision pass answers, never a whole-building one.
    door_serves_entrance_or_stair: undefined,
    stair_is_private: residential ? true : undefined,
  };

  // §S1: low confidence or conflicting inputs stop the run and ask a human.
  //
  // A conflict only stops the run when it is MATERIAL, meaning some plausible
  // reading of it would change the Part. The Chesnut schedule prints three
  // construction rows whose sum (268.33 m2) does not match the two rows that
  // name storeys (210.15 m2), which the model correctly flagged. Every reading
  // of that is still 2 to 3 storeys under 600 m2, so it lands on Part 9 either
  // way: stopping would have blocked the run over a bookkeeping discrepancy
  // that cannot affect the determination. It is reported as a note instead.
  //
  // The worst case is the most conservative one: every area row counted toward
  // the footprint, and every row counted as a storey.
  const worstCaseArea = obs.storey_areas.reduce((a, s) => a + s.area_m2, 0);
  const worstCaseStoreys = Math.max(obsStoreys, obs.storey_areas.length);
  const conflictCouldFlipThePart =
    worstCaseArea > PART9_MAX_BUILDING_AREA_M2 || worstCaseStoreys > PART9_MAX_STOREYS;

  let stop: string | undefined;
  if (obs.conflicts.length > 0 && conflictCouldFlipThePart) {
    stop = `the sheets conflict on the inputs that decide the Part, and the conflict is material: ${obs.conflicts.join('; ')}. Under the most conservative reading the building is ${worstCaseStoreys} storeys and ${Math.round(worstCaseArea * 100) / 100} m2, which crosses a 1.3.3.3.(1) limit`;
  } else if (obs.confidence < MIN_CONFIDENCE) {
    stop = `applicability confidence ${obs.confidence.toFixed(2)} is below the ${MIN_CONFIDENCE} bar; the sheets do not state enough to settle which Part governs`;
  } else if (buildingArea <= 0 || obsStoreys <= 0) {
    stop = 'the sheets state neither a building area nor a storey count, and 1.3.3.3.(1) turns on both';
  }

  return { applicability, predicates, stop };
}
