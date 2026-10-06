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
