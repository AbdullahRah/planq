import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { supabaseAdmin } from '@/lib/supabase';
import { detectInputKind } from '@/lib/review';
import { RUN_BUDGET_USD } from '@/lib/claude';
import { reviewWorkflow } from '@/workflows/review';

export const runtime = 'nodejs';

/**
 * Step two of a review: start it, after the browser has uploaded the drawing
 * to storage (see ./upload).
 *
 * The review runs as a durable workflow (workflows/review.ts) and this returns
 * at once. Run inside this request, a large set either hit the 300 s function
 * limit or had to skip sheets and the independent check, and neither gives a
 * result anyone can defend. The page polls ./[planId] for progress and the
 * result.
 */
export async function POST(req: NextRequest) {
  let body: { planId?: string; storagePath?: string; fileName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'expected JSON' }, { status: 400 });
  }
  const { planId, storagePath, fileName } = body;
  if (!planId || !storagePath || !fileName) {
    return NextResponse.json({ error: 'planId, storagePath and fileName are required' }, { status: 400 });
  }
  // The path must be the one ./upload issued for this plan.
  if (!storagePath.startsWith(`${planId}/`)) {
    return NextResponse.json({ error: 'storagePath does not belong to this plan' }, { status: 400 });
  }
  const kind = detectInputKind(fileName);
  if (!kind) return NextResponse.json({ error: 'unsupported file type' }, { status: 400 });

  const { data: plan } = await supabaseAdmin.from('plans').select('id, status').eq('id', planId).single();
  if (!plan) return NextResponse.json({ error: 'no such plan' }, { status: 404 });
  if (plan.status !== 'uploading') {
    return NextResponse.json({ error: `this plan is already ${plan.status}` }, { status: 409 });
  }

  // Confirm the upload landed before spending anything on it.
  const folder = storagePath.slice(0, storagePath.lastIndexOf('/'));
  const objectName = storagePath.slice(storagePath.lastIndexOf('/') + 1);
  const { data: listed } = await supabaseAdmin.storage.from('plans').list(folder, { search: objectName });
  if (!listed?.some((o) => o.name === objectName)) {
    return NextResponse.json({ error: 'the drawing was not uploaded' }, { status: 400 });
  }

  const run = await start(reviewWorkflow, [
    { planId, storagePath, kind, name: fileName, budgetUsd: RUN_BUDGET_USD.permitSet },
  ]);

  await supabaseAdmin
    .from('plans')
    .update({
      status: 'processing',
      workflow_run_id: run.runId,
      progress: { stage: 'S0', detail: 'queued' },
      updated_at: new Date().toISOString(),
    })
    .eq('id', planId);

  return NextResponse.json({ planId, runId: run.runId }, { status: 202 });
}
