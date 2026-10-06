// S4, adversarial verification (PLANQ_SPEC.md §S4, §G7). Opus.
//
// Every proposed fail and needs_confirmation is handed to a stronger model whose
// instruction is to refute it. Anything not upheld is downgraded one level and
// routed to the reviewer queue.
//
// The prompt is deliberately unlike S3's. S3 asks "does this value meet the
// threshold"; S4 asks "is there a reason this finding is wrong" - a different
// question, so a shared blind spot is less likely to survive both.
//
// §7 gives the case this exists for: a rooftop guard flagged because a section
// shows a 0.50 m parapet. A guard may sit on top of that parapet without being
// drawn, so the honest status is "fail pending confirmation that no additional
// guard is shown" until a verifier or a human settles it.

import { z } from 'zod';
import {
  downgrade,
  VERIFIABLE_STATUSES,
  type ClauseRecord,
  type Fact,
  type Finding,
} from '../schemas';
import { runStage, type ContentBlock, type RunLedger } from './runner';

const PROMPT_VERSION = 's4-2026-10-05';

const VerdictSchema = z.object({
  verdict: z.enum(['upheld', 'refuted', 'uncertain']),
  reason: z.string().min(1),
  /** What, if anything, on the drawings might satisfy the requirement instead. */
  alternative_evidence: z.string().nullable(),
});

const VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['upheld', 'refuted', 'uncertain'] },
    reason: { type: 'string' },
    alternative_evidence: { type: ['string', 'null'] },
  },
  required: ['verdict', 'reason', 'alternative_evidence'],
} as const;

const SYSTEM = `You are reviewing a proposed code finding written by another system, and your job is to try to refute it. Assume it may be wrong and look for the reason.

Ask yourself, in this order:

1. Does the quoted clause actually impose the requirement the finding claims? Check the exact wording, including any "except as provided in" that points at an exception.
2. Does an exception in the quoted sentences apply to this building? A lower limit for a dwelling unit, a height threshold, a sprinklered allowance.
3. Could something else on the drawings satisfy the requirement without being the element the finding looked at? A guard on top of a parapet, a second door, a note elsewhere on the set. This is the most common reason a finding is wrong.
4. Is the measured value actually the thing the clause regulates? A parapet height is not a guard height. A floor-to-floor dimension is not a clear ceiling height.
5. Does the evidence cited support the value claimed?

Verdicts:
- "refuted" when you can point to a specific reason the finding is wrong.
- "uncertain" when the finding may be right but the drawings do not settle it, including when something not shown could satisfy the requirement.
- "upheld" only when none of the above applies and the finding follows from the clause and the evidence.

You cannot see the whole drawing set, only what is given. If the answer depends on something you were not shown, that is "uncertain", not "upheld".

reason is one or two sentences for a human reviewer. Return only JSON matching the schema.`;

export interface VerificationInput {
  finding: Finding;
  /** The stored clause records for the finding's cited ids. */
  clauses: ClauseRecord[];
  /** The facts the finding rests on. */
  facts: Fact[];
  /** Cropped evidence, when the caller produced one. */
  evidence?: Buffer;
}

export interface VerifiedFinding {
  finding: Finding;
  /** True when the verdict changed the status. */
  downgraded: boolean;
}

export async function verifyFinding(
  input: VerificationInput,
  ledger: RunLedger,
): Promise<VerifiedFinding> {
  const { finding, clauses, facts } = input;

  const clauseText = clauses
    .map((c) => `${c.id} ${c.title} (${c.edition}, printed p.${c.printed_page}):\n${c.text}`)
    .join('\n\n');

  const factText = facts
    .map(
      (f) =>
        `  ${f.kind} = ${f.value}${f.unit ? ` ${f.unit}` : ''} for "${f.subject}"\n` +
        `    read as: "${f.source_text}"\n` +
        `    from: ${f.provenance === 'drawing_text' ? `sheet ${f.sheet}, tile ${f.tile}` : f.entity_path}` +
        `${f.stable ? '' : '  [UNSTABLE: read in only one of two extraction passes]'}`,
    )
    .join('\n');

  const computed = Object.entries(finding.computed)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  const content: ContentBlock[] = [
    {
      type: 'text',
      text:
        `Proposed finding ${finding.id}, status "${finding.status}":\n${finding.summary}\n\n` +
        `Clause(s) cited, quoted from the code store:\n\n${clauseText}\n\n` +
        `Facts it rests on:\n${factText || '  (none)'}\n\n` +
        `Computed in code:\n${computed || '  (none)'}\n\n` +
        `Drawing reference: ${finding.drawing_reference ?? 'not recorded'}\n\n` +
        `Try to refute this finding.`,
    },
  ];

  if (input.evidence) {
    content.push({ type: 'text', text: 'Cropped evidence from the sheet:' });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: input.evidence.toString('base64') },
    });
  }

  const out = await runStage({
    stage: 'verifier',
    promptVersion: PROMPT_VERSION,
    system: SYSTEM,
    schema: VerdictSchema,
    jsonSchema: VERDICT_JSON_SCHEMA,
    maxTokens: 4000,
    thinking: true,
    ledger,
    content,
  });

  const reason = out.alternative_evidence
    ? `${out.reason} Possible alternative on the drawings: ${out.alternative_evidence}`
    : out.reason;

  // §G7: anything not upheld is downgraded one level and queued for a human.
  const status = out.verdict === 'upheld' ? finding.status : downgrade(finding.status);

  return {
    finding: {
      ...finding,
      status,
      verifier: out.verdict,
      verifier_reason: reason,
    },
    downgraded: status !== finding.status,
  };
}

/**
 * Verify every finding §G7 requires, leaving the rest untouched. Sequential on
 * purpose: the verifier is the most expensive stage, and the ledger has to be
 * able to stop the run mid-way when the budget runs out (§G11).
 */
export async function verifyFindings(
  findings: Finding[],
  resolve: (f: Finding) => { clauses: ClauseRecord[]; facts: Fact[]; evidence?: Buffer },
  ledger: RunLedger,
): Promise<{ findings: Finding[]; verified: number; downgraded: number; skipped: number }> {
  const out: Finding[] = [];
  let verified = 0;
  let downgraded = 0;
  let skipped = 0;

  for (const f of findings) {
    if (!VERIFIABLE_STATUSES.includes(f.status)) {
      out.push(f);
      continue;
    }
    try {
      const { clauses, facts, evidence } = resolve(f);
      const res = await verifyFinding({ finding: f, clauses, facts, evidence }, ledger);
      out.push(res.finding);
      verified += 1;
      if (res.downgraded) downgraded += 1;
    } catch (err) {
      // A verifier that could not run must not leave a finding looking verified.
      // §G7 downgrades anything not upheld, and "not run" is not upheld.
      out.push({
        ...f,
        status: downgrade(f.status),
        verifier: 'uncertain',
        verifier_reason: `verification could not be completed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      skipped += 1;
    }
  }

  return { findings: out, verified, downgraded, skipped };
}
