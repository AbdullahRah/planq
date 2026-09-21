// Adapt the sheet-shaped ExtractedSheet (nested arrays of stairs/doors/etc. with
// string dimensions) into the flat, numeric NormalizedElement[] the rule runner
// evaluates. All linear attributes are normalized to millimetres via parseDimension.

import type { ExtractedSheet } from '../types';
import { parseDimension } from './units';
import { detectBuildingPart, type BuildingPart } from './occupancy';
import type { ElementType, NormalizedElement } from './types';

// Physically plausible [min, max] in mm for each attribute. Extraction noise
// (e.g. a "stair rise" of 2463mm — really the total rise over many risers — or a
// 25mm "ceiling height") falls outside these and must NOT generate a violation;
// the deterministic engine only flags values that could really be that element.
// Bounds are wide enough to keep genuine violations (e.g. a 250mm rise, an
// 1800mm ceiling) while excluding impossible single-element measurements.
const SANE_MM: Record<string, [number, number]> = {
  width_mm: [300, 4000],
  rise_mm: [80, 300],
  run_depth_mm: [120, 600],
  headroom_mm: [1500, 4000],
  handrail_height_mm: [600, 1200],
  height_mm: [400, 2000],
  ceiling_height_mm: [1500, 6000],
  length_mm: [200, 200000],
};

function isPlausible(attr: string, mm: number): boolean {
  const bounds = SANE_MM[attr];
  return !bounds || (mm >= bounds[0] && mm <= bounds[1]);
}

// Scale factors tried when a number arrives without a unit, in the order a
// drawing is most likely to mean them: mm, m, cm, inches, feet.
const UNITLESS_SCALES = [1 /* mm */, 1000 /* m */, 10 /* cm */, 25.4 /* in */, 304.8 /* ft */];

export type SkipReason = 'implausible' | 'ambiguous-unit';

export interface FlattenNote {
  element: string;
  attribute: string;
  raw: string;
  reason: SkipReason;
}

/**
 * Resolve a raw dimension string to millimetres for a specific attribute.
 *
 * - An explicit unit is taken at face value: if the stated magnitude is
 *   impossible for that attribute it is extraction noise and is dropped.
 * - A bare number is unit-ambiguous. We accept it only when exactly one of the
 *   candidate scales lands inside the attribute's plausible band — that rescues
 *   a "2.4" ceiling (metres) and a "0.9" door without letting a number that
 *   could equally be centimetres or inches invent a violation.
 */
function resolveMm(
  attribute: string,
  raw: string | null | undefined,
): { mm: number } | { skip: SkipReason } | null {
  const parsed = parseDimension(raw ?? null);
  if (!parsed) return null;

  if (parsed.explicitUnit) {
    return isPlausible(attribute, parsed.mm) ? { mm: parsed.mm } : { skip: 'implausible' };
  }

  const candidates: number[] = [];
  for (const factor of UNITLESS_SCALES) {
    const scaled = parsed.mm * factor;
    if (isPlausible(attribute, scaled) && !candidates.some((c) => Math.abs(c - scaled) < 0.5)) {
      candidates.push(scaled);
    }
  }
  if (candidates.length === 1) return { mm: candidates[0] };
  if (candidates.length === 0) return { skip: 'implausible' };
  return { skip: 'ambiguous-unit' };
}

/**
 * Set a numeric attribute only when the source string resolves to a real number
 * that is physically plausible for that attribute. Anything dropped is recorded
 * in `notes` so the caller can explain an empty result instead of silently
 * reporting "no violations".
 */
function setMm(
  attrs: Record<string, number>,
  key: string,
  raw: string | null | undefined,
  elementId: string,
  notes: FlattenNote[],
): void {
  const out = resolveMm(key, raw);
  if (!out) return;
  if ('skip' in out) {
    notes.push({ element: elementId, attribute: key, raw: String(raw ?? ''), reason: out.skip });
    return;
  }
  attrs[key] = out.mm;
}

// Doorways that serve a closet, cupboard or service opening are not the
// "required" doorways NBC 9.5.3 sizes, and they are routinely 600–760mm wide.
// Checking them against the 810mm minimum is the single largest source of
// false positives on a real residential plan.
const NON_REQUIRED_DOOR =
  /closet|wardrobe|pantry|cupboard|cabinet|linen|shelv|broom|access\s*(panel|door)|hatch|crawl|attic|dumbwaiter|chase/i;

// NBC 9.9.3.3's 1100mm minimum is for public / public-use / exit corridors;
// corridors inside a dwelling unit or suite are explicitly exempt.
const IN_SUITE_CORRIDOR =
  /in[-\s]?suite|within\s+(?:the\s+)?(?:suite|unit|dwelling)|dwelling\s*unit|suite\s*interior|private/i;

function isExcludedDoor(location?: string, type?: string): boolean {
  return NON_REQUIRED_DOOR.test(`${location ?? ''} ${type ?? ''}`);
}

// Map a generic dimensions[] label to an (elementType, attribute) target so
// measurements that aren't in the structured arrays (ceiling height, guard
// height, headroom) still reach the runner.
function classifyDimension(label: string): { type: ElementType; attribute: string } | null {
  const l = label.toLowerCase();
  // "total rise", "overall width" etc. describe an assembly, not one element.
  if (/\btotal\b|\boverall\b|\bcumulative\b|\bgross\b/.test(l)) return null;
  if (l.includes('ceiling')) return { type: 'room', attribute: 'ceiling_height_mm' };
  if (l.includes('guard')) return { type: 'guard', attribute: 'height_mm' };
  if (l.includes('handrail')) return { type: 'stair', attribute: 'handrail_height_mm' };
  if (l.includes('headroom') || l.includes('head room')) {
    return { type: 'stair', attribute: 'headroom_mm' };
  }
  if (l.includes('run') || l.includes('tread')) return { type: 'stair', attribute: 'run_depth_mm' };
  if (l.includes('rise') || l.includes('riser')) return { type: 'stair', attribute: 'rise_mm' };
  if (l.includes('stair')) return { type: 'stair', attribute: 'width_mm' };
  if (l.includes('door')) {
    return isExcludedDoor(label) ? null : { type: 'door', attribute: 'width_mm' };
  }
  if (l.includes('corridor') || l.includes('hall')) {
    return IN_SUITE_CORRIDOR.test(l) ? null : { type: 'corridor', attribute: 'width_mm' };
  }
  if (l.includes('exit') || l.includes('egress')) return { type: 'egress', attribute: 'width_mm' };
  return null;
}

export function flattenSheet(
  sheet: ExtractedSheet,
  notes: FlattenNote[] = [],
  partOverride?: BuildingPart,
): NormalizedElement[] {
  // A caller that resolved the Part another way (lib/occupancy-resolve.ts, when
  // the regex below found nothing) passes it in; otherwise read it off the sheet.
  const building_part =
    partOverride ?? detectBuildingPart(sheet.occupancy_type, sheet.building_type);
  const occupancy = sheet.occupancy_type;
  const base = { sheet: sheet.sheet_name, occupancy, building_part };
  const elements: NormalizedElement[] = [];

  sheet.stairs.forEach((s, i) => {
    const id = s.location || `stair#${i}`;
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', s.width, id, notes);
    setMm(attributes, 'rise_mm', s.rise, id, notes);
    setMm(attributes, 'run_depth_mm', s.run, id, notes);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'stair', id, attributes });
    }
  });

  sheet.doors.forEach((d, i) => {
    if (isExcludedDoor(d.location, d.type)) return;
    const id = d.location || `door#${i}`;
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', d.width, id, notes);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'door', id, attributes });
    }
  });

  sheet.corridors.forEach((c, i) => {
    if (IN_SUITE_CORRIDOR.test(c.location ?? '')) return;
    const id = c.location || `corridor#${i}`;
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', c.width, id, notes);
    setMm(attributes, 'length_mm', c.length, id, notes);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'corridor', id, attributes });
    }
  });

  sheet.egress_paths.forEach((e, i) => {
    const id = e.from || e.to ? `${e.from ?? '?'}→${e.to ?? '?'}` : `egress#${i}`;
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', e.width, id, notes);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'egress', id, attributes });
    }
  });

  // Generic dimensions[] — route labelled measurements (ceiling height, guard
  // height, headroom, …) to the right element type.
  sheet.dimensions.forEach((dim, i) => {
    const target = classifyDimension(dim.element ?? '');
    if (!target) return;
    const id = dim.element || `${target.type}#dim${i}`;
    const raw = `${dim.value ?? ''} ${dim.unit ?? ''}`.trim() || dim.value;
    const out = resolveMm(target.attribute, raw);
    if (!out) return;
    if ('skip' in out) {
      notes.push({ element: id, attribute: target.attribute, raw: String(raw), reason: out.skip });
      return;
    }
    elements.push({
      ...base,
      type: target.type,
      id,
      attributes: { [target.attribute]: out.mm },
    });
  });

  return elements;
}
