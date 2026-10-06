'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import type { Fact, Finding, FindingStatus } from '@/lib/schemas';
import type { ReviewResult, SheetSummary } from '@/lib/review';

type Theme = 'dark' | 'light';

/** The §8 statuses, plus "all". Severity is gone: a finding has a status. */
type StatusFilter = 'all' | FindingStatus;

interface PendingFile {
  file: File;
  /** 'pdf' or 'image'. DWG and IFC are not supported yet. */
  kind: 'pdf' | 'image';
}

type ApiResult = ReviewResult & { plan_id: string };

interface PipelineStep {
  label: string;
  status: 'pending' | 'active' | 'done';
}

// DXF and DWG are no longer accepted. The old DXF path produced data in the
// retired ExtractedSheet shape that the rule engine cannot read, and offering
// an upload that silently yields nothing is worse than refusing it. Both are
// tracked in ROADMAP.md.
const ACCEPTED_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'];
const ACCEPT_ATTR = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp';

function detectKind(filename: string): 'pdf' | 'image' {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'pdf' ? 'pdf' : 'image';
}

const STATUS_ORDER: FindingStatus[] = [
  'fail',
  'drawing_conflict',
  'needs_confirmation',
  'cant_determine',
  'pass',
];

const STATUS_LABEL: Record<FindingStatus, string> = {
  fail: 'Fail',
  drawing_conflict: 'Drawing conflict',
  needs_confirmation: 'Needs confirmation',
  cant_determine: "Can't determine",
  pass: 'Pass',
};

/**
 * Colour carries meaning here, so it follows the §8 statuses rather than a
 * severity scale. "Can't determine" is deliberately neutral grey: it is a gap
 * in the drawings, not a problem with the building, and colouring it like a
 * warning taught readers to treat a missing dimension as a defect.
 */
function statusColor(status: FindingStatus): string {
  switch (status) {
    case 'fail':
      return '#EF4444';
    case 'drawing_conflict':
      return '#F59E0B';
    case 'needs_confirmation':
      return '#EAB308';
    case 'cant_determine':
      return '#6B7280';
    case 'pass':
      return '#10B981';
  }
}

const INITIAL_STEPS: PipelineStep[] = [
  { label: 'Reading the sheets', status: 'pending' },
  { label: 'Determining which code Part governs', status: 'pending' },
  { label: 'Reading values off the drawings', status: 'pending' },
  { label: 'Checking the rules', status: 'pending' },
  { label: 'Trying to refute each finding', status: 'pending' },
];

// Rotating one-liners shown while the analysis runs, so the wait has some
// personality. Kept building-code themed and tasteful.
const LOADING_QUIPS = [
  'Measuring your stairs, riser by riser…',
  'Arguing with NBC §9.8.4.2 about tread depth…',
  'Checking if that corridor passed the vibe (and width) check…',
  'Politely asking the AI to squint at your floor plan…',
  'Making sure the guardrail can survive a determined toddler…',
  'Cross-examining your egress paths…',
  'Counting doors. Judging doors. Measuring doors…',
  'Consulting the fire marshal who lives in our head…',
  'Pretending we can read the handwriting on sheet A-1…',
  'Double-checking the math, then triple-checking it…',
  'Confirming nobody has to duck through a doorway…',
  'Reticulating splines… kidding. Finding real violations…',
];

export default function PlanqPage() {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const stored = (typeof window !== 'undefined'
      ? (localStorage.getItem('planq-theme') as Theme | null)
      : null) ?? 'light';
    setTheme(stored === 'dark' ? 'dark' : 'light');
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('planq-theme', next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const [projectName, setProjectName] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [steps, setSteps] = useState<PipelineStep[]>(INITIAL_STEPS);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [quipIdx, setQuipIdx] = useState(0);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  const ingestFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    const accepted: PendingFile[] = [];
    for (const file of list) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPTED_EXTS.includes(ext)) continue;
      accepted.push({ file, kind: detectKind(file.name) });
    }
    if (accepted.length === 0) return;
    setFiles((prev) => [...prev, ...accepted]);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer?.files) ingestFiles(e.dataTransfer.files);
    },
    [ingestFiles],
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const advanceStep = (idx: number, status: PipelineStep['status']) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, status } : s)));
  };

  // The analysis is a single POST, so there's no real per-stage progress to
  // read. Ease the bar toward ~90% while we wait, then runAnalyze snaps it to
  // 100% once the result lands — honest about being indeterminate.
  useEffect(() => {
    if (!analyzing) return;
    setProgress((p) => (p < 8 ? 8 : p));
    const id = setInterval(() => {
      setProgress((p) => (p >= 90 ? p : p + Math.max(0.4, (90 - p) * 0.05)));
    }, 350);
    return () => clearInterval(id);
  }, [analyzing]);

  // Cycle the humorous status line every few seconds while analyzing.
  useEffect(() => {
    if (!analyzing) return;
    const id = setInterval(() => setQuipIdx((i) => (i + 1) % LOADING_QUIPS.length), 2600);
    return () => clearInterval(id);
  }, [analyzing]);

  const runAnalyze = async () => {
    if (analyzing || files.length === 0) return;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'pending' })));
    setProgress(0);
    setQuipIdx(0);

    advanceStep(0, 'active');

    const formData = new FormData();
    formData.append('project_name', projectName || 'Untitled Project');
    for (const { file } of files) formData.append('files', file);

    try {
      advanceStep(0, 'done');
      advanceStep(1, 'active');

      const res = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      advanceStep(1, 'done');
      advanceStep(2, 'done');
      advanceStep(3, 'active');

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error || `Analysis failed (${res.status})`);
      }
      const json = (await res.json()) as ApiResult;
      advanceStep(3, 'done');
      advanceStep(4, 'done');
      setProgress(100);
      setResult(json);
    } catch (err) {
      setError((err as Error).message);
      setProgress(0);
      setSteps((prev) =>
        prev.map((s) => (s.status === 'active' ? { ...s, status: 'pending' } : s)),
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const filteredFindings = useMemo(() => {
    if (!result) return [];
    const list =
      statusFilter === 'all'
        ? result.findings
        : result.findings.filter((f) => f.status === statusFilter);
    // Most severe first, so a reader does not have to scroll past the gaps to
    // reach the failures.
    return [...list].sort(
      (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
    );
  }, [result, statusFilter]);

  const canAnalyze = !analyzing && files.length > 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <Header theme={theme} onToggleTheme={toggleTheme} />

      <section className="px-6 pt-32 pb-16 md:px-12 md:pt-40 md:pb-24 lg:px-20 lg:pt-48 lg:pb-28">
        <div className="mx-auto max-w-3xl">
          <Eyebrow>Beta access · Building code review</Eyebrow>
          <h1 className="mt-4 text-4xl font-medium tracking-tight md:text-5xl lg:text-6xl">
            Catch the issues before the city does.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            Drop architectural plans. planq cross-checks every dimension, door, corridor and
            stair against the building code, then flags compliance and consistency issues
            with citations.
          </p>
        </div>
      </section>

      <section className="px-6 pb-20 md:px-12 md:pb-28 lg:px-20 lg:pb-32">
        <div className="mx-auto max-w-3xl space-y-10">
          <Field label="Project name">
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="240 Pine Street — 4-storey mixed-use"
              className="w-full rounded-full border border-border bg-input px-5 py-3 text-base text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
            />
          </Field>

          <Field label="Plan files">
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`cursor-pointer rounded-2xl border border-dashed px-6 py-16 text-center transition-colors ${
                dragActive
                  ? 'border-foreground bg-secondary/60'
                  : 'border-border bg-secondary/30 hover:bg-secondary/60'
              }`}
            >
              <p className="text-base font-medium md:text-lg">
                Drag plans here, or click to browse.
              </p>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                PDF · PNG · JPG · TIFF · DXF · DWG
              </p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                hidden
                onChange={(e) => {
                  if (e.target.files) ingestFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            {files.length > 0 && (
              <ul className="mt-4 overflow-hidden rounded-2xl border border-border">
                {files.map((pf, i) => (
                  <li
                    key={`${pf.file.name}-${i}`}
                    className="flex items-center justify-between gap-4 border-b border-border bg-card px-5 py-4 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        {pf.kind}
                      </span>
                      <span className="truncate text-sm">{pf.file.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {(pf.file.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    <button
                      onClick={() => removeFile(i)}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-8">
            <div className="flex items-center gap-4">
              <button
                onClick={runAnalyze}
                disabled={!canAnalyze}
                className="rounded-full bg-foreground px-6 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {analyzing ? 'Analyzing…' : 'Analyze plans'}
              </button>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {files.length} file{files.length === 1 ? '' : 's'} queued
              </span>
            </div>
            {error && (
              <span className="font-mono text-xs" style={{ color: '#EF4444' }}>
                {error}
              </span>
            )}
          </div>

          {analyzing && (
            <LoadingProgress progress={progress} quip={LOADING_QUIPS[quipIdx]} />
          )}

          {(analyzing || steps.some((s) => s.status !== 'pending')) && (
            <PipelineTable steps={steps} />
          )}
        </div>
      </section>

      {result && (
        <section className="border-t border-border px-6 py-20 md:px-12 md:py-28 lg:px-20 lg:py-32">
          <div className="mx-auto max-w-5xl space-y-12">
            <div>
              <Eyebrow>
                {result.status === 'needs_manual_review' ? 'Stopped' : 'Review summary'}
              </Eyebrow>
              <h2 className="mt-3 text-3xl font-medium tracking-tight md:text-4xl lg:text-5xl">
                {result.stopped_reason
                  ? 'This set needs a human before it can be reviewed.'
                  : result.counts.fail > 0
                    ? `${result.counts.fail} confirmed ${result.counts.fail === 1 ? 'failure' : 'failures'} across ${result.sheets.length} sheet${result.sheets.length === 1 ? '' : 's'}.`
                    : result.counts.needs_confirmation + result.counts.drawing_conflict > 0
                      ? 'Nothing confirmed as a failure, but items need confirmation.'
                      : 'Nothing could be confirmed as a failure.'}
              </h2>
              {result.stopped_reason && (
                <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  {result.stopped_reason}
                </p>
              )}
            </div>

            {/* §G9: nothing here is a released report. */}
            <div className="rounded-2xl border border-border bg-secondary/30 px-6 py-5">
              <p className="text-sm leading-relaxed text-muted-foreground">
                This is a pre-submission review to help prepare a permit application. It is not a
                permit approval or a substitute for review by the authority having jurisdiction or a
                registered professional. No report is released until a named reviewer approves it.
              </p>
            </div>

            {!result.stopped_reason && (
              <StatStrip
                items={STATUS_ORDER.map((st) => ({
                  label: STATUS_LABEL[st],
                  value: result.counts[st],
                  color: statusColor(st),
                }))}
              />
            )}

            {result.applicability && (
              <ApplicabilityPanel applicability={result.applicability} />
            )}

            {result.warnings.length > 0 && (
              <div className="rounded-2xl border border-border bg-secondary/30 px-6 py-5">
                <Eyebrow>Before you read this</Eyebrow>
                <ul className="mt-3 space-y-2">
                  {result.warnings.map((w, i) => (
                    <li key={i} className="text-xs leading-relaxed" style={{ color: '#F59E0B' }}>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.assumed_conventions.length > 0 && (
              <div className="rounded-2xl border border-border bg-secondary/30 px-6 py-5">
                <Eyebrow>Notation assumed, not read</Eyebrow>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  The drawings did not declare these in a legend, so their meaning was assumed. A
                  finding that depends on one of them should be checked by eye.
                </p>
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  {result.assumed_conventions.join('  ·  ')}
                </p>
              </div>
            )}

            {result.sheets.length > 0 && (
              <SheetsPanel sheets={result.sheets} facts={result.facts} />
            )}

            {!result.stopped_reason && (
              <>
                <div>
                  <Eyebrow>Findings</Eyebrow>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <FilterButton
                      active={statusFilter === 'all'}
                      onClick={() => setStatusFilter('all')}
                    >
                      All {result.findings.length}
                    </FilterButton>
                    {STATUS_ORDER.filter((st) => result.counts[st] > 0).map((st) => (
                      <FilterButton
                        key={st}
                        active={statusFilter === st}
                        onClick={() => setStatusFilter(st)}
                      >
                        {STATUS_LABEL[st]} {result.counts[st]}
                      </FilterButton>
                    ))}
                  </div>
                </div>

                {filteredFindings.length === 0 ? (
                  <div className="rounded-2xl border border-border bg-secondary/30 px-6 py-16 text-center">
                    <Eyebrow>No matches</Eyebrow>
                    <p className="mt-3 text-2xl font-medium tracking-tight md:text-3xl">
                      Nothing matches the current filter.
                    </p>
                    <button
                      onClick={() => setStatusFilter('all')}
                      className="mt-6 rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-foreground hover:text-background"
                    >
                      Clear filter
                    </button>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {filteredFindings.map((f) => (
                      <FindingCard key={f.id} finding={f} />
                    ))}
                  </ul>
                )}
              </>
            )}

            <RunFooter result={result} />
          </div>
        </section>
      )}

      <Footer />
    </main>
  );
}

function Header({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return (
    <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4 md:top-6">
      <div className="shadow-elevated flex w-full max-w-3xl items-center justify-between gap-4 rounded-full border border-border bg-background/80 px-5 py-2.5 backdrop-blur-md">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold tracking-[-0.04em]">planq</span>
          <span className="hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:inline">
            by staqtech
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground md:inline">
            Code review
          </span>
          <button
            onClick={onToggleTheme}
            aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="rounded-full border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <SignedOut>
            <SignInButton mode="modal">
              <button className="rounded-full border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="rounded-full border border-foreground bg-foreground px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-background transition-opacity hover:opacity-80">
                Sign up
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border px-6 py-12 md:px-12 lg:px-20">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          planq · by staqtech
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          planq is a review aid, not a substitute for a registered code consultant. Every
          flagged issue should be verified against the authority having jurisdiction.
        </p>
      </div>
    </footer>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-3 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function LoadingProgress({ progress, quip }: { progress: number; quip: string }) {
  const pct = Math.min(100, Math.round(progress));
  return (
    <div className="space-y-3 rounded-2xl border border-border p-5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-foreground" aria-live="polite">
          {quip}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-secondary/40"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Analysis progress"
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PipelineTable({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <div className="grid grid-cols-[auto_1fr_auto] gap-4 bg-secondary/30 px-5 py-3">
        <Eyebrow>#</Eyebrow>
        <Eyebrow>Stage</Eyebrow>
        <Eyebrow>Status</Eyebrow>
      </div>
      {steps.map((step, i) => (
        <div
          key={step.label}
          className="grid grid-cols-[auto_1fr_auto] items-center gap-4 border-t border-border px-5 py-4"
        >
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {String(i + 1).padStart(2, '0')}
          </span>
          <span className="text-sm">{step.label}</span>
          <span
            className={`font-mono text-[10px] uppercase tracking-widest ${
              step.status === 'done'
                ? 'text-foreground'
                : step.status === 'active'
                  ? 'text-foreground'
                  : 'text-muted-foreground'
            }`}
          >
            {step.status === 'done' ? 'Done' : step.status === 'active' ? 'Running…' : 'Pending'}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatStrip({
  items,
}: {
  items: Array<{ label: string; value: number; color?: string }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <div key={item.label} className="bg-background p-6">
          <Eyebrow>{item.label}</Eyebrow>
          <p
            className="mt-2 text-3xl font-medium tracking-tight md:text-4xl"
            style={item.color ? { color: item.color } : undefined}
          >
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * What stands behind a finding, in one badge: the arithmetic, and then what the
 * independent verifier made of it (§S4). A verifier verdict short of "upheld"
 * says so plainly rather than reading as settled fact.
 */
function ProvenanceBadge({ finding: f }: { finding: Finding }) {
  const base = 'rounded-full border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest';

  if (f.verifier === 'upheld') {
    return (
      <span
        className={`${base} border-emerald-500/40 text-emerald-500`}
        title="A second model was asked to refute this finding and could not"
      >
        upheld
      </span>
    );
  }
  if (f.verifier === 'refuted' || f.verifier === 'uncertain') {
    return (
      <span
        className={`${base} border-amber-500/40 text-amber-500`}
        title={f.verifier_reason ?? 'The independent check could not uphold this finding'}
      >
        {f.verifier === 'refuted' ? 'refuted' : 'unsettled'}
      </span>
    );
  }
  return (
    <span
      className={`${base} border-border text-muted-foreground`}
      title="Measured in code against the rules table. Not sent to the independent verifier, which only reviews failures and items needing confirmation."
    >
      measured
    </span>
  );
}

function FindingCard({ finding: f }: { finding: Finding }) {
  const color = statusColor(f.status);
  return (
    <li
      className="rounded-2xl border border-border bg-secondary/30 px-6 py-5"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className="rounded-full px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest"
          style={{ color, border: `1px solid ${color}55` }}
        >
          {STATUS_LABEL[f.status]}
        </span>
        <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {f.id} · {f.rule_id}
        </span>
        <ProvenanceBadge finding={f} />
      </div>

      <p className="text-sm leading-relaxed">{f.summary}</p>

      {Object.keys(f.computed).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {Object.entries(f.computed)
            .filter(([, v]) => v !== '' && v != null)
            .map(([k, v]) => (
              <span key={k} className="font-mono text-[11px] text-muted-foreground">
                {k.replace(/_/g, ' ')}: <span className="text-foreground">{String(v)}</span>
              </span>
            ))}
        </div>
      )}

      {/* §G3: the quote comes from the clause store, never from a model. */}
      {f.clause_quotes.length > 0 && (
        <div className="mt-4 space-y-2 border-l border-border pl-4">
          {f.clause_quotes.map((q, i) => (
            <p key={i} className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-mono text-[11px] text-foreground">
                {f.clause_ids[i] ?? ''}
              </span>{' '}
              {q}
            </p>
          ))}
        </div>
      )}

      {f.status !== 'pass' && f.required_action && (
        <p className="mt-4 text-xs leading-relaxed">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Action{' '}
          </span>
          {f.required_action}
        </p>
      )}

      {f.verifier_reason && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono text-[10px] uppercase tracking-widest">Independent check </span>
          {f.verifier_reason}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-x-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {f.drawing_reference && <span>{f.drawing_reference}</span>}
        <span>reviewer: {f.reviewer_state}</span>
      </div>
    </li>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-xs font-medium tracking-tight transition-colors ${
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function ApplicabilityPanel({
  applicability: a,
}: {
  applicability: NonNullable<ApiResult['applicability']>;
}) {
  const rows: Array<[string, string]> = [
    ['Major occupancy', a.major_occupancy],
    ['Storeys', String(a.storeys)],
    ['Building area', `${a.building_area_m2} m2`],
    ['Technical Part', `Part ${a.code_parts.join(', ')}`],
    ['Energy', a.energy_path === 'NBC_9.36' ? 'Section 9.36' : 'NECB 2020'],
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <div className="border-b border-border bg-secondary/40 px-5 py-3">
        <Eyebrow>Applicability</Eyebrow>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {a.edition} · confidence {(a.confidence * 100).toFixed(0)} percent
        </p>
      </div>
      <dl className="divide-y divide-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-2 px-5 py-3">
            <dt className="w-44 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {k}
            </dt>
            <dd className="min-w-0 flex-1 text-sm">{v}</dd>
          </div>
        ))}
      </dl>
      {/* Why each determination was reached, since the Part decides every rule. */}
      <div className="space-y-1 border-t border-border bg-secondary/20 px-5 py-3">
        {Object.entries(a.basis).map(([k, v]) => (
          <p key={k} className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-mono">{k.replace(/_/g, ' ')}:</span> {v}
          </p>
        ))}
      </div>
    </div>
  );
}

function SheetsPanel({ sheets, facts }: { sheets: SheetSummary[]; facts: Fact[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <div className="border-b border-border bg-secondary/40 px-5 py-3">
        <Eyebrow>Sheets read</Eyebrow>
      </div>
      <ul className="divide-y divide-border">
        {sheets.map((s) => {
          const mine = facts.filter(
            (f) => f.provenance === 'drawing_text' && f.sheet === s.number,
          );
          return (
            <li key={s.number} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{s.number}</span>
                <span className="text-sm">{s.title}</span>
                {s.not_to_scale && (
                  <span className="rounded-full border border-amber-500/40 px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-amber-500">
                    not to scale
                  </span>
                )}
                {!s.has_text_layer && (
                  <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    no text layer
                  </span>
                )}
                <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {s.units}
                </span>
              </div>

              {mine.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  No value could be read off this sheet.
                </p>
              ) : (
                <ul className="mt-3 space-y-1">
                  {mine.map((f) => (
                    <li key={f.id} className="font-mono text-[11px] text-muted-foreground">
                      <span className="text-foreground">
                        {f.kind.replace(/_/g, ' ')} = {String(f.value)}
                        {f.unit ? ` ${f.unit}` : ''}
                      </span>
                      {' · '}
                      {f.subject}
                      {' · '}
                      <span title="Read verbatim off the sheet">&ldquo;{f.source_text}&rdquo;</span>
                      {!f.stable && (
                        <span className="text-amber-500" title="Read in only one of two passes, so it cannot support a failure">
                          {' '}
                          unstable
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** §G10: what produced this run, visible rather than buried in a log. */
function RunFooter({ result }: { result: ApiResult }) {
  return (
    <div className="rounded-2xl border border-border px-5 py-4">
      <Eyebrow>Run</Eyebrow>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>run {result.run_id}</span>
        <span>{result.code_edition}</span>
        <span>store {result.code_store_hash.slice(0, 12)}</span>
        <span>${result.audit.total_cost_usd.toFixed(4)}</span>
        <span>{result.audit.usage.length} model calls</span>
        {result.verification.checked > 0 && (
          <span>
            {result.verification.checked} verified, {result.verification.downgraded} downgraded
          </span>
        )}
      </div>
    </div>
  );
}
