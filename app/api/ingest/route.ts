import { NextRequest, NextResponse } from 'next/server';
import { ingestCodePdf } from '@/lib/ingest-core';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: { file_path?: string; jurisdiction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const filePath = body.file_path;
  const jurisdiction = body.jurisdiction ?? 'NBC';
  if (!filePath || typeof filePath !== 'string') {
    return NextResponse.json({ error: 'file_path required' }, { status: 400 });
  }

  const isLocal = filePath.startsWith('/') || filePath.startsWith('./') || filePath.startsWith('../');

  try {
    const result = await ingestCodePdf({
      localPath: isLocal ? filePath : undefined,
      storagePath: isLocal ? undefined : filePath,
      jurisdiction,
      onProgress: (line) => {
        // eslint-disable-next-line no-console
        console.log(`[ingest] ${line}`);
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ingest] failed', err);
    return NextResponse.json(
      { error: 'ingest failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
}
