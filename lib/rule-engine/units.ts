// Parse free-text dimension strings from extracted plan data into millimetres.
// The extractor emits dims as strings ("900mm", "0.9 m", "36\"", "3'-0\"", "900")
// so the deterministic runner needs a single, predictable normalizer. Returns
// null when no usable number is present (e.g. "varies", "see detail").

const MM_PER_M = 1000;
const MM_PER_INCH = 25.4;
const MM_PER_FOOT = 304.8;

function toNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a dimension string to millimetres. Bare numbers are assumed to be mm
 * (the convention in NBC and the extractor's output). Returns null if nothing
 * numeric can be parsed.
 */
export function parseToMm(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // Feet-and-inches: 3'-0", 3' 0", 3'0", or bare feet 3'
  const ftIn = s.match(/(-?\d+(?:\.\d+)?)\s*'\s*[-\s]?\s*(\d+(?:\.\d+)?)?\s*"?/);
  if (ftIn && s.includes("'")) {
    const feet = toNumber(ftIn[1]) ?? 0;
    const inches = ftIn[2] != null ? (toNumber(ftIn[2]) ?? 0) : 0;
    return feet * MM_PER_FOOT + inches * MM_PER_INCH;
  }

  // Inches: 36" or 36 in
  const inMatch = s.match(/(-?\d+(?:\.\d+)?)\s*(?:"|in\b|inch(?:es)?)/);
  if (inMatch) {
    const v = toNumber(inMatch[1]);
    return v == null ? null : v * MM_PER_INCH;
  }

  // Millimetres: 900mm
  const mmMatch = s.match(/(-?\d+(?:\.\d+)?)\s*mm\b/);
  if (mmMatch) return toNumber(mmMatch[1]);

  // Centimetres: 90cm
  const cmMatch = s.match(/(-?\d+(?:\.\d+)?)\s*cm\b/);
  if (cmMatch) {
    const v = toNumber(cmMatch[1]);
    return v == null ? null : v * 10;
  }

  // Metres: 0.9 m  (guard against the "m" in "mm"/"cm", handled above)
  const mMatch = s.match(/(-?\d+(?:\.\d+)?)\s*m\b/);
  if (mMatch) {
    const v = toNumber(mMatch[1]);
    return v == null ? null : v * MM_PER_M;
  }

  // Bare number → assume millimetres. Grab the first numeric token.
  const bare = s.match(/-?\d+(?:\.\d+)?/);
  if (bare) return toNumber(bare[0]);

  return null;
}
