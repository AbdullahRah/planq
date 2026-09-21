// TypeSafe (Jev) — System One judgments used as verification gates.
//
// Everything a human needs to review lives in this file: the questions we ask
// and the thresholds we act on. Nothing else in the codebase should define a
// TypeSafe question or a cutoff, so a reviewer can audit the model's influence
// on results by reading one file.
//
// Jev returns typed answers with calibrated probabilities rather than prose.
// We use it where ordinary code needs semantic understanding — deciding whether
// a retrieved code section actually supports a claimed violation — and keep
// arithmetic, rule lookup, and the workflow itself in code.
//
// Docs: https://docs.typesafe.ai/api.md

import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';

export const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL ?? 'jev-latest';

/**
 * Verification is on whenever a key is present. It only ever removes or
 * downgrades unsupported findings, so there is no failure mode where enabling
 * it invents a violation. Set TYPESAFE_VERIFY=off to disable it explicitly.
 */
export function verificationEnabled(): boolean {
  if ((process.env.TYPESAFE_VERIFY ?? '').toLowerCase() === 'off') return false;
  return Boolean(process.env.TYPESAFE_API_KEY);
}

let client: TypeSafeClient | null = null;

export function typesafe(): TypeSafeClient {
  if (!client) {
    client = new TypeSafeClient({
      // A sheet's plan data plus a code section is a larger state than the SDK's
      // 10s default assumes.
      timeout: 30_000,
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Thresholds — review these first. Each is a probability in [0, 1].
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /**
   * Retrieval relevance at or above which a chunk is allowed into the
   * compliance prompt. Fast search (pgvector, or the keyword fallback) returns
   * plausible chunks; this is the cutoff for "states a requirement that
   * actually governs what we asked about".
   */
  retrievalFloor: 0.5,

  /**
   * How many chunks survive per compliance category after reranking. Fewer,
   * better chunks means a smaller citation allowlist in lib/analyze.ts, which
   * is what makes a wrong-but-permitted citation less likely.
   */
  retrievalKeep: 4,

  /**
   * Choice confidence required before an INFERRED NBC Part may gate which
   * deterministic rules run. Set higher than the citation cutoff on purpose: a
   * wrong Part silently changes which limits apply to every element on the
   * sheet, so the failure is broad and quiet. Below this, the part stays
   * unknown and the engine keeps its existing behaviour of not dropping checks.
   */
  occupancyAutoAccept: 0.85,

  /**
   * Choice confidence at or above which a citation verdict stands on its own.
   * Below it the finding survives but is marked for human review rather than
   * being silently trusted. The citation-check cookbook starts at 0.8 and
   * lowers it as trust builds on real data; we have not yet measured Planq's
   * own corpus, so we start there too.
   */
  citationAutoAccept: 0.8,

  /**
   * Noul probability at or above which we accept that the element a finding
   * describes is actually present in the extracted sheet. Below `groundedFloor`
   * the finding is dropped as ungrounded — the model is confident the plan data
   * does not contain what the finding claims to have measured.
   */
  groundedAccept: 0.5,
  groundedFloor: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Questions. Question ids are for our code and are never sent to the model, so
// each `instructions` carries its full meaning on its own.
// ---------------------------------------------------------------------------

/**
 * The citation gate. Mirrors the "double-checking citations" cookbook: the
 * quote may be real and the claim built on it still wrong, so the model reads
 * the cited section and says how it relates to the requirement being asserted.
 */
export const CITATION_QUESTIONS = {
  relation: choice(
    'The finding asserts that the building code imposes a specific requirement, and cites `cited_code_text` as the authority for it. How does `cited_code_text` relate to the requirement the finding asserts?',
    {
      supports:
        'The cited code text states the asserted requirement, or directly implies it — including where the finding states the same limit in different units.',
      contradicts:
        'The cited code text states a different requirement that would make the finding wrong, for example a different numeric limit for the same element, or an exemption that covers this element.',
      says_nothing:
        'The cited code text does not address the requirement the finding asserts, either way. It may concern a different element, a different occupancy, or an unrelated topic.',
    },
  ),

  /**
   * The second leg of a violation: not "does the code say X" but "does this
   * plan actually show the thing that breaks X". Catches findings the model
   * produced from nothing when a sheet extracted thinly.
   */
  grounded: noul(
    'The finding claims to have measured or observed a specific element on this drawing. Is that element, with the measurement the finding reports, actually present in `extracted_plan_data`?',
    {
      true: 'The element and its reported measurement appear in the extracted plan data, allowing for unit conversion and for a differently worded but equivalent label.',
      false:
        'The extracted plan data does not contain the element, or contains it with a materially different measurement than the finding reports.',
    },
  ),
} as const;

/**
 * Reranking. Fast search can say a chunk is *similar* to the query; it cannot
 * say the chunk states a requirement that governs it. That distinction matters
 * here because the corpus chunker mislabels badly — a chunk labelled 9.8.5.2
 * can carry the body of 9.9.3.3 — so lib/analyze.ts harvests citable section
 * numbers out of chunk bodies. Every extra irrelevant chunk therefore widens
 * the set of section numbers the model is permitted to cite.
 *
 * Scored one query-candidate pair at a time, as the reranking cookbook
 * prescribes, so the scores are comparable across candidates.
 */
export const RETRIEVAL_QUESTIONS = {
  relevant: noul(
    'Does `code_passage` state a building code requirement that governs the subject described in `looking_for`?',
    {
      true: 'The passage states a requirement, limit, dimension or prohibition that applies to the subject asked about — including where it states it as a table reference or an exception to it.',
      false:
        'The passage concerns a different subject, or it is application, scope, definition, cross-reference or explanatory-note text that imposes no requirement on the subject asked about.',
    },
  ),
} as const;

/**
 * Occupancy classification. `detectBuildingPart` in lib/rule-engine/occupancy.ts
 * is a regex over free text and stays authoritative — this is consulted only
 * when that regex finds nothing, which on real sheets is common. The Part
 * decides which rules apply and which sections may be cited, so `unclear` is a
 * first-class answer and a low-confidence result is treated as unknown rather
 * than guessed.
 */
export const OCCUPANCY_QUESTIONS = {
  building_part: choice(
    'Which Part of the National Building Code of Canada governs the building described by `drawing_data`?',
    {
      Part9:
        'Part 9, Housing and Small Buildings: detached, semi-detached or row housing, or another building of 3 storeys or fewer and 600 m² or less in building area, used for residential, business, personal service, mercantile or low-hazard industrial occupancy.',
      Part3:
        'Part 3, Fire Protection and Occupant Safety: assembly, care, detention, high-hazard industrial or high-rise buildings, or any building exceeding the Part 9 limits of 3 storeys or 600 m² in building area.',
      unclear:
        'The drawing data does not state enough about occupancy, storeys or building area to determine which Part applies. Choose this rather than inferring from room names alone.',
    },
  ),
} as const;
