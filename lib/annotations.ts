export interface AnnotationBuckets {
  rooms: string[];
  doors: string[];
  dimensions: string[];
  levels: string[];
  totals: string[];
  sections: string[];
  other: string[];
}

export function emptyAnnotations(): AnnotationBuckets {
  return { rooms: [], doors: [], dimensions: [], levels: [], totals: [], sections: [], other: [] };
}

const BOILERPLATE_RE =
  /freecadfloorplans|copyright|drawing title|sheet number|cad drawing|scale\s*not\s*to\s*scale|educational or personal use|redistribute|resell|republish|elvis alcequiez|chesnut residence|architectural plan|symbology|wall axis|cut[- ]off indicator|rainwater drainage|level change|level in elevations|access signal|inside elevation indicator|finished floor level|width of doors\s*$|n\.p\.t\.\s*$|b\.a\.p\s*$|hemi\s*$/i;

function isLikelyGridRef(token: string): boolean {
  const t = token.trim();
  if (/^[A-Ga-g]'?$/.test(t)) return true;
  if (/^\d{1,2}$/.test(t) && parseInt(t, 10) <= 17) return true;
  if (/^[A-Ga-g][\s,]+[A-Ga-g]/.test(t) && t.length < 20) return true;
  return false;
}

export function categorizeAnnotations(raw: string[]): AnnotationBuckets {
  const buckets = emptyAnnotations();
  const seen = new Set<string>();

  const atoms: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const exploded = entry
      .split(/\r?\n+/)
      .flatMap((line) =>
        line.split(/\s{3,}|(?=\b(?:NPT|NLT|LEVEL)\s*=)|(?=\bSection\s+[A-Z]\b)|(?=\bP\d+\s+\d)/),
      )
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter((s) => s.length > 0);
    atoms.push(...exploded);
  }

  for (const atom of atoms) {
    if (atom.length < 2) continue;
    if (BOILERPLATE_RE.test(atom)) continue;
    if (isLikelyGridRef(atom)) continue;
    if (/^[\d.\s,'"\-+/[\]ftm²]+$/.test(atom) && atom.length < 6) continue;

    const key = atom.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (/total|m²|m2\b|basement|ground floor|first level|garden\s*:/i.test(atom)) {
      buckets.totals.push(atom);
      continue;
    }
    if (/^section\s+[A-Z]|front elevation|side elevation|rear elevation|elevation$/i.test(atom)) {
      buckets.sections.push(atom);
      continue;
    }
    if (/^P\d+\s+\d+(\.\d+)?\s*(m|cm)|puerta\s+\d|width of doors/i.test(atom)) {
      buckets.doors.push(atom);
      continue;
    }
    if (/(NPT|NLT|LEVEL)\s*=/i.test(atom)) {
      const m = atom.match(/^(.+?)\s*(NPT|NLT|LEVEL)\s*=\s*([+\-±]?[\d.]+)/i);
      if (m && m[1].trim().length >= 3) {
        buckets.rooms.push(`${m[1].trim()} — ${m[2].toUpperCase()} ${m[3]}`);
      } else {
        buckets.levels.push(atom);
      }
      continue;
    }
    if (/^\d+(\.\d+)?\s*m\b/.test(atom) && atom.length < 60) {
      buckets.dimensions.push(atom);
      continue;
    }
    if (atom.length > 80) continue;
    buckets.other.push(atom);
  }

  return buckets;
}

export function isAnnotationBuckets(v: unknown): v is AnnotationBuckets {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.rooms) &&
    Array.isArray(o.doors) &&
    Array.isArray(o.dimensions) &&
    Array.isArray(o.levels) &&
    Array.isArray(o.totals) &&
    Array.isArray(o.sections) &&
    Array.isArray(o.other)
  );
}

export function totalAnnotationCount(b: AnnotationBuckets): number {
  return (
    b.rooms.length +
    b.doors.length +
    b.dimensions.length +
    b.levels.length +
    b.totals.length +
    b.sections.length +
    b.other.length
  );
}
