// Single source of truth for Part 9 vs Part 3 classification, shared by the
// deterministic rule engine (rule `conditions.building_part`) and the LLM
// compliance pass (detectPartPrefix in lib/analyze.ts) so both agree.

export type BuildingPart = 'Part9' | 'Part3';

/**
 * Infer the applicable NBC Part from the sheet's stated occupancy / building
 * type text. Returns undefined when the text is empty or ambiguous — callers
 * must treat undefined as "unknown", never as a default.
 */
export function detectBuildingPart(
  occupancyType?: string,
  buildingType?: string,
): BuildingPart | undefined {
  const blob = `${occupancyType ?? ''} ${buildingType ?? ''}`.toLowerCase();
  if (!blob.trim()) return undefined;
  if (/part\s*9|house|dwelling|residential\s*(small|low)|small\s*building/.test(blob)) {
    return 'Part9';
  }
  if (/part\s*3|assembly|business|mercantile|industrial|institutional|high[-\s]?rise/.test(blob)) {
    return 'Part3';
  }
  return undefined;
}
