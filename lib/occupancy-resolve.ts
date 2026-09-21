// Resolving which NBC Part governs a sheet.
//
// The Part is the most load-bearing single fact in an analysis: it decides
// which rules the deterministic engine applies and which sections the LLM pass
// is allowed to cite. lib/rule-engine/occupancy.ts resolves it with a regex
// over the sheet's stated occupancy and building type, and returns undefined
// whenever that text is absent or ambiguous — which on real drawings is often.
//
// Undefined is not harmless. The rule engine responds by skipping part
// conditions, so Part 9 housing limits are evaluated against every sheet, and
// the LLM pass is told the occupancy is unspecified and retrieves across both
// Parts.
//
// So when the regex is silent, ask Jev. Three deliberate constraints:
//
//   - the regex always wins when it produced an answer; this never overrides it
//   - `unclear` is an available answer, so the model is not forced to guess
//   - the confidence bar is higher than anywhere else in the pipeline, because
//     a wrong Part is a broad, quiet failure rather than one bad finding
//
// Below the bar the part stays unknown and the engine behaves exactly as it
// does today. Nothing here can make the engine apply *fewer* correct checks
// than it would have; it can only stop it applying wrong ones.

import { OCCUPANCY_QUESTIONS, THRESHOLDS, TYPESAFE_MODEL, typesafe, verificationEnabled } from './typesafe';
import { detectBuildingPart, type BuildingPart } from './rule-engine/occupancy';
import type { ExtractedSheet } from './types';

const MAX_STATE = 4000;

export interface ResolvedPart {
  part?: BuildingPart;
  /** stated — the regex read it off the sheet; inferred — Jev judged it; unknown — neither could. */
  source: 'stated' | 'inferred' | 'unknown';
  confidence?: number;
  model?: string;
  /** One line for the analysis warnings, so an inferred Part is never invisible. */
  note?: string;
}

/** The descriptive evidence a Part decision rests on: occupancy, type, scale. */
export function occupancyState(sheet: ExtractedSheet): Record<string, unknown> {
  // levels carries storey text, totals carries building areas, sections and
  // other carry the general notes block — the three places a Part limit is
  // actually stated on a drawing.
  const notes = [
    ...sheet.annotations.levels,
    ...sheet.annotations.totals,
    ...sheet.annotations.sections,
    ...sheet.annotations.other,
  ]
    .join(' | ')
    .slice(0, MAX_STATE);

  return {
    stated_occupancy: sheet.occupancy_type ?? null,
    stated_building_type: sheet.building_type ?? null,
    room_names: sheet.rooms.map((r) => r.name).slice(0, 40),
    room_count: sheet.rooms.length,
    // Storey counts and building areas usually live in the sheet's notes rather
    // than in a structured field, and they are what the Part limits turn on.
    drawing_notes: notes,
  };
}

export async function resolveBuildingPart(sheet: ExtractedSheet): Promise<ResolvedPart> {
  const stated = detectBuildingPart(sheet.occupancy_type, sheet.building_type);
  if (stated) return { part: stated, source: 'stated' };

  if (!verificationEnabled()) return { source: 'unknown' };

  try {
    const response = await typesafe().systemOne({
      state: { drawing_data: occupancyState(sheet) as never },
      questions: { building_part: OCCUPANCY_QUESTIONS.building_part },
      model: TYPESAFE_MODEL,
    });
    const answer = response.answers.building_part;

    if (answer.choice === 'unclear') {
      return {
        source: 'unknown',
        confidence: answer.confidence,
        model: response.model,
        note: 'occupancy could not be determined from the sheet; Part-specific checks not narrowed',
      };
    }

    if (answer.confidence < THRESHOLDS.occupancyAutoAccept) {
      return {
        source: 'unknown',
        confidence: answer.confidence,
        model: response.model,
        note: `occupancy inferred as ${answer.choice} but only at ${answer.confidence.toFixed(2)} confidence (needs ${THRESHOLDS.occupancyAutoAccept}); treated as unknown`,
      };
    }

    return {
      part: answer.choice,
      source: 'inferred',
      confidence: answer.confidence,
      model: response.model,
      note: `occupancy not stated on the sheet; ${answer.choice} inferred by ${response.model} at ${answer.confidence.toFixed(2)} confidence`,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[occupancy] inference failed', err);
    return {
      source: 'unknown',
      note: `occupancy inference unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
