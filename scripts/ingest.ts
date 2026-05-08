#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv();

async function main() {
  const [, , filePathArg, jurisdictionArg] = process.argv;
  if (!filePathArg) {
    console.error('Usage: npx ts-node scripts/ingest.ts <pdf-path> [jurisdiction]');
    process.exit(1);
  }

  // Lazy-load so env vars are available when modules initialize.
  const { ingestCodePdf } = await import('../lib/ingest-core');

  const localPath = path.resolve(process.cwd(), filePathArg);
  const jurisdiction = jurisdictionArg ?? 'NBC';

  console.log(`Ingesting ${localPath} (${jurisdiction})...`);
  const result = await ingestCodePdf({
    localPath,
    jurisdiction,
    onProgress: (line) => console.log(line),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
