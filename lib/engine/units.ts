// Unit normalization for the deterministic comparison (PLANQ_SPEC.md §G4:
// "numeric tests run in code with unit normalization").
//
// A fact carries the unit printed on the drawing; a rule carries the unit its
// threshold was transcribed in. Comparing them without converting is how a
// 2.6 m ceiling reads as failing a 2 100 mm minimum.

export type Unit = 'mm' | 'm' | 'm2' | 'count' | 'ratio';

const TO_BASE: Record<string, { base: Unit; factor: number }> = {
  mm: { base: 'mm', factor: 1 },
  cm: { base: 'mm', factor: 10 },
  m: { base: 'mm', factor: 1000 },
  'm2': { base: 'm2', factor: 1 },
  'mm2': { base: 'm2', factor: 1e-6 },
  // Imperial. Many Alberta sets are drawn in feet and inches.
  in: { base: 'mm', factor: 25.4 },
  inch: { base: 'mm', factor: 25.4 },
  inches: { base: 'mm', factor: 25.4 },
  '"': { base: 'mm', factor: 25.4 },
  ft: { base: 'mm', factor: 304.8 },
  feet: { base: 'mm', factor: 304.8 },
  foot: { base: 'mm', factor: 304.8 },
  "'": { base: 'mm', factor: 304.8 },
  ft2: { base: 'm2', factor: 0.09290304 },
  sqft: { base: 'm2', factor: 0.09290304 },
  sf: { base: 'm2', factor: 0.09290304 },
  'sq.ft.': { base: 'm2', factor: 0.09290304 },
  count: { base: 'count', factor: 1 },
  ratio: { base: 'ratio', factor: 1 },
  '%': { base: 'ratio', factor: 0.01 },
};

export class UnitMismatchError extends Error {
  constructor(from: string, to: string) {
    super(`cannot convert ${from} to ${to}: different base quantities`);
    this.name = 'UnitMismatchError';
  }
}

export function normalizeUnit(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.trim().toLowerCase().replace('²', '2').replace(/\s/g, '');
}

/**
 * Convert a value between units. Returns null when the unit is unknown, so a
 * caller can record "not measurable" rather than compare a wrong number.
 */
export function convert(value: number, from: string, to: string): number | null {
  const f = TO_BASE[normalizeUnit(from) ?? ''];
  const t = TO_BASE[normalizeUnit(to) ?? ''];
  if (!f || !t) return null;
  if (f.base !== t.base) throw new UnitMismatchError(from, to);
  return (value * f.factor) / t.factor;
}

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

/** "3/4" or "¾" or "" to a number of inches. */
function fraction(raw: string | undefined): number {
  if (!raw) return 0;
  const t = raw.trim();
  if (UNICODE_FRACTIONS[t] != null) return UNICODE_FRACTIONS[t];
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0;
}

/**
 * A printed feet-and-inches dimension to millimetres, or null when the text is
 * not one. Handles 4'-5 3/4", 4'-5¾", 9'-1", 4' 5", 32", 2'. A bare number is
 * not imperial: it is left for the caller to treat as unreadable, never assumed.
 */
export function parseImperial(text: string): number | null {
  const t = text.trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  const frac = String.raw`(\d+\s*\/\s*\d+|[¼½¾⅛⅜⅝⅞])`;
  const ftIn = new RegExp(String.raw`^(\d+)\s*'\s*-?\s*(\d+)?\s*${frac}?\s*"?$`);
  const m = ftIn.exec(t);
  if (m && (t.includes("'"))) {
    const inches = Number(m[1]) * 12 + (m[2] ? Number(m[2]) : 0) + fraction(m[3]);
    return inches * 25.4;
  }
  const inOnly = new RegExp(String.raw`^(\d+)\s*${frac}?\s*"$`).exec(t);
  if (inOnly) return (Number(inOnly[1]) + fraction(inOnly[2])) * 25.4;
  return null;
}

/**
 * The North American door tag "2/8": 2 ft 8 in wide. Only meaningful for a
 * door width, and only with an inch part under 12, so "3/4" style fractions or
 * a sheet reference are not mistaken for one. Returns millimetres or null.
 */
export function parseDoorTag(text: string): number | null {
  const m = /^\s*(\d)\s*\/\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const ft = Number(m[1]);
  const inch = Number(m[2]);
  if (ft < 1 || ft > 4 || inch > 11) return null;
  return (ft * 12 + inch) * 25.4;
}
