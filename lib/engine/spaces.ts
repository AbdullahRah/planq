// What space an element serves, as a closed vocabulary (PLANQ_SPEC.md §S3).
//
// Several Part 9 requirements depend on the space, not the building. Table
// 9.5.5.1. gives a door 810 mm at an entrance or stair, 760 mm into other rooms
// and 610 mm into a bathroom, and sets nothing for a reach-in closet; Table
// 9.5.3.1. sets ceiling heights for rooms, not for a roof terrace. This used to
// be a single yes/no predicate for the whole building, which can never be
// right for "which door is this", so every door was reported against all three
// thresholds: 21 findings for 7 doors on the Chesnut set.
//
// The class is attached to each fact. The vision pass assigns it from what it
// sees on the plan, which works in any language and any notation. This module
// is the fallback for facts read from a text layer, and for when the model
// says "unknown": a keyword match on the label the sheet printed. It returns
// "unknown" rather than guessing, and a rule treats unknown as "could be any".

export const SPACE_CLASSES = [
  'entrance', // entrance to the dwelling, vestibule, entrance hall
  'stair', // stairway, or the line of passage to a basement
  'bedroom',
  'bathroom', // bathroom, washroom, WC, powder room, ensuite
  'walk_in_closet',
  'closet', // reach-in closet, linen, pantry cupboard
  'habitable_room', // living, dining, kitchen, family, study, den
  'hallway', // corridor or passage inside the dwelling
  'service_room', // laundry, mechanical, furnace, utility, storage
  'garage',
  'balcony', // balcony, deck, porch
  'roof', // roof, roof terrace, rooftop
  'exterior', // yard, patio, garden, service yard, outside
  'unknown',
] as const;

export type SpaceClass = (typeof SPACE_CLASSES)[number];

/**
 * Ordered: the first match wins, so the more specific phrase comes first
 * ("walk-in closet" before "closet", "entrance hall" before "hall",
 * "service yard" before "service").
 */
const KEYWORDS: Array<[SpaceClass, RegExp]> = [
  ['walk_in_closet', /\b(walk[\s-]?in|w\.?i\.?c\.?|vestidor|walk-in)\b/i],
  ['entrance', /\b(entrance|entry|foyer|vestibule|vest[ií]bulo|acceso|entrada|recibidor|hall d'entr[ée]e|entr[ée]e)\b/i],
  ['stair', /\b(stair|stairs|stairway|escalera|escalier)\b/i],
  ['bathroom', /\b(bath|bathroom|washroom|wc|w\.c\.|toilet|powder|ensuite|en[\s-]suite|lav|ba[ñn]o|aseo|toilette|salle de bain|salle d'eau)\b/i],
  ['bedroom', /\b(bed|bedroom|bdrm|br\b|master|dormitorio|rec[aá]mara|habitaci[oó]n|alcoba|chambre)\b/i],
  ['closet', /\b(closet|clo\b|clos\b|linen|lin\b|cupboard|pantry|armario|ropero|closet|placard|garde[\s-]robe)\b/i],
  ['roof', /\b(roof|rooftop|roof terrace|azotea|terraza|cubierta|pergol\w*|toit|toiture)\b/i],
  ['exterior', /\b(yard|patio|garden|jard[ií]n|exterior|outside|outdoor|grill|parrilla|cour|ext[ée]rieur)\b/i],
  ['garage', /\b(garage|garaje|cochera|carport)\b/i],
  ['balcony', /\b(balcony|deck|porch|veranda|balc[oó]n|porche|galer[ií]a|balcon|terrasse)\b/i],
  ['service_room', /\b(laundry|mech|mechanical|furnace|utility|storage|store|lavander[ií]a|cuarto de m[aá]quinas|bodega|despensa|buanderie|rangement|service room|service corridor)\b/i],
  ['hallway', /\b(hall|hallway|corridor|passage|pasillo|corredor|couloir)\b/i],
  ['habitable_room', /\b(living|dining|kitchen|kit\b|family|fam\.?\s*rm|den|study|office|great room|rec\.?\s*(room|rm)|recreation|breakfast|nook|liv\.?\s*rm|din\.?\s*rm|bonus|media|sala|comedor|cocina|estudio|salon|salle [àa] manger|cuisine|bureau)\b/i],
];

/** Classify from a printed label. "unknown" when nothing matches, never a guess. */
export function classifySpace(label: string | undefined | null): SpaceClass {
  if (!label) return 'unknown';
  for (const [cls, re] of KEYWORDS) if (re.test(label)) return cls;
  return 'unknown';
}

export function isSpaceClass(v: unknown): v is SpaceClass {
  return typeof v === 'string' && (SPACE_CLASSES as readonly string[]).includes(v);
}
