#!/usr/bin/env ts-node
import path from 'path';
import fs from 'fs';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const { parsePdf } = await import('../lib/parsers/pdf');
  const { openrouter, MODELS, readChoiceText, safeJsonParse } = await import(
    '../lib/openrouter'
  );

  const pdfPath = process.argv[2] ?? '/tmp/planq-test.pdf';
  const buffer = fs.readFileSync(pdfPath);
  console.log(`pdf bytes: ${buffer.length}`);
  const parsed = await parsePdf(buffer);
  console.log(
    `pages rendered: ${parsed.pageImages.length} (text length ${parsed.text.length})`,
  );
  if (parsed.pageImages.length === 0) {
    console.log('NO PAGE IMAGES — pdf2pic produced nothing. Check ImageMagick/Ghostscript.');
    return;
  }

  const SYSTEM = `You are a building plan analyzer. Extract all spatial and dimensional information from this architectural drawing. Return ONLY valid JSON. No prose. Schema: {"rooms":[{"name":"string","dimensions":"string?"}],"doors":[{"location":"string","width":"string?"}],"corridors":[{"location":"string","width":"string?"}],"stairs":[{"location":"string","width":"string?"}],"egress_paths":[{"from":"string","to":"string"}],"dimensions":[{"element":"string","value":"string","unit":"string"}],"annotations":["string"],"occupancy_type":"string?","building_type":"string?"}`;

  console.log(`model: ${MODELS.vision}`);
  const completion = await openrouter.chat.completions.create({
    model: MODELS.vision,
    temperature: 0.1,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `text hint: ${parsed.text.slice(0, 1000)}`,
          },
          { type: 'image_url', image_url: { url: parsed.pageImages[0] } },
        ] as unknown as string,
      },
    ],
    ...({ reasoning: { exclude: true } } as Record<string, unknown>),
  });

  const choice = completion.choices?.[0];
  const msg = choice?.message as never;
  const raw = readChoiceText(msg);
  console.log('finish_reason:', choice?.finish_reason);
  console.log('content length:', (msg as { content?: string })?.content?.length ?? 0);
  console.log('reasoning length:', (msg as { reasoning?: string })?.reasoning?.length ?? 0);
  console.log('raw (first 600):', raw.slice(0, 600));
  const parsedJson = safeJsonParse<Record<string, unknown>>(raw, {});
  console.log('parsed keys:', Object.keys(parsedJson));
  console.log(
    'rooms:',
    Array.isArray((parsedJson as { rooms?: unknown[] }).rooms)
      ? (parsedJson as { rooms: unknown[] }).rooms.length
      : 'n/a',
  );
  console.log('usage:', JSON.stringify(completion.usage ?? {}));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
