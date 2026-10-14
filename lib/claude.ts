// The one place model ids and the model transport live (PLANQ_SPEC.md §2.3).
//
// Every model call goes through OpenRouter's OpenAI-compatible chat completions
// endpoint, so a stage can be pointed at any vision-capable model with
// structured output support by changing one environment variable. The key is
// OPENROUTER_API_KEY. It is never logged or stored.
//
// Running out of credit must not take reviews down. Two layers:
//   - each stage has fallback models, which OpenRouter tries in order when the
//     first model's providers are down or refuse the request
//   - when OpenRouter itself is out of credit (or a key or workspace cap is
//     reached), the call goes straight to the Claude API with ANTHROPIC_API_KEY
// Only when both are exhausted does a call fail, with CreditExhaustedError, so
// the caller can pause the review instead of reporting sheets as unreadable.

import Anthropic from '@anthropic-ai/sdk';

/** Stage names. One model id per job so a stage can be re-pointed on its own. */
export type StageName = 'applicability' | 'extraction' | 'judgment' | 'report' | 'verifier';

/**
 * Default OpenRouter model per stage, chosen for cost during the MVP.
 *
 * - applicability: cheap classification and light reading.
 * - extraction: vision over drawing tiles. The highest-volume stage, so the
 *   cheapest model that reads small dimension text reliably. On sheet 01 of the
 *   two-storey sample (npm run bench:vision, 2026-10-14) openai/gpt-6-luna read
 *   every door tag and stair count correctly and identically on both passes for
 *   about a cent; qwen/qwen3.8-omni-flash read nothing and claude-haiku-5.5
 *   misread a door tag.
 * - verifier: deliberately a different, stronger model than extraction, so the
 *   check is independent of the model that read the drawing.
 */
const DEFAULT_MODELS: Record<StageName, string> = {
  applicability: 'anthropic/claude-haiku-5.5',
  extraction: 'openai/gpt-6-luna',
  judgment: 'anthropic/claude-sonnet-5.5',
  report: 'anthropic/claude-sonnet-5.5',
  verifier: 'anthropic/claude-sonnet-5.5',
};

const MODEL_ENV: Record<StageName, string> = {
  applicability: 'PLANQ_MODEL_APPLICABILITY',
  extraction: 'PLANQ_MODEL_EXTRACTION',
  judgment: 'PLANQ_MODEL_JUDGMENT',
  report: 'PLANQ_MODEL_REPORT',
  verifier: 'PLANQ_MODEL_VERIFIER',
};

function modelFor(stage: StageName): string {
  // Read at call time rather than import time, because ES imports are hoisted
  // and run before a caller's dotenv load.
  return process.env[MODEL_ENV[stage]]?.trim() || DEFAULT_MODELS[stage];
}

/** Resolved per access, so an env override or a late dotenv load is honoured. */
export const MODELS: Readonly<Record<StageName, string>> = {
  get applicability() {
    return modelFor('applicability');
  },
  get extraction() {
    return modelFor('extraction');
  },
  get judgment() {
    return modelFor('judgment');
  },
  get report() {
    return modelFor('report');
  },
  get verifier() {
    return modelFor('verifier');
  },
};

/**
 * List prices per million tokens, used only as a fallback when OpenRouter does
 * not report a cost for a call. The reported cost is the number of record.
 */
export const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'anthropic/claude-haiku-5.5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.1 },
  'openai/gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'openai/gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2 },
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
  const cacheTok = usage.cache_read_input_tokens ?? 0;
  // input_tokens already includes cached tokens on OpenRouter, so the cached
  // part is billed at the cache rate and the rest at the full input rate.
  const freshIn = Math.max((usage.input_tokens ?? 0) - cacheTok, 0);
  return (
    (freshIn * p.input + (usage.output_tokens ?? 0) * p.output + cacheTok * p.cacheRead) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  /** Dollars as reported by OpenRouter, or null when it did not report one. */
  cost_usd: number | null;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  usage: ChatUsage;
  /** The model that actually served the call, which can differ from the request. */
  servedModel: string | null;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/**
 * Every provider that could serve the call is out of credit or over a spending
 * cap. Not worth retrying in seconds; worth retrying once someone tops up.
 */
export class CreditExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditExhaustedError';
  }
}

/**
 * OpenRouter answers 402 when the account is out of credit and 403 when a key
 * or workspace cap is reached; the Claude API answers 400 "usage limits" when a
 * workspace spend limit is reached. All mean the same thing to a review.
 */
function isCreditError(status: number | undefined, detail: string): boolean {
  if (status === 402) return true;
  return (status === 400 || status === 403) && /credit|usage limit|spend limit|key limit|budget/i.test(detail);
}

const REQUEST_TIMEOUT_MS = 280_000;
const MAX_RETRIES = 2;

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new OpenRouterError(
      'OPENROUTER_API_KEY is not set. Add it to .env.local (and to the Vercel project environment).',
    );
  }
  return key;
}

function baseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One OpenRouter chat completion. Retries rate limits and 5xx responses with
 * backoff, because a long run should not die on a single transient failure.
 */
async function openrouterChat(body: Record<string, unknown>): Promise<ChatResult> {
  const key = apiKey();
  let lastErr: OpenRouterError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1));

    let res: Response;
    try {
      res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER?.trim() || 'https://useplanq.com',
          'X-Title': 'Planq',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = new OpenRouterError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const text = await res.text();
    let json: Record<string, any> | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }

    if (!res.ok || json?.error) {
      const detail = json?.error?.message ?? text.slice(0, 300);
      // An error inside a 200 response carries its real status as error.code.
      const status = res.ok && typeof json?.error?.code === 'number' ? json.error.code : res.status;
      if (isCreditError(status, detail)) throw new CreditExhaustedError(`OpenRouter ${status}: ${detail}`);
      lastErr = new OpenRouterError(`OpenRouter ${status}: ${detail}`, status);
      if (status === 429 || status >= 500) continue;
      throw lastErr;
    }

    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    const u = json?.usage ?? {};
    return {
      content: typeof content === 'string' ? content : '',
      finishReason: choice?.finish_reason ?? null,
      servedModel: typeof json?.model === 'string' ? json.model : null,
      usage: {
        input_tokens: u.prompt_tokens ?? 0,
        output_tokens: u.completion_tokens ?? 0,
        cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        cost_usd: typeof u.cost === 'number' ? u.cost : null,
      },
    };
  }

  throw lastErr ?? new OpenRouterError('request failed');
}

// ---------------------------------------------------------------------------
// Direct Claude API, used when OpenRouter is out of credit
// ---------------------------------------------------------------------------

let anthropic: Anthropic | null = null;

function anthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  if (!anthropic) {
    // A key that is not scoped to one workspace must name a workspace on every
    // request.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    anthropic = new Anthropic({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    });
  }
  return anthropic;
}

/** "anthropic/claude-sonnet-5.5" to "claude-sonnet-5-5"; null for any other vendor. */
function claudeIdFor(openrouterId: string): string | null {
  const m = /^anthropic\/(claude-[a-z]+-[\d.]+)$/.exec(openrouterId);
  return m ? m[1].replace(/\./g, '-') : null;
}

/** The Claude model a stage falls back to when its own model is not a Claude. */
const DIRECT_DEFAULTS: Record<StageName, string> = {
  applicability: 'claude-haiku-5-5',
  extraction: 'claude-sonnet-5-5',
  judgment: 'claude-sonnet-5-5',
  report: 'claude-sonnet-5-5',
  verifier: 'claude-sonnet-5-5',
};

type OpenAIPart =
  | { type: 'text'; text: string; cache_control?: unknown }
  | { type: 'image_url'; image_url: { url: string } };

/** The OpenRouter request body, restated as a Claude Messages API request. */
function toAnthropicRequest(body: Record<string, any>, model: string): Record<string, unknown> {
  const messages = body.messages as Array<{ role: string; content: OpenAIPart[] }>;
  const system = messages.filter((m) => m.role === 'system').flatMap((m) => m.content);
  const user = messages.filter((m) => m.role !== 'system');

  const outputConfig: Record<string, unknown> = {};
  const schema = body.response_format?.json_schema?.schema;
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  if (body.reasoning?.effort) outputConfig.effort = body.reasoning.effort;

  return {
    model,
    max_tokens: body.max_tokens,
    system,
    messages: user.map((m) => ({
      role: m.role,
      content: m.content.map((part) => {
        if (part.type === 'text') return part;
        const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url) ?? [];
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      }),
    })),
    ...(body.reasoning ? { thinking: { type: 'adaptive' } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

async function anthropicChat(client: Anthropic, body: Record<string, any>, model: string): Promise<ChatResult> {
  let res: Record<string, any>;
  try {
    // The installed SDK's types predate output_config, so the body goes through
    // untyped; the API validates it.
    res = await (client as unknown as {
      messages: { create(b: unknown): Promise<Record<string, any>> };
    }).messages.create(toAnthropicRequest(body, model));
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    const detail = err instanceof Error ? err.message : String(err);
    if (isCreditError(status, detail)) throw new CreditExhaustedError(`Claude API ${status}: ${detail}`);
    throw err;
  }

  const text = (res.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const u = res.usage ?? {};
  // Price it at the matching OpenRouter id, which is what PRICING is keyed by.
  const priceKey = `anthropic/${model.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  const usage = {
    input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
  return {
    content: text,
    finishReason: res.stop_reason === 'max_tokens' ? 'length' : res.stop_reason ?? null,
    servedModel: `${model} (direct)`,
    usage: { ...usage, cost_usd: costOf(priceKey, usage) },
  };
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Fallback models per stage, tried by OpenRouter in order when the first one's
 * providers are down or reject the request. PLANQ_FALLBACK_<STAGE> overrides
 * the list with comma-separated ids, or "none".
 */
const DEFAULT_FALLBACKS: Record<StageName, string[]> = {
  applicability: ['openai/gpt-6-luna'],
  extraction: ['anthropic/claude-sonnet-5.5'],
  judgment: ['openai/gpt-6-sol'],
  report: ['openai/gpt-6-sol'],
  verifier: ['openai/gpt-6-sol'],
};

function fallbacksFor(stage: StageName, primary: string): string[] {
  const raw = process.env[`PLANQ_FALLBACK_${stage.toUpperCase()}`]?.trim();
  const list = raw === 'none' ? [] : raw ? raw.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_FALLBACKS[stage];
  return list.filter((m) => m !== primary);
}

/**
 * Run one model call for a stage. OpenRouter first, with the stage's fallback
 * models; if OpenRouter is out of credit, the Claude API directly. Throws
 * CreditExhaustedError only when neither can serve it.
 */
export async function chat(body: Record<string, any>, stage: StageName): Promise<ChatResult> {
  const primary = body.model as string;
  const fallbacks = fallbacksFor(stage, primary);

  let openrouterCredit: CreditExhaustedError | null = null;
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    try {
      // OpenRouter caps the list at three models.
      return await openrouterChat(fallbacks.length > 0 ? { ...body, models: [primary, ...fallbacks].slice(0, 3) } : body);
    } catch (err) {
      if (!(err instanceof CreditExhaustedError)) throw err;
      openrouterCredit = err;
    }
  }

  const client = anthropicClient();
  if (!client) {
    throw openrouterCredit ?? new OpenRouterError('Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set.');
  }
  const model =
    process.env[`PLANQ_DIRECT_MODEL_${stage.toUpperCase()}`]?.trim() || claudeIdFor(primary) || DIRECT_DEFAULTS[stage];
  if (openrouterCredit) console.warn(`[planq] ${openrouterCredit.message}; using the Claude API directly (${model})`);
  try {
    return await anthropicChat(client, body, model);
  } catch (err) {
    if (err instanceof CreditExhaustedError && openrouterCredit) {
      throw new CreditExhaustedError(`Both providers are out of credit. ${openrouterCredit.message}. ${err.message}`);
    }
    throw err;
  }
}
