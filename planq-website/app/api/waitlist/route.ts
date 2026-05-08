import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let body: { email?: unknown; role?: unknown; company?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body.role === "string" ? body.role.trim() : null;
  const company = typeof body.company === "string" ? body.company.trim() : null;

  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: "valid email required" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("waitlist")
    .insert({ email, role: role || null, company: company || null, source: "website" });

  if (error) {
    // unique_violation 23505 — already on the list, treat as success
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ ok: true, alreadyOnList: true });
    }
    // eslint-disable-next-line no-console
    console.error("[waitlist] insert failed", error);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, alreadyOnList: false });
}
