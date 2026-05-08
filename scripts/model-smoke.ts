#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==';

async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`${name}: `);
  try {
    const out = await fn();
    console.log(`OK — ${out}`);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(`FAIL [${err?.status ?? '?'}] ${err?.message ?? String(e)}`);
  }
}

(async () => {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': 'https://staqtech.com',
      'X-Title': 'Planq smoke test',
    },
  });

  const visionModel = process.argv[2] ?? process.env.VISION_MODEL!;
  const reasoningModel = process.argv[3] ?? process.env.REASONING_MODEL!;
  const embeddingModel = process.argv[4] ?? process.env.EMBEDDING_MODEL!;

  console.log(`vision    = ${visionModel}`);
  console.log(`reasoning = ${reasoningModel}`);
  console.log(`embedding = ${embeddingModel}\n`);

  await check('vision', async () => {
    const r = await client.chat.completions.create({
      model: visionModel,
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with the word OK.' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
            },
          ] as unknown as string,
        },
      ],
    });
    return (r.choices[0]?.message?.content ?? '').trim().slice(0, 60);
  });

  await check('reasoning', async () => {
    const r = await client.chat.completions.create({
      model: reasoningModel,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
    });
    return (r.choices[0]?.message?.content ?? '').trim().slice(0, 60);
  });

  await check('embedding', async () => {
    const r = await client.embeddings.create({ model: embeddingModel, input: 'hello' });
    return `dims=${r.data[0]?.embedding?.length}`;
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
