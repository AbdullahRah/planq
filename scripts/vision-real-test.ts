#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

(async () => {
  const sharp = (await import('sharp')).default;
  const buf = await sharp({
    create: { width: 600, height: 400, channels: 3, background: '#ffffff' },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
            <rect x="50" y="50" width="500" height="300" fill="none" stroke="black" stroke-width="3"/>
            <text x="300" y="200" font-family="Arial" font-size="20" text-anchor="middle">ROOM A</text>
            <text x="300" y="230" font-family="Arial" font-size="14" text-anchor="middle">5000mm x 3000mm</text>
          </svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  console.log(`image size: ${buf.length} bytes`);

  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: { 'HTTP-Referer': 'https://staqtech.com', 'X-Title': 'Planq vision test' },
  });

  const r = await client.chat.completions.create({
    model: process.env.VISION_MODEL!,
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'What text and shapes are in this image? Respond in one sentence.',
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] as unknown as string,
      },
    ],
  });
  const msg = r.choices[0]?.message as {
    content?: string | null;
    reasoning?: string | null;
  };
  console.log('content:  ', msg?.content);
  console.log('reasoning:', msg?.reasoning?.slice(0, 200));
})().catch((e) => {
  console.error('FAIL', e?.status, e?.message ?? e);
  process.exit(1);
});
