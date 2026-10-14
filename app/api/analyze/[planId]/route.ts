import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A review's state, polled by the page while the workflow runs: progress until
 * it finishes, then the result exactly as the page renders it.
 */
export async function GET(_req: NextRequest, { params }: { params: { planId: string } }) {
  if (!/^[0-9a-f-]{36}$/i.test(params.planId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const { data: plan, error } = await supabaseAdmin
    .from('plans')
    .select('id, status, progress, result, error, updated_at')
    .eq('id', params.planId)
    .single();
  if (error || !plan) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const finished = plan.status === 'complete' || plan.status === 'needs_manual_review';
  return NextResponse.json(
    {
      plan_id: plan.id,
      status: plan.status,
      progress: plan.progress,
      error: plan.error,
      updated_at: plan.updated_at,
      ...(finished && plan.result ? { result: { plan_id: plan.id, ...plan.result } } : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
