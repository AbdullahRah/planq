// The one path every model call takes (PLANQ_SPEC.md §4, §G10, §G11).
//
// §4: each stage reads and writes typed JSON validated with a schema; a failed
// validation retries once with the validation error appended, then the run
// stops as needs_manual_review.
// §G10: store model ids, prompt versions and token usage for every call.
// §G11: a per-run token budget, one retry per stage, then stop.
//
// Nothing here logs or stores the API key. The audit record carries model ids,
// token counts, prompt versions and cost, which is what §G10 asks for.

import type { z } from 'zod';
import { chat, costOf, MODELS, type StageName } from '../claude';
import { validateStage, type StageUsage } from '../schemas';

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`run budget exceeded: $${spent.toFixed(4)} spent against a $${budget.toFixed(2)} ceiling`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * At most this many model calls in flight across the whole process. A 26-sheet
 * set fired 52 vision calls at once, went past the organization's 500 000 input
 * tokens per minute, and nine sheets came back as 429s. A vision call is about
 * 17 000 input tokens and takes one to two minutes, so 16 at once is about
 * 270 000 tokens a minute: inside the limit, with headroom for a second review
 * running at the same time.
 */
const MAX_CONCURRENT_CALLS = Number(process.env.PLANQ_MAX_CONCURRENT_CALLS) || 16;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_CALLS) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight over
  else inFlight -= 1;
}

export class StageFailedError extends Error {
  constructor(stage: string, detail: string) {
    super(`[${stage}] needs_manual_review: ${detail}`);
    this.name = 'StageFailedError';
  }
}

/** Accumulates usage across a run so §G11 can stop it and §G10 can record it. */
export class RunLedger {
  readonly usage: StageUsage[] = [];

  constructor(private readonly budgetUsd: number) {}

  get spentUsd(): number {
    return this.usage.reduce((a, u) => a + u.cost_usd, 0);
  }

  record(entry: StageUsage): void {
    this.usage.push(entry);
    if (this.spentUsd > this.budgetUsd) {
      throw new BudgetExceededError(this.spentUsd, this.budgetUsd);
    }
  }

  /** Checked before a call, so a known-expensive stage cannot start over budget. */
  assertHeadroom(): void {
    if (this.spentUsd > this.budgetUsd) {
      throw new BudgetExceededError(this.spentUsd, this.budgetUsd);
    }
  }
}

export type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/png'; data: string };
    };

export interface StageCall<T extends z.ZodTypeAny> {
  stage: StageName;
  /** Overrides the stage's default model, for a call that needs another tier. */
  model?: string;
  /** Bumped whenever the prompt text changes, so §G10 can tell runs apart. */
  promptVersion: string;
  system: string;
  content: ContentBlock[];
  schema: T;
  /**
   * JSON Schema the model is constrained to. Keep it in step with `schema`.
   *
   * Structured outputs reject `minimum`, `maximum`, `minItems` and `maxItems`
   * with a 400, so range and length limits live only in the zod schema, which
   * revalidates the parsed result anyway.
   */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Ask the model to reason before answering. Sent as OpenRouter's unified
   * `reasoning` setting; strength comes from PLANQ_REASONING_EFFORT.
   */
  thinking?: boolean;
  ledger: RunLedger;
}

/** Our content blocks, in the OpenAI-style parts OpenRouter takes. */
function toOpenRouterPart(block: ContentBlock): Record<string, unknown> {
  if (block.type === 'text') return block;
  return {
    type: 'image_url',
    image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
  };
}

/**
 * Some models wrap JSON in a code fence or add a sentence around it even when a
 * schema is set. Take the outermost object so a harmless wrapper does not cost a
 * retry. Anything that still fails to parse goes through the §4 retry path.
 */
function extractJson(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('{') && s.endsWith('}')) return s;
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  return first >= 0 && last > first ? s.slice(first, last + 1) : s;
}

/**
 * Run one stage. Validates the result, retries once with the validation error
 * appended per §4, and throws StageFailedError after that so the caller can
 * mark the run needs_manual_review.
 */
export async function runStage<T extends z.ZodTypeAny>(
  call: StageCall<T>,
): Promise<z.infer<T>> {
  const model = call.model ?? MODELS[call.stage];
  call.ledger.assertHeadroom();

  let content = call.content;
  let lastError = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: call.maxTokens ?? 8000,
      messages: [
        {
          role: 'system',
          // The system prompt and the rule text are identical across every sheet
          // and every run, so caching them is where §10's cost targets come
          // from. OpenRouter forwards cache_control to providers that support it
          // and ignores it for the rest.
          content: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        },
        { role: 'user', content: content.map(toOpenRouterPart) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'stage_output', strict: true, schema: call.jsonSchema },
      },
      // Ask for the dollar cost of the call, which the audit trail records.
      usage: { include: true },
      provider: {
        // Only route to endpoints that honour every parameter sent, above all
        // the JSON schema. Without this a provider can silently ignore it.
        require_parameters: true,
        // Client drawings must not be used for training (README, "No model is
        // trained"). Set PLANQ_DATA_COLLECTION=allow to widen the provider
        // pool if a model has no endpoint that satisfies this.
        data_collection: process.env.PLANQ_DATA_COLLECTION?.trim() === 'allow' ? 'allow' : 'deny',
      },
    };

    if (call.thinking) {
      const effort = (process.env.PLANQ_REASONING_EFFORT?.trim() || 'medium').toLowerCase();
      // 'off' omits the parameter, for a model that has no reasoning mode.
      if (effort !== 'off') body.reasoning = { effort };
    }

    await acquireSlot();
    let res: Awaited<ReturnType<typeof chat>>;
    try {
      res = await chat(body, call.stage);
    } finally {
      releaseSlot();
    }

    const usage = res.usage;
    call.ledger.record({
      stage: `${call.stage}${attempt > 1 ? ' (retry)' : ''}`,
      model: res.servedModel ?? model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      // OpenRouter's reported cost is the number of record; the price table is
      // only a fallback for a response that carries none.
      cost_usd: usage.cost_usd ?? costOf(model, usage),
      prompt_version: call.promptVersion,
    });

    const raw = res.content;
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      lastError =
        res.finishReason === 'length'
          ? 'the reply was cut off at the token limit before the JSON finished'
          : `response was not valid JSON: ${raw.slice(0, 200)}`;
      content = [
        ...call.content,
        { type: 'text', text: `Your previous reply could not be parsed. ${lastError}. Return only JSON matching the schema.` },
      ];
      continue;
    }

    const check = validateStage(call.stage, call.schema, parsed);
    if (check.ok) return check.data;

    lastError = check.error.issues;
    content = [
      ...call.content,
      {
        type: 'text',
        text: `Your previous reply failed validation: ${lastError}. Correct it and return only JSON matching the schema.`,
      },
    ];
  }

  throw new StageFailedError(call.stage, lastError);
}
