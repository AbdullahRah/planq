#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

(async () => {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  try {
    const res = await client.embeddings.create({
      model: process.env.EMBEDDING_MODEL!,
      input: 'egress width corridor',
    });
    console.log('OK dims=', res.data[0]?.embedding?.length);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log('FAIL status=', err?.status ?? '', 'msg=', err?.message ?? String(e));
  }
})();
