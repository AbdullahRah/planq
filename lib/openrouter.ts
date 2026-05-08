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
  reasoning: process.env.REASONING_MODEL ?? 'google/gemma-4-31b-it:free',
  embedding: process.env.EMBEDDING_MODEL ?? 'openrouter/free',
};

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
  return fallback;
}
