// Adapt the sheet-shaped ExtractedSheet (nested arrays of stairs/doors/etc. with
// string dimensions) into the flat, numeric NormalizedElement[] the rule runner
// evaluates. All linear attributes are normalized to millimetres via parseToMm.

import type { ExtractedSheet } from '../types';
import { parseToMm } from './units';
import { detectBuildingPart } from './occupancy';
import type { ElementType, NormalizedElement } from './types';

/** Set a numeric attribute only when the source string parses to a real number. */
function setMm(attrs: Record<string, number>, key: string, raw?: string | null): void {
  const mm = parseToMm(raw ?? null);
  if (mm != null) attrs[key] = mm;
}

// Map a generic dimensions[] label to an (elementType, attribute) target so
// measurements that aren't in the structured arrays (ceiling height, guard
// height, headroom) still reach the runner.
function classifyDimension(label: string): { type: ElementType; attribute: string } | null {
  const l = label.toLowerCase();
  if (l.includes('ceiling')) return { type: 'room', attribute: 'ceiling_height_mm' };
  if (l.includes('guard')) return { type: 'guard', attribute: 'height_mm' };
  if (l.includes('handrail')) return { type: 'stair', attribute: 'handrail_height_mm' };
  if (l.includes('headroom') || l.includes('head room')) {
    return { type: 'stair', attribute: 'headroom_mm' };
  }
  if (l.includes('stair') && (l.includes('run') || l.includes('tread'))) {
    return { type: 'stair', attribute: 'run_depth_mm' };
  }
  if (l.includes('stair') && (l.includes('rise') || l.includes('riser'))) {
    return { type: 'stair', attribute: 'rise_mm' };
  }
  if (l.includes('stair') && l.includes('width')) return { type: 'stair', attribute: 'width_mm' };
  if (l.includes('door') && l.includes('width')) return { type: 'door', attribute: 'width_mm' };
  if ((l.includes('corridor') || l.includes('hall')) && l.includes('width')) {
    return { type: 'corridor', attribute: 'width_mm' };
  }
  return null;
}

export function flattenSheet(sheet: ExtractedSheet): NormalizedElement[] {
  const building_part = detectBuildingPart(sheet.occupancy_type, sheet.building_type);
  const occupancy = sheet.occupancy_type;
  const base = { sheet: sheet.sheet_name, occupancy, building_part };
  const elements: NormalizedElement[] = [];

  sheet.stairs.forEach((s, i) => {
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', s.width);
    setMm(attributes, 'rise_mm', s.rise);
    setMm(attributes, 'run_depth_mm', s.run);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'stair', id: s.location || `stair#${i}`, attributes });
    }
  });

  sheet.doors.forEach((d, i) => {
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', d.width);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'door', id: d.location || `door#${i}`, attributes });
    }
  });

  sheet.corridors.forEach((c, i) => {
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', c.width);
    setMm(attributes, 'length_mm', c.length);
    if (Object.keys(attributes).length) {
      elements.push({ ...base, type: 'corridor', id: c.location || `corridor#${i}`, attributes });
    }
  });

  sheet.egress_paths.forEach((e, i) => {
    const attributes: Record<string, number> = {};
    setMm(attributes, 'width_mm', e.width);
    if (Object.keys(attributes).length) {
      const id = e.from || e.to ? `${e.from ?? '?'}→${e.to ?? '?'}` : `egress#${i}`;
      elements.push({ ...base, type: 'egress', id, attributes });
    }
  });

  // Generic dimensions[] — route labelled measurements (ceiling height, guard
  // height, headroom, …) to the right element type.
  sheet.dimensions.forEach((dim, i) => {
    const target = classifyDimension(dim.element ?? '');
    if (!target) return;
    const mm = parseToMm(`${dim.value ?? ''} ${dim.unit ?? ''}`.trim() || dim.value);
    if (mm == null) return;
    elements.push({
      ...base,
      type: target.type,
      id: dim.element || `${target.type}#dim${i}`,
      attributes: { [target.attribute]: mm },
    });
  });

  return elements;
}
