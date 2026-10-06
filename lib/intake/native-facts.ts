// Facts read straight off the native text layer (PLANQ_SPEC.md §S2).
//
// Everything here is deterministic: a printed string is matched, its verbatim
// text and position are recorded, and any arithmetic runs in code. Nothing in
// this file asks a model anything, so §G4 holds trivially and §G2 is satisfied
// by construction - a fact cannot be produced without its sheet, region and
// source text.
//
// What it deliberately does NOT do is decide meaning. "LEVEL=+6.35" above
// "NPT=+5.85" is a 0.50 m difference, but whether that difference is a parapet,
// a guard or a roof build-up is a reading of the drawing, and that is S2's
// model pass. So level marks are emitted as level facts with their neighbours
// attached, and the semantic rules stay out of here.

import type { DrawingFact, Fact } from '../schemas';
import type { SheetInventory, SheetTextItem } from './sheets';

/** "0.80 m" / "1.10 m" / "810 mm" / "2.60m" */
const DIM_RE = /^(\d+(?:[.,]\d+)?)\s*(mm|cm|m)\b/i;
/** A door tag as the Chesnut legend defines it ("WIDTH OF DOORS", tags P1/P2). */
const DOOR_TAG_RE = /^(P\d{1,2}|D\d{1,2})$/i;
/** "NPT = +00.15" / "LEVEL=±0.00" / "NLT=+02.75" */
const LEVEL_RE = /^(NPT|NLT|LEVEL)\s*=\s*([+\-±]?)\s*(\d+(?:[.,]\d+)?)/i;

function num(raw: string): number {
  return Number(raw.replace(',', '.'));
}

function bboxOf(i: SheetTextItem): [number, number, number, number] {
  return [
    Math.round(i.x),
    Math.round(i.y),
    Math.round(i.x + i.width),
    Math.round(i.y + i.height),
  ];
}

function dist(a: SheetTextItem, b: SheetTextItem): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Room and space labels, used to say which door or space a fact belongs to. */
const ROOM_WORDS =
  /(bedroom|bathroom|closet|kitchen|living|dining|garage|entrance|hall|corridor|terrace|rooftop|garden|service|maid|utility|stair|balcony|yard|grill|pergolado)/i;

function nearestRoom(item: SheetTextItem, sheet: SheetInventory): string | undefined {
  const rooms = sheet.text_items.filter((t) => ROOM_WORDS.test(t.text));
  if (rooms.length === 0) return undefined;
  const best = rooms
    .map((r) => ({ r, d: dist(item, r) }))
    .sort((a, b) => a.d - b.d)[0];
  // Beyond a couple of hundred points the "nearest" label is on another part
  // of the sheet and attributing to it would be an invention.
  return best.d <= 200 ? best.r.text.trim().replace(/\s+/g, ' ') : undefined;
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function resetFactIds(): void {
  seq = 0;
}

function drawing(
  f: Omit<DrawingFact, 'provenance' | 'run' | 'stable' | 'tile'> & { tile?: string },
): DrawingFact {
  return {
    ...f,
    provenance: 'drawing_text',
    tile: f.tile ?? `${f.sheet}-native`,
    run: 1,
    // A native string is read, not inferred, so it is the same on every pass.
    // §G6's instability concept applies to the vision runs, not to this.
    stable: true,
  };
}

/**
 * Door widths from tag + dimension pairs. The Chesnut legend prints the tag
 * ("P2") and its width ("0.80 m") as two items at the same spot, so a tag is
 * paired with the dimension string nearest to it.
 */
export function extractDoorWidths(sheet: SheetInventory): DrawingFact[] {
  const tags = sheet.text_items.filter((i) => DOOR_TAG_RE.test(i.text.trim()));
  const dims = sheet.text_items.filter((i) => DIM_RE.test(i.text.trim()));
  const out: DrawingFact[] = [];

  for (const tag of tags) {
    const near = dims
      .map((d) => ({ d, dist: dist(tag, d) }))
      .filter((x) => x.dist <= 20)
      .sort((a, b) => a.dist - b.dist)[0];
    if (!near) continue;

    const m = near.d.text.trim().match(DIM_RE)!;
    const room = nearestRoom(tag, sheet);
    out.push(
      drawing({
        id: id('door'),
        kind: 'door_width_mm',
        value: num(m[1]),
        unit: m[2].toLowerCase(),
        subject: `${tag.text.trim()} door${room ? ` at ${room}` : ''}`,
        sheet: sheet.number,
        bbox: bboxOf(tag),
        source_text: `${tag.text.trim()} ${near.d.text.trim()}`,
      }),
    );
  }
  return out;
}

/**
 * Riser counts. A stair is numbered tread by tread, so a column of consecutive
 * integers is a flight and its highest number is the riser count. Runs are
 * grouped by x position because the numbers climb vertically.
 */
export function extractRiserCounts(sheet: SheetInventory): DrawingFact[] {
  const nums = sheet.text_items
    .filter((i) => /^\d{1,2}$/.test(i.text.trim()))
    .map((i) => ({ item: i, n: Number(i.text.trim()) }));

  // Tread numbers do not sit in a straight column: a flight that turns, or is
  // drawn on an angle, walks diagonally across the sheet. A fixed x-bucket
  // split the Chesnut flights into fragments and reported 6 risers where the
  // plan shows 16, which also lost the 16-vs-17 conflict against the section.
  //
  // So chain instead of bucket: starting from a "1", repeatedly look for the
  // next consecutive number within a short radius of the last one. That follows
  // a flight wherever it goes and does not care about its orientation.
  const RADIUS = 40;
  const used = new Set<typeof nums[number]>();
  const out: DrawingFact[] = [];

  for (const start of nums.filter((e) => e.n === 1)) {
    if (used.has(start)) continue;
    const chain = [start];
    let last = start;

    for (let want = 2; want <= 60; want++) {
      const next = nums
        .filter((e) => e.n === want && !used.has(e))
        .map((e) => ({ e, d: Math.hypot(e.item.x - last.item.x, e.item.y - last.item.y) }))
        .filter((x) => x.d <= RADIUS)
        .sort((a, b) => a.d - b.d)[0];
      if (!next) break;
      chain.push(next.e);
      last = next.e;
    }

    // A handful of consecutive numbers could be a grid or a dimension string;
    // a flight of stairs in a house runs to a dozen or more.
    if (chain.length < 8) continue;
    for (const c of chain) used.add(c);

    const top = chain[chain.length - 1];
    out.push(
      drawing({
        id: id('risers'),
        kind: 'riser_count',
        value: chain.length,
        unit: 'count',
        subject: `stair flight on sheet ${sheet.number}`,
        sheet: sheet.number,
        bbox: bboxOf(top.item),
        source_text: `tread numbers 1 to ${chain.length}`,
      }),
    );
  }
  return out;
}

export interface LevelMark {
  kind: 'NPT' | 'NLT' | 'LEVEL';
  /** Metres, signed. "±0.00" is 0. */
  value: number;
  item: SheetTextItem;
  room?: string;
}

/**
 * Every printed level mark on a sheet, with the space it sits nearest to.
 *
 * These are not emitted as rule-ready facts: a level on its own satisfies no
 * rule. Deciding that +6.35 over +5.85 is a 0.50 m parapet, and that the
 * parapet is what a guard rule applies to, is the reading S2 does. Handing the
 * model a clean list of marks with positions is the point.
 */
export function extractLevelMarks(sheet: SheetInventory): LevelMark[] {
  const out: LevelMark[] = [];
  for (const i of sheet.text_items) {
    const m = i.text.trim().match(LEVEL_RE);
    if (!m) continue;
    const sign = m[2] === '-' ? -1 : 1;
    out.push({
      kind: m[1].toUpperCase() as LevelMark['kind'],
      value: sign * num(m[3]),
      item: i,
      room: nearestRoom(i, sheet),
    });
  }
  return out;
}

/**
 * Clear height per space, where the sheet prints both a finished floor level
 * (NPT) and the ceiling level above it (NLT) at the same place. NLT minus NPT
 * is the clear height, computed in code.
 *
 * This pairing is stated by the drawing's own symbology legend ("FINISHED FLOOR
 * LEVEL", "LEVEL IN ELEVATIONS"), not guessed, which is why it belongs here
 * rather than in the model pass.
 */
export function extractClearHeights(sheet: SheetInventory): DrawingFact[] {
  const marks = extractLevelMarks(sheet);
  const floors = marks.filter((m) => m.kind === 'NPT');
  const ceilings = marks.filter((m) => m.kind === 'NLT');
  const out: DrawingFact[] = [];

  for (const ceil of ceilings) {
    // The floor this ceiling belongs to is the nearest NPT mark below it.
    const below = floors
      .filter((f) => f.value < ceil.value)
      .map((f) => ({ f, d: dist(ceil.item, f.item) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!below || below.d > 300) continue;

    const metres = Math.round((ceil.value - below.f.value) * 100) / 100;
    if (metres <= 0 || metres > 10) continue;

    out.push(
      drawing({
        id: id('clear'),
        kind: 'ceiling_height_mm',
        value: metres,
        unit: 'm',
        subject: ceil.room ?? below.f.room ?? `space on sheet ${sheet.number}`,
        sheet: sheet.number,
        bbox: bboxOf(ceil.item),
        source_text: `${ceil.item.text.trim()} over ${below.f.item.text.trim()}`,
      }),
    );
  }
  return out;
}

export interface NativeExtraction {
  facts: Fact[];
  levels: LevelMark[];
  /** Printed strings that look like evidence but were not turned into a fact. */
  unconsumed: string[];
}

export function extractNativeFacts(sheets: SheetInventory[]): NativeExtraction {
  resetFactIds();
  const facts: Fact[] = [];
  const levels: LevelMark[] = [];

  for (const sheet of sheets) {
    if (!sheet.has_text_layer) continue;
    facts.push(...extractDoorWidths(sheet));
    facts.push(...extractRiserCounts(sheet));
    facts.push(...extractClearHeights(sheet));
    levels.push(...extractLevelMarks(sheet));
  }

  // Dedupe clear heights: a section repeats the same storey several times.
  const seen = new Set<string>();
  const deduped = facts.filter((f) => {
    const key = `${f.kind}|${f.value}|${f.unit}|${f.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { facts: deduped, levels, unconsumed: [] };
}
