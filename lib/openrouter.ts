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
  reasoning: process.env.REASONING_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free',
  embedding: process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small',
};

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
  return fallback;
}
