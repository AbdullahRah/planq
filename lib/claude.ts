// The one place model ids live (PLANQ_SPEC.md §2.3).
//
// Spec §2.3 names `claude-haiku-4-5-20251001`, `claude-sonnet-5-5` and
// `claude-opus-5-5`. None of those are real model ids: the Anthropic API takes
// the bare id with no date suffix, and there is no 5-5 generation. The tiers
// the spec intends map to the current models below. Opus 5 also lists at
// $5/$25 per MTok rather than the $4/$20 assumed in §10, so the cost ceilings
// in §10 need re-deriving from measured usage, which G10 logs anyway.

import Anthropic from '@anthropic-ai/sdk';

/**
 * The client, built on first use rather than at import.
 *
 * Constructing it at module scope read the environment before dotenv had loaded
 * .env.local: ES imports are hoisted, so this module ran before the caller's
 * loadEnv() and every run died with "Could not resolve authentication method"
 * despite a valid key being on disk.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (client) return client;
  // An API key that is not scoped to a single workspace must name one per
  // request, or every call fails with a 400 asking for this header. A
  // workspace-scoped key needs nothing here.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  client = new Anthropic({
    // Resolves ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an
    // `ant auth login` profile. Never hardcode a key.
    maxRetries: 2,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });
  return client;
}

/** Back-compat accessor so call sites read naturally. */
export const anthropic = {
  get messages() {
    return getAnthropic().messages;
  },
  get beta() {
    return getAnthropic().beta;
  },
};

/**
 * Per-stage model routing. One id per job so a stage can be re-pointed without
 * hunting through prompts, and so G10's audit trail can record exactly which
 * model produced each artifact.
 */
export const MODELS = {
  /** S1 applicability, cheap classification. 200K context, not 1M. */
  applicability: 'claude-haiku-4-5',
  /** S2 fact extraction from drawing tiles (vision). */
  extraction: 'claude-sonnet-5',
  /** S3 judgment rules that cannot be reduced to a number. */
  judgment: 'claude-sonnet-5',
  /** S5 report assembly from finding records. */
  report: 'claude-sonnet-5',
  /** S4 adversarial verifier. Deliberately a stronger model than S3. */
  verifier: 'claude-opus-5',
} as const;

export type StageName = keyof typeof MODELS;

/** List price per million tokens, for the G10 cost log and the §10 budgets. */
export const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
};

/** Per-run token budgets from §10, in US dollars. G11 stops a run that exceeds one. */
export const RUN_BUDGET_USD = {
  perSheetWarn: 0.4,
  smallSet: 1.5, // 2-sheet house
  permitSet: 12, // 25-sheet set
} as const;

export function costOf(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null },
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheTok = usage.cache_read_input_tokens ?? 0;
  return (
    (inTok * p.input + outTok * p.output + cacheTok * p.cacheRead) / 1_000_000
  );
}
