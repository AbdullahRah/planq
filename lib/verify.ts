// Verification gate for model-authored findings.
//
// lib/analyze.ts already refuses citations whose section number never appeared
// in the retrieved text. That catches invented numbers but not misapplied ones:
// a finding can cite 9.9.3.3 because that number happens to sit in the context
// window while the requirement it asserts is nowhere in 9.9.3.3.
//
// This module closes that gap. For each model-authored finding it reads the
// text of the section actually cited and asks Jev how that text relates to the
// asserted requirement, plus whether the element the finding claims to have
// measured is really in the extracted plan data. Raw judgments come back from
// `judgeFinding`; `applyPolicy` turns them into a keep/strip/drop decision.
// The two are separate so thresholds can move without re-running inference.
//
// Deterministic rule-engine findings are never sent here. They are arithmetic
// against a rules table and already carry an exact citation; letting a model
// veto them would trade a defensible result for a probabilistic one.

import type { JsonValue } from '@typesafe-ai/sdk';
import { CITATION_QUESTIONS, THRESHOLDS, TYPESAFE_MODEL, typesafe, verificationEnabled } from './typesafe';
import type { CodeChunk, ExtractedSheet, Violation, ViolationVerification } from './types';

const MAX_CODE_TEXT = 4000;
const MAX_PLAN_JSON = 6000;
const CONCURRENCY = 4;

/**
 * The text a reviewer would read to check a citation. Chunk labels are
 * unreliable (the chunker points section_id at the preceding heading), so
 * gather both chunks labelled with the section and chunks whose body mentions
 * it, which is the same evidence the model was shown when it wrote the finding.
 */
export function codeTextForSection(chunks: CodeChunk[], sectionId: string): string {
  const root = sectionId.split('#')[0].trim();
  if (!root) return '';
  const parts: string[] = [];
  for (const c of chunks) {
    const label = (c.section_id ?? '').split('#')[0];
    const body = (c.content ?? '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const labelled = label === root || label.startsWith(root + '.') || root.startsWith(label + '.');
    const mentioned = body.includes(root);
    if (!labelled && !mentioned) continue;
    parts.push(c.section_title ? `${label} ${c.section_title}: ${body}` : `${label}: ${body}`);
    if (parts.join('\n\n').length >= MAX_CODE_TEXT) break;
  }
  return parts.join('\n\n').slice(0, MAX_CODE_TEXT);
}

/**
 * The measurable content of a sheet, without the annotation bulk that would
 * dominate the state without helping the grounding judgment.
 */
export function planDataForSheet(sheet: ExtractedSheet): Record<string, unknown> {
  return {
    sheet_name: sheet.sheet_name,
    occupancy_type: sheet.occupancy_type ?? null,
    building_type: sheet.building_type ?? null,
    rooms: sheet.rooms,
    doors: sheet.doors,
    corridors: sheet.corridors,
    stairs: sheet.stairs,
    egress_paths: sheet.egress_paths,
    dimensions: sheet.dimensions,
  };
}

function trimJson(value: unknown, limit: number): unknown {
  const text = JSON.stringify(value);
  if (text.length <= limit) return value;
  return `${text.slice(0, limit)}… (truncated)`;
}

export interface Judgment {
  relation?: 'supports' | 'contradicts' | 'says_nothing';
  relation_confidence?: number;
  grounded?: number;
  model?: string;
  error?: string;
}

/**
 * One Jev request per finding. The two questions are independent judgments over
 * the same state, so they travel together and run in parallel server-side.
 * A finding whose citation was already stripped still gets the grounding check.
 */
export async function judgeFinding(
  violation: Violation,
  codeText: string,
  sheet: ExtractedSheet,
): Promise<Judgment> {
  const hasCitation = Boolean(violation.section_id && codeText);

  const planData = trimJson(planDataForSheet(sheet), MAX_PLAN_JSON) as JsonValue;

  try {
    // Two independent judgments over one state travel in a single request.
    // Without a citation there is nothing to relate the finding to, so only the
    // grounding question is worth asking.
    if (!hasCitation) {
      const response = await typesafe().systemOne({
        state: { finding: violation.description, extracted_plan_data: planData },
        questions: { grounded: CITATION_QUESTIONS.grounded },
        model: TYPESAFE_MODEL,
      });
      return { grounded: response.answers.grounded.noul, model: response.model };
    }

    const response = await typesafe().systemOne({
      state: {
        finding: violation.description,
        cited_section: violation.section_id ?? '',
        cited_code_text: codeText,
        extracted_plan_data: planData,
      },
      questions: {
        relation: CITATION_QUESTIONS.relation,
        grounded: CITATION_QUESTIONS.grounded,
      },
      model: TYPESAFE_MODEL,
    });
    return {
      relation: response.answers.relation.choice,
      relation_confidence: response.answers.relation.confidence,
      grounded: response.answers.grounded.noul,
      model: response.model,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A verification outage must not delete findings. Report it and let the
    // finding through unchecked so the caller can say so in its warnings.
    // eslint-disable-next-line no-console
    console.error('[verify] judgement failed', err);
    return { error: message };
  }
}

export interface PolicyDecision {
  action: 'keep' | 'strip_citation' | 'drop';
  verification: ViolationVerification;
}

/**
 * Judgment -> decision. Pure, so thresholds can be retuned and re-reviewed
 * without another API call.
 */
export function applyPolicy(judgment: Judgment): PolicyDecision {
  if (judgment.error) {
    return {
      action: 'keep',
      verification: { verdict: 'unchecked', note: `verification unavailable: ${judgment.error}` },
    };
  }

  const base: ViolationVerification = {
    verdict: 'unchecked',
    relation: judgment.relation,
    relation_confidence: judgment.relation_confidence,
    grounded: judgment.grounded,
    model: judgment.model,
  };

  // Leg 1: does this plan actually show what the finding says it measured?
  if (judgment.grounded != null && judgment.grounded < THRESHOLDS.groundedFloor) {
    return {
      action: 'drop',
      verification: {
        ...base,
        verdict: 'ungrounded',
        note: `the extracted plan data does not contain this element or measurement (p=${judgment.grounded.toFixed(2)})`,
      },
    };
  }

  const confident =
    judgment.relation_confidence != null &&
    judgment.relation_confidence >= THRESHOLDS.citationAutoAccept;

  // Leg 2: does the cited section carry the requirement being asserted?
  if (judgment.relation === 'contradicts' && confident) {
    return {
      action: 'drop',
      verification: {
        ...base,
        verdict: 'contradicted',
        note: 'the cited code section states a different requirement than this finding asserts',
      },
    };
  }

  if (judgment.relation === 'says_nothing' && confident) {
    return {
      action: 'strip_citation',
      verification: {
        ...base,
        verdict: 'unsupported',
        note: 'the cited code section does not address this requirement; citation removed, observation kept',
      },
    };
  }

  if (
    judgment.relation === 'supports' &&
    confident &&
    (judgment.grounded == null || judgment.grounded >= THRESHOLDS.groundedAccept)
  ) {
    return { action: 'keep', verification: { ...base, verdict: 'verified' } };
  }

  if (judgment.relation == null && judgment.grounded != null) {
    // No citation to check — grounding alone decides.
    return {
      action: 'keep',
      verification: {
        ...base,
        verdict: judgment.grounded >= THRESHOLDS.groundedAccept ? 'verified' : 'needs_review',
        note: judgment.relation == null ? 'no citation to verify; grounding checked only' : undefined,
      },
    };
  }

  return {
    action: 'keep',
    verification: {
      ...base,
      verdict: 'needs_review',
      note: 'the model was not confident enough for its verdict to stand on its own',
    },
  };
}

export interface VerifyOutput {
  violations: Violation[];
  dropped: Array<{ violation: Violation; verification: ViolationVerification }>;
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Verify every model-authored finding for one sheet. Returns the survivors and,
 * separately, what was removed — a dropped finding is always reportable, never
 * silently discarded.
 */
export async function verifyViolations(
  violations: Violation[],
  sheet: ExtractedSheet,
  chunks: CodeChunk[],
  // Seam for tests: swap the model call out without touching the network.
  judge: typeof judgeFinding = judgeFinding,
): Promise<VerifyOutput> {
  if (!verificationEnabled() || violations.length === 0) {
    return { violations, dropped: [] };
  }

  const judgments = await pooled(violations, CONCURRENCY, (v) =>
    judge(v, v.section_id ? codeTextForSection(chunks, v.section_id) : '', sheet),
  );

  const kept: Violation[] = [];
  const dropped: VerifyOutput['dropped'] = [];

  violations.forEach((v, i) => {
    const { action, verification } = applyPolicy(judgments[i]);
    if (action === 'drop') {
      dropped.push({ violation: v, verification });
      return;
    }
    if (action === 'strip_citation') {
      kept.push({ ...v, section_id: undefined, code_citation: undefined, verification });
      return;
    }
    kept.push({ ...v, verification });
  });

  return { violations: kept, dropped };
}
