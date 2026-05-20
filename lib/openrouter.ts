import OpenAI from 'openai';

if (!process.env.OPENROUTER_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('[openrouter] OPENROUTER_API_KEY not set');
}

export const openrouter = new OpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  defaultHeaders: {
    'HTTP-Referer': 'https://staqtech.com',
    'X-Title': 'Planq by staqtech',
  },
});

export const MODELS = {
  vision: process.env.VISION_MODEL ?? 'nvidia/nemotron-nano-12b-v2-vl:free',
  reasoning: process.env.REASONING_MODEL ?? 'openai/gpt-oss-120b:free',
  embedding: process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small',
};

// Ordered candidates tried when the primary reasoning model is rate-limited
// or returns empty. Free tiers thrash, so keep a short diversified chain of
// models that are verified-available via the OpenRouter free tier.
export const REASONING_CHAIN: string[] = (
  process.env.REASONING_MODEL_CHAIN
    ? process.env.REASONING_MODEL_CHAIN.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        MODELS.reasoning,
        'openai/gpt-oss-120b:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemma-4-31b-it:free',
        'z-ai/glm-4.5-air:free',
        'qwen/qwen3-next-80b-a3b-instruct:free',
      ]
);

export const VISION_CHAIN: string[] = (
  process.env.VISION_MODEL_CHAIN
    ? process.env.VISION_MODEL_CHAIN.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        MODELS.vision,
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      ]
);

export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number; code?: number }).status
    ?? (err as { code?: number }).code;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function callWithModelChain<T>(
  chain: string[],
  fn: (model: string) => Promise<T>,
  validate: (out: T) => boolean,
  onAttempt?: (info: { model: string; error?: unknown; reason?: string }) => void,
): Promise<T | undefined> {
  let lastResult: T | undefined;
  for (const model of chain) {
    try {
      const out = await fn(model);
      if (validate(out)) {
        onAttempt?.({ model, reason: 'ok' });
        return out;
      }
      lastResult = out;
      onAttempt?.({ model, reason: 'empty/invalid' });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const msg = (err as { message?: string }).message ?? String(err);
      onAttempt?.({
        model,
        error: err,
        reason: `${isTransientError(err) ? 'transient' : 'fatal'} (${status ?? '?'}) ${msg.slice(0, 140)}`,
      });
    }
  }
  return lastResult;
}

type ChoiceMessage = {
  content?: string | null;
  reasoning?: string | null;
};

// Reasoning models on OpenRouter sometimes leave `content` empty and put the
// answer in a separate `reasoning` field. Read both, prefer content.
export function readChoiceText(message: ChoiceMessage | undefined | null): string {
  if (!message) return '';
  if (typeof message.content === 'string' && message.content.trim()) return message.content;
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) return message.reasoning;
  return '';
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const tryParse = (s: string): T | undefined => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(candidate);
  if (direct !== undefined) return direct;
  const firstBrace = candidate.search(/[\[{]/);
  if (firstBrace >= 0) {
    const lastBrace = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    if (lastBrace > firstBrace) {
      const sliced = candidate.slice(firstBrace, lastBrace + 1);
      const parsed = tryParse(sliced);
      if (parsed !== undefined) return parsed;
    }
  }

  // Truncated array recovery: if the model emitted "[ {..}, {..}, {..(cut off)" —
  // close any complete-looking objects, drop the trailing partial, and reparse.
  if (candidate.startsWith('[')) {
    const objects: string[] = [];
    let depth = 0;
    let inStr = false;
    let escape = false;
    let start = -1;
    for (let i = 1; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(candidate.slice(start, i + 1));
          start = -1;
        }
      }
    }
    if (objects.length > 0) {
      const repaired = `[${objects.join(',')}]`;
      const parsed = tryParse(repaired);
      if (parsed !== undefined) return parsed;
    }
  }

  return fallback;
}
