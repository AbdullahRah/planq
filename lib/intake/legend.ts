// Learning a sheet's notation from its own legend (PLANQ_SPEC.md §S2).
//
// We have exactly one drawing set with a text layer, and it is not an Alberta
// set: it labels doors PUERTA / P2 and levels N.P.T. / N.L.T., which are Spanish
// conventions. An Alberta set will say T/O SLAB, F.F.E., U/S JOIST, D01, or
// nothing recognisable at all. Hardcoding one vocabulary produces a tool that
// works on the fixture and silently reads nothing anywhere else.
//
// Drawings solve this themselves: a set that uses a notation declares it in a
// legend. So read the legend, learn what the tokens mean on THIS sheet, and
// apply that. Where no legend declares a token, the convention is recorded as
// ASSUMED and surfaced, never passed off as read.
//
// This is a fast path, not the main one. The vision pass is convention-agnostic
// and handles sheets with no text layer at all, which is most of them.

import type { SheetInventory, SheetTextItem } from './sheets';

/** What a level-mark prefix means on this sheet. */
export type LevelSemantic = 'floor' | 'ceiling' | 'elevation' | 'grade' | 'unknown';

export interface Conventions {
  /** "N.P.T." -> 'floor', "U/S JOIST" -> 'ceiling', and so on. */
  levelTokens: Map<string, LevelSemantic>;
  /** True when a legend entry says door symbols carry their width. */
  doorTagsCarryWidth: boolean;
  /** Token shapes a legend showed for door tags, e.g. ["P2"] or ["D01"]. */
  doorTagSamples: string[];
  /** Tokens this sheet's legend actually declared. */
  declared: string[];
  /** Tokens relied on without any legend backing them. */
  assumed: string[];
  /** Which legend blocks were found, for the audit trail. */
  legendBlocks: string[];
}

const LEGEND_HEADING_RE =
  /^(SYMBOLOGY|SYMBOLS?|LEGEND|KEY|KEYNOTES?|ABBREVIATIONS?|NOTATION|GENERAL\s+NOTES)\s*:?$/i;

/** A token that looks like a level mark: a prefix, a separator, a number. */
const LEVEL_SAMPLE_RE = /^([A-Za-z][A-Za-z./\s]{0,14}?)\s*[=:]\s*[+\-±]?\s*\d/;
/** A door-ish tag: one or two letters then digits, or a bare word in caps. */
const TAG_SAMPLE_RE = /^([A-Z]{1,3}\s?\d{1,3}|[A-Z]{4,10})$/;

/** Words in a legend description that say what a level mark refers to. */
const SEMANTIC_WORDS: Array<[LevelSemantic, RegExp]> = [
  ['floor', /FINISHED\s+FLOOR|FLOOR\s+LEVEL|T\/O\s+SLAB|TOP\s+OF\s+SLAB|F\.?F\.?E|GROUND\s+LEVEL|NIVEL\s+DE\s+PISO/i],
  ['ceiling', /CEILING|U\/S\s+JOIST|UNDERSIDE|SOFFIT|NIVEL\s+DE\s+LOSA/i],
  ['elevation', /ELEVATION|LEVEL\s+IN\s+ELEVATION|SECTION\s+LEVEL/i],
  ['grade', /GRADE|FINISHED\s+GROUND|GROUND\s+ELEVATION/i],
];

/**
 * Legend entries, as (sample, description) pairs.
 *
 * A legend prints the symbol and its meaning on one line, so entries are
 * recovered by grouping a block's items into rows and splitting each row into
 * the token-shaped part and the prose part.
 */
function legendEntries(sheet: SheetInventory): Array<{ sample: string; description: string }> {
  const headings = sheet.text_items.filter((i) => LEGEND_HEADING_RE.test(i.text.trim()));
  if (headings.length === 0) return [];

  const out: Array<{ sample: string; description: string }> = [];

  for (const heading of headings) {
    // A legend block sits below and around its heading. Generous bounds: blocks
    // are laid out differently on every set, and a false extra row costs
    // nothing because entries are matched by shape afterwards.
    const block = sheet.text_items.filter(
      (i) =>
        i !== heading &&
        i.y <= heading.y + 12 &&
        i.y > heading.y - 260 &&
        i.x > heading.x - 120 &&
        i.x < heading.x + 420,
    );

    // Group into rows on y.
    const rows = new Map<number, SheetTextItem[]>();
    for (const i of block) {
      const key = Math.round(i.y / 5) * 5;
      const r = rows.get(key);
      if (r) r.push(i);
      else rows.set(key, [i]);
    }

    for (const cells of rows.values()) {
      cells.sort((a, b) => a.x - b.x);
      const kept = cells.filter((c) => c.text.trim());
      if (kept.length < 2) continue;

      // A legend row usually holds several entries side by side:
      //   N.P.T.=±0.00  GROUND LEVEL   LEVEL=±0.00  INSIDE ELEVATION INDICATOR
      // so each sample belongs to the description nearest to its right, not to
      // the longest prose on the row. Pairing by length instead read N.P.T. as
      // "INSIDE ELEVATION INDICATOR" and mislabelled the floor datum as an
      // elevation mark.
      const isProse = (t: string) => /\s/.test(t) && /[A-Za-z]{3}/.test(t);

      for (let k = 0; k < kept.length; k++) {
        const sample = kept[k].text.trim();
        if (isProse(sample)) continue;

        const description = kept
          .slice(k + 1)
          .map((c) => c.text.trim())
          .find((t) => isProse(t));
        if (!description) continue;

        out.push({ sample, description });
      }
    }
  }

  return out;
}

/**
 * The default notation, used only when a sheet declares nothing.
 *
 * Deliberately listed in one place and reported as `assumed`, so a reviewer can
 * see that a finding rests on a guessed convention rather than on the drawing.
 */
const ASSUMED_LEVEL_TOKENS: Array<[string, LevelSemantic]> = [
  ['NPT', 'floor'],
  ['N.P.T.', 'floor'],
  ['FFE', 'floor'],
  ['F.F.E.', 'floor'],
  ['T/O SLAB', 'floor'],
  ['NLT', 'ceiling'],
  ['N.L.T.', 'ceiling'],
  ['U/S JOIST', 'ceiling'],
  ['LEVEL', 'elevation'],
];

export function readConventions(sheets: SheetInventory[]): Conventions {
  const levelTokens = new Map<string, LevelSemantic>();
  const declared: string[] = [];
  const doorTagSamples: string[] = [];
  const legendBlocks: string[] = [];
  let doorTagsCarryWidth = false;

  for (const sheet of sheets) {
    const entries = legendEntries(sheet);
    if (entries.length > 0) legendBlocks.push(`sheet ${sheet.number} (${entries.length} entries)`);

    for (const { sample, description } of entries) {
      // A level mark: the sample looks like PREFIX=number, and the description
      // says which datum it refers to.
      const lvl = sample.match(LEVEL_SAMPLE_RE);
      if (lvl) {
        const token = lvl[1].trim().toUpperCase().replace(/\s+/g, ' ');
        const semantic =
          SEMANTIC_WORDS.find(([, re]) => re.test(description))?.[0] ?? 'unknown';
        if (token && semantic !== 'unknown') {
          levelTokens.set(token, semantic);
          declared.push(`${token} = ${semantic} ("${description}")`);
        }
        continue;
      }

      // A door tag: the description says the symbol carries a door width.
      if (/WIDTH\s+OF\s+DOORS?|DOOR\s+WIDTH|PUERTA|DOOR\s+(TAG|SCHEDULE|TYPE)/i.test(description)) {
        doorTagsCarryWidth = true;
        if (TAG_SAMPLE_RE.test(sample)) doorTagSamples.push(sample);
        declared.push(`door tags carry width ("${description}", e.g. "${sample}")`);
      }
    }
  }

  // Fill gaps from the assumed set, and say so.
  const assumed: string[] = [];
  for (const [token, semantic] of ASSUMED_LEVEL_TOKENS) {
    const key = token.toUpperCase();
    if (!levelTokens.has(key)) {
      levelTokens.set(key, semantic);
      assumed.push(`${key} = ${semantic}`);
    }
  }

  return {
    levelTokens,
    doorTagsCarryWidth,
    doorTagSamples,
    declared,
    assumed,
    legendBlocks,
  };
}

/**
 * Resolve a level mark's prefix to its meaning on this sheet, and say whether
 * the sheet declared it. A fact built on an undeclared token has to carry that
 * caveat so it is not mistaken for something the drawing stated.
 */
export function levelSemantic(
  conventions: Conventions,
  prefix: string,
): { semantic: LevelSemantic; declared: boolean } {
  const key = prefix.trim().toUpperCase().replace(/\s+/g, ' ');
  const semantic = conventions.levelTokens.get(key) ?? 'unknown';
  const declared = conventions.declared.some((d) => d.startsWith(`${key} =`));
  return { semantic, declared };
}
