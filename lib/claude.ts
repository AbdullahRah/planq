// The one place model ids and the model transport live (PLANQ_SPEC.md §2.3).
//
// Every model call goes through OpenRouter's OpenAI-compatible chat completions
// endpoint, so a stage can be pointed at any vision-capable model with
// structured output support by changing one environment variable. The key is
// OPENROUTER_API_KEY. It is never logged or stored.

/** Stage names. One model id per job so a stage can be re-pointed on its own. */
export type StageName = 'applicability' | 'extraction' | 'judgment' | 'report' | 'verifier';

/**
 * Default OpenRouter model per stage, chosen for cost during the MVP.
 *
 * - applicability: cheap classification and light reading.
 * - extraction: vision over drawing tiles. The highest-volume stage, so the
 *   cheapest model that reads small dimension text reliably. Benchmark against
 *   google/gemini-3.8-flash and anthropic/claude-haiku-5.5 on a real set.
 * - verifier: deliberately a different, stronger model than extraction, so the
 *   check is independent of the model that read the drawing.
 */
const DEFAULT_MODELS: Record<StageName, string> = {
  applicability: 'anthropic/claude-haiku-5.5',
  extraction: 'qwen/qwen3.8-omni-flash',
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
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.2 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.4 },
  'google/gemini-3.8-flash': { input: 0.375, output: 1.875, cacheRead: 0.09 },
  'qwen/qwen3.8-omni-flash': { input: 0.15, output: 0.47, cacheRead: 0.04 },
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
 * One chat completion. Retries rate limits and 5xx responses with backoff,
 * because a long run should not die on a single transient failure.
 */
export async function openrouterChat(body: Record<string, unknown>): Promise<ChatResult> {
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
      const status = res.status;
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
