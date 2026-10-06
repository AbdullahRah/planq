// S2, fact extraction from drawing tiles (PLANQ_SPEC.md §S2). Sonnet, vision.
//
// This is the main extraction path, not a fallback. Of the two drawing sets we
// have, one carries a text layer and one is a scan; a scan or a flattened
// export is the common case, and on those the native reader returns nothing.
//
// It is deliberately convention-agnostic. The model is told what KIND of fact
// each rule needs and is asked to report whatever notation the sheet uses, so a
// set labelling levels T/O SLAB works the same as one labelling them N.P.T.
// Where a legend was read, it is passed as a hint, never as a filter.
//
// §S2's constraints, enforced here:
//   - only dimension strings, level marks, tags and schedules printed on the
//     sheet; never a measurement taken off the geometry
//   - every fact carries sheet, tile, bbox and the verbatim source text (§G2)
//   - two runs with different tile orders; a fact in only one run, or with
//     differing values, is unstable and cannot support a fail (§G6)
//   - negative evidence recorded per rule, so "not shown" is a fact (§G5)

import { z } from 'zod';
import type { Fact, NegativeEvidence, Rule } from '../schemas';
import type { Conventions } from '../intake/legend';
import type { SheetInventory } from '../intake/sheets';
import { renderSheet, type RenderedSheet } from '../intake/render';
import { runStage, type ContentBlock, type RunLedger } from './runner';

const PROMPT_VERSION = 's2-2026-10-05';

/**
 * A count printed with its marker, such as "12R" for twelve risers, comes back
 * as a string. Left as one it cannot be compared, and the stair-consistency
 * rule reported a plan reading "12R" as disagreeing with a section reading 12.
 * The verbatim text stays in source_text; only the value becomes a number.
 */
function normalizeCount<T extends { kind: string; value: number | string | boolean }>(f: T): T {
  if (typeof f.value !== 'string' || !/_count$/.test(f.kind)) return f;
  const m = /^\s*(\d+)\s*[A-Za-z]{0,7}\.?\s*$/.exec(f.value);
  return m ? { ...f, value: Number(m[1]) } : f;
}

const ObservedFactSchema = z.object({
  kind: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()]),
  unit: z.string().nullable(),
  subject: z.string(),
  source_text: z.string().min(1),
  /** Tile-relative pixel box, converted to sheet points by the caller. */
  bbox: z.array(z.number()).length(4),
  tile_id: z.string(),
  confidence: z.number().min(0).max(1),
});

const VisionOutputSchema = z.object({
  facts: z.array(ObservedFactSchema),
  /** Fact kinds searched for and not found, with where the model looked. */
  not_found: z.array(
    z.object({
      kind: z.string(),
      searched: z.array(z.string()).min(1),
    }),
  ),
  sheet_notes: z.array(z.string()),
});

const VISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          value: { type: ['number', 'string', 'boolean'] },
          unit: { type: ['string', 'null'] },
          subject: { type: 'string' },
          source_text: { type: 'string' },
          bbox: { type: 'array', items: { type: 'number' } },
          tile_id: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['kind', 'value', 'unit', 'subject', 'source_text', 'bbox', 'tile_id', 'confidence'],
      },
    },
    not_found: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          searched: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'searched'],
      },
    },
    sheet_notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['facts', 'not_found', 'sheet_notes'],
} as const;

const SYSTEM = `You read architectural drawing tiles and report values that are PRINTED on them.

Absolute rules:

1. Only report a value that is written on the drawing as text: a dimension string, a level mark, a door or window tag, a schedule cell, or a general note. Never estimate a size from how long a line looks or how big a room appears. If a value is not printed, it is not a fact.
2. source_text must be the characters exactly as printed, including the unit and any sign, for example "0.80 m", "NPT = +00.15", "T/O SLAB +102.50", "16 R @ 190".
3. unit must be the unit as printed. If the printed value has no unit, set unit to null; do not guess one. Many sheets are dual-dimensioned, for example 10.00 m [32'-9 3/4"]; report the primary value and its own unit, and never mix the two systems.
4. bbox is [x0, y0, x1, y1] in pixels within the tile you read it from, origin top-left. tile_id is that tile's id.
5. Report the notation the sheet actually uses. Do not translate it, normalise it, or expect any particular abbreviation.
6. subject says what the value belongs to, using the sheet's own room or element label, for example "P2 door at entrance hall" or "guard at rooftop terrace".
7. confidence is how sure you are that you read the characters correctly, from 0 to 1. Lower it when text is small, rotated or partly cut off.
8. For every requested fact kind you could not find, add an entry to not_found naming where you looked, for example "door schedule", "section A", "general notes". An absence recorded this way is useful; a guess is not.
9. Do not infer one fact from another. If a section shows a floor level and a ceiling level, report both level marks as they are printed. Do not subtract them to produce a height.

Return only JSON matching the schema.`;

/** What the rule set needs, phrased for a reader rather than as field names. */
const KIND_DESCRIPTIONS: Record<string, string> = {
  guard_height_mm: 'the height of a guard, railing or parapet, where printed',
  guard_opening_mm: 'the spacing or opening size in a guard or railing infill',
  door_width_mm: 'door widths, from tags, schedules or dimension strings',
  door_height_mm: 'door heights',
  riser_height_mm: 'stair riser height, often written as "R" or "rise"',
  tread_run_mm: 'stair tread run or going',
  riser_count: 'the number of risers in a flight, from tread numbering or a note like "16R"',
  ceiling_height_mm: 'a printed clear or ceiling height',
  egress_window_area_m2: 'bedroom window clear opening area',
  egress_window_min_dimension_mm: 'bedroom window clear opening width or height',
  limiting_distance_m: 'distance from an exterior wall to a property line',
  exposing_wall_rating_min: 'a fire-resistance rating on an exterior wall, in minutes or hours',
  glazing_area_ratio: 'glazed area as a percentage or ratio of an exposing building face',
  garage_air_barrier: 'a note describing an air barrier between a garage and the dwelling',
  garage_door_spec: 'a note specifying the garage to dwelling door, such as self-closing or weather-stripped',
  smoke_alarm_location: 'smoke alarm symbols or notes and where they are',
  co_alarm_location: 'carbon monoxide alarm symbols or notes and where they are',
  energy_compliance_path: 'a stated Section 9.36 compliance path or energy tier',
  assembly_rsi: 'an RSI or R-value for a wall, roof or floor assembly',
  window_performance: 'a window U-value, USI or Energy Rating',
};

function requestedKinds(rules: Rule[]): string[] {
  const kinds = new Set<string>();
  for (const r of rules) {
    if (r.test.kind === 'numeric') kinds.add(r.test.fact_kind);
    else if (r.test.kind === 'consistency') kinds.add(r.test.fact_kind);
    else if (r.test.kind === 'presence') for (const k of r.test.fact_kinds) kinds.add(k);
    else for (const k of r.test.fact_kinds) kinds.add(k);
  }
  return [...kinds];
}

function conventionHint(c: Conventions): string {
  if (c.declared.length === 0) {
    return 'This sheet declares no legend that could be read, so assume nothing about its notation and report exactly what is printed.';
  }
  return (
    'This sheet\'s own legend declares the following, which may help you read its marks. ' +
    'Treat it as a hint, not a filter: report any notation you see, declared or not.\n' +
    c.declared.map((d) => `  - ${d}`).join('\n')
  );
}

export interface VisionExtraction {
  facts: Fact[];
  negative: NegativeEvidence[];
  notes: string[];
  /** Per-run fact counts, so §G6's stability work is visible. */
  runCounts: [number, number];
}

/**
 * Extract from one sheet, twice, with the tile order reversed on the second
 * pass (§S2's double run). A value only reported once, or reported with two
 * different readings, is marked unstable and §G6 bars it from supporting a fail.
 */
export async function extractSheetByVision(
  pdfPath: string,
  sheet: SheetInventory,
  rules: Rule[],
  conventions: Conventions,
  ledger: RunLedger,
  opts: { rendered?: RenderedSheet } = {},
): Promise<VisionExtraction> {
  const rendered = opts.rendered ?? (await renderSheet(pdfPath, sheet.pdf_page, sheet.number, sheet.size_pt));
  const kinds = requestedKinds(rules);

  const kindList = kinds
    .map((k) => `  - ${k}: ${KIND_DESCRIPTIONS[k] ?? 'as named'}`)
    .join('\n');

  const runOne = async (order: 1 | 2) => {
    const tiles = order === 1 ? rendered.tiles : [...rendered.tiles].reverse();

    const content: ContentBlock[] = [
      {
        type: 'text',
        text:
          `Sheet ${sheet.number}, titled "${sheet.title}". Scale: ${sheet.scale_statement ?? 'not stated'}. Units: ${sheet.units}.\n\n` +
          `${conventionHint(conventions)}\n\n` +
          `Report any of these fact kinds that are printed on the sheet:\n${kindList}\n\n` +
          `First image is the whole sheet for context; do not read values off it, it is downscaled. ` +
          `The tiles after it are at full resolution and overlap slightly, so the same value may appear in two tiles: report it once.`,
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: rendered.thumbnail.toString('base64') },
      },
    ];

    for (const t of tiles) {
      content.push({ type: 'text', text: `Tile ${t.id}:` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: t.png.toString('base64') },
      });
    }

    return runStage({
      stage: 'extraction',
      promptVersion: `${PROMPT_VERSION}-run${order}`,
      system: SYSTEM,
      schema: VisionOutputSchema,
      jsonSchema: VISION_JSON_SCHEMA,
      maxTokens: 16000,
      thinking: true,
      ledger,
      content,
    });
  };

  // The two passes are independent, so they run at the same time. Run one
  // after the other they took about four minutes per sheet, which is most of
  // Vercel's 300 second function limit on its own.
  const [a, b] = (await Promise.all([runOne(1), runOne(2)])).map((r) => ({
    ...r,
    facts: r.facts.map(normalizeCount),
  }));

  // Stability is agreement on the READING, not on the wording.
  //
  // Requiring the subject text to match too marked every vision fact unstable:
  // the model describes the same stair as "stair flight on sheet 01" in one run
  // and "interior stair, ground to upper" in the next. Both read 16 treads. §G6
  // exists to catch a value that changed between passes, not prose that did, and
  // the stricter test meant no vision fact could ever support a fail.
  const key = (f: z.infer<typeof ObservedFactSchema>) =>
    `${f.kind}|${String(f.value).trim().toLowerCase()}|${(f.unit ?? '').toLowerCase()}`;

  const bByKey = new Map(b.facts.map((f) => [key(f), f]));

  const tileById = new Map(rendered.tiles.map((t) => [t.id, t]));
  const facts: Fact[] = [];
  let seq = 0;

  for (const f of a.facts) {
    seq += 1;
    // Both runs read the same kind, value and unit.
    const stable = bByKey.has(key(f));

    const tile = tileById.get(f.tile_id);
    // Tile pixels to sheet points. A fact whose tile id is unknown keeps a
    // zero box rather than a fabricated one; G2 needs a region, and a wrong
    // region is worse than an obviously empty one.
    const bbox: [number, number, number, number] = tile
      ? [
          Math.round(tile.region.x + f.bbox[0] / rendered.scale),
          Math.round(tile.region.y + (tile.region.height - f.bbox[3] / rendered.scale)),
          Math.round(tile.region.x + f.bbox[2] / rendered.scale),
          Math.round(tile.region.y + (tile.region.height - f.bbox[1] / rendered.scale)),
        ]
      : [0, 0, 0, 0];

    facts.push({
      id: `v-${sheet.number}-${seq}`,
      kind: f.kind,
      value: f.value,
      unit: f.unit ?? undefined,
      subject: f.subject,
      provenance: 'drawing_text',
      sheet: sheet.number,
      tile: f.tile_id,
      bbox,
      source_text: f.source_text,
      run: 1,
      stable,
    });
  }

  // Negative evidence: a kind is only "not found" when neither run found it.
  const foundKinds = new Set([...a.facts, ...b.facts].map((f) => f.kind));
  const negByKind = new Map<string, Set<string>>();
  for (const n of [...a.not_found, ...b.not_found]) {
    if (foundKinds.has(n.kind)) continue;
    const set = negByKind.get(n.kind) ?? new Set<string>();
    for (const s of n.searched) set.add(s);
    negByKind.set(n.kind, set);
  }

  const negative: NegativeEvidence[] = [];
  for (const rule of rules) {
    const needed =
      rule.test.kind === 'numeric' || rule.test.kind === 'consistency'
        ? [rule.test.fact_kind]
        : rule.test.fact_kinds;
    const missing = needed.filter((k) => !foundKinds.has(k));
    if (missing.length === 0) continue;
    const searched = new Set<string>();
    for (const k of missing) for (const s of negByKind.get(k) ?? []) searched.add(s);
    negative.push({
      rule_id: rule.id,
      searched_for: searched.size > 0 ? [...searched] : ['the sheet tiles'],
      not_found: missing,
      sheets_searched: [sheet.number],
    });
  }

  return {
    facts,
    negative,
    notes: [...new Set([...a.sheet_notes, ...b.sheet_notes])],
    runCounts: [a.facts.length, b.facts.length],
  };
}
