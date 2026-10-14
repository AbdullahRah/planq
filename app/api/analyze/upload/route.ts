import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { detectInputKind } from '@/lib/review';

export const runtime = 'nodejs';

/**
 * Step one of a review: create the plan and a signed URL the browser uploads
 * the drawing to directly.
 *
 * The file does not pass through this function. Vercel caps a request body at
 * 4.5 MB, and a real permit set, especially one with scanned sheets, is often
 * tens of megabytes.
 */
export async function POST(req: NextRequest) {
  let body: { fileName?: string; projectName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'expected JSON' }, { status: 400 });
  }
  const fileName = (body.fileName ?? '').trim();
  if (!fileName) return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
  if (!detectInputKind(fileName)) {
    return NextResponse.json(
      {
        error: 'unsupported file type',
        detail: `${fileName} is not a PDF or a raster image. DWG and IFC are not supported yet.`,
      },
      { status: 400 },
    );
  }

  const { data: plan, error: planErr } = await supabaseAdmin
    .from('plans')
    .insert({ project_name: body.projectName || 'Untitled Project', status: 'uploading' })
    .select('id')
    .single();
  if (planErr || !plan) {
    return NextResponse.json({ error: 'failed to create plan', detail: planErr?.message ?? 'unknown' }, { status: 500 });
  }

  // The path is ours, not the user's: only the extension comes from the name.
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
  const storagePath = `${plan.id}/${Date.now()}-${safeName}`;
  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from('plans')
    .createSignedUploadUrl(storagePath);
  if (signErr || !signed) {
    return NextResponse.json({ error: 'failed to prepare upload', detail: signErr?.message ?? 'unknown' }, { status: 500 });
  }

  return NextResponse.json({ planId: plan.id, storagePath, token: signed.token });
}
