"use client";

import { useState } from "react";
import Link from "next/link";

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; alreadyOnList: boolean }
  | { kind: "error"; message: string };

export function WaitlistSection() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const appUrl = process.env.NEXT_PUBLIC_PLANQ_APP_URL ?? "http://localhost:3000";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.kind === "submitting") return;
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role, company }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ kind: "error", message: json?.error ?? "something went wrong" });
        return;
      }
      setState({ kind: "success", alreadyOnList: !!json?.alreadyOnList });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  };

  return (
    <section
      id="waitlist"
      className="relative overflow-hidden bg-foreground text-background"
    >
      <div className="px-6 py-24 md:px-12 md:py-32 lg:px-20 lg:py-40">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs uppercase tracking-widest text-background/60">
            Beta access
          </p>
          <h2 className="mt-6 text-4xl font-medium tracking-tight md:text-5xl lg:text-6xl">
            Run a sheet through planq.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-background/70 md:text-lg">
            Drop your email. We'll send beta credentials, no spam, no calendar invite. The first
            sheet is on us.
          </p>

          {state.kind !== "success" ? (
            <form
              onSubmit={onSubmit}
              className="mx-auto mt-10 flex max-w-2xl flex-col gap-3 md:gap-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:gap-3">
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@firm.com"
                  className="flex-1 rounded-full border border-background/20 bg-background/5 px-5 py-3 text-base text-background placeholder:text-background/40 focus:border-background focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={state.kind === "submitting"}
                  className="rounded-full bg-background px-6 py-3 text-sm font-medium text-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {state.kind === "submitting" ? "Sending…" : "Get on the list"}
                </button>
              </div>

              <div className="flex flex-col gap-3 md:flex-row md:gap-3">
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="Role (optional) — e.g. Architect, GC, Reviewer"
                  className="flex-1 rounded-full border border-background/20 bg-background/5 px-5 py-3 text-sm text-background placeholder:text-background/40 focus:border-background focus:outline-none"
                />
                <input
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Firm (optional)"
                  className="flex-1 rounded-full border border-background/20 bg-background/5 px-5 py-3 text-sm text-background placeholder:text-background/40 focus:border-background focus:outline-none"
                />
              </div>

              {state.kind === "error" && (
                <p className="text-sm text-red-300">{state.message}</p>
              )}
            </form>
          ) : (
            <div className="mx-auto mt-10 flex max-w-xl flex-col items-center gap-6 rounded-2xl border border-background/15 bg-background/5 p-8">
              <div className="text-center">
                <p className="font-mono text-xs uppercase tracking-widest text-background/60">
                  {state.alreadyOnList ? "already on the list" : "you're in"}
                </p>
                <p className="mt-3 text-xl font-medium md:text-2xl">
                  {state.alreadyOnList
                    ? "Welcome back. The beta app is ready when you are."
                    : "Saved. Want to try the beta app right now?"}
                </p>
              </div>
              <Link
                href={appUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-background px-8 py-3 text-sm font-medium text-foreground transition-opacity hover:opacity-90"
              >
                Open the beta app →
              </Link>
              <p className="text-xs text-background/50">
                Upload a plan, get a violation list. The full pipeline runs on your sheet.
              </p>
            </div>
          )}

          <p className="mt-8 text-xs uppercase tracking-widest text-background/40">
            Built on the 2020 NBC Alberta Edition · 1,953 indexed sections
          </p>
        </div>
      </div>
    </section>
  );
}
