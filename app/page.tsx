'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import type { AnalysisResult, ExtractedSheet, FileType, Violation } from '@/lib/types';
import { totalAnnotationCount, type AnnotationBuckets } from '@/lib/annotations';

type Theme = 'dark' | 'light';

type SeverityFilter = 'all' | 'critical' | 'major' | 'minor';
type TypeFilter = 'all' | 'compliance' | 'consistency';

interface PendingFile {
  file: File;
  fileType: FileType;
}

interface PipelineStep {
  label: string;
  status: 'pending' | 'active' | 'done';
}

const ACCEPTED_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'dxf', 'dwg'];
const ACCEPT_ATTR = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.dxf,.dwg';

function detectFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'dwg') return 'dwg';
  return 'image';
}

function severityColor(severity: Violation['severity']): string {
  if (severity === 'critical') return '#EF4444';
  if (severity === 'major') return '#F59E0B';
  return '#3B82F6';
}

const INITIAL_STEPS: PipelineStep[] = [
  { label: 'Parsing files', status: 'pending' },
  { label: 'Extracting plan data', status: 'pending' },
  { label: 'Retrieving code sections', status: 'pending' },
  { label: 'Analyzing violations', status: 'pending' },
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
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  const ingestFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    const accepted: PendingFile[] = [];
    for (const file of list) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPTED_EXTS.includes(ext)) continue;
      accepted.push({ file, fileType: detectFileType(file.name) });
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

  const runAnalyze = async () => {
    if (analyzing || files.length === 0) return;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'pending' })));

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
      const json = (await res.json()) as AnalysisResult;
      advanceStep(3, 'done');
      setResult(json);
    } catch (err) {
      setError((err as Error).message);
      setSteps((prev) =>
        prev.map((s) => (s.status === 'active' ? { ...s, status: 'pending' } : s)),
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const filteredViolations = useMemo(() => {
    if (!result) return [];
    return result.violations.filter((v) => {
      if (severityFilter !== 'all' && v.severity !== severityFilter) return false;
      if (typeFilter !== 'all' && v.type !== typeFilter) return false;
      return true;
    });
  }, [result, severityFilter, typeFilter]);

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
                        {pf.fileType}
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

          {(analyzing || steps.some((s) => s.status !== 'pending')) && (
            <PipelineTable steps={steps} />
          )}
        </div>
      </section>

      {result && (
        <section className="border-t border-border px-6 py-20 md:px-12 md:py-28 lg:px-20 lg:py-32">
          <div className="mx-auto max-w-5xl space-y-12">
            <div>
              <Eyebrow>Verdict</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium tracking-tight md:text-4xl lg:text-5xl">
                {result.violations.length === 0
                  ? 'No violations found.'
                  : `${result.violations.length} violation${
                      result.violations.length === 1 ? '' : 's'
                    } across ${result.sheets_analyzed} sheet${
                      result.sheets_analyzed === 1 ? '' : 's'
                    }.`}
              </h2>
            </div>

            <StatStrip
              items={[
                { label: 'Total', value: result.violations.length },
                {
                  label: 'Critical',
                  value: result.summary.critical,
                  color: '#EF4444',
                },
                {
                  label: 'Major',
                  value: result.summary.major,
                  color: '#F59E0B',
                },
                {
                  label: 'Minor',
                  value: result.summary.minor,
                  color: '#3B82F6',
                },
                { label: 'Compliance', value: result.summary.compliance },
                { label: 'Consistency', value: result.summary.consistency },
              ]}
            />

            {result.warnings && result.warnings.length > 0 && (
              <div className="rounded-2xl border border-border bg-secondary/30 px-6 py-5">
                <Eyebrow>Warnings</Eyebrow>
                <ul className="mt-3 space-y-1">
                  {result.warnings.map((w, i) => (
                    <li
                      key={i}
                      className="font-mono text-xs"
                      style={{ color: '#F59E0B' }}
                    >
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.sheets && result.sheets.length > 0 && (
              <ExtractedSheetsPanel sheets={result.sheets} />
            )}

            <div>
              <Eyebrow>Violations</Eyebrow>
              <div className="mt-4 flex flex-wrap gap-2">
                <FilterButton
                  active={severityFilter === 'all' && typeFilter === 'all'}
                  onClick={() => {
                    setSeverityFilter('all');
                    setTypeFilter('all');
                  }}
                >
                  All
                </FilterButton>
                <FilterButton
                  active={severityFilter === 'critical'}
                  onClick={() => setSeverityFilter('critical')}
                >
                  Critical
                </FilterButton>
                <FilterButton
                  active={severityFilter === 'major'}
                  onClick={() => setSeverityFilter('major')}
                >
                  Major
                </FilterButton>
                <FilterButton
                  active={severityFilter === 'minor'}
                  onClick={() => setSeverityFilter('minor')}
                >
                  Minor
                </FilterButton>
                <FilterButton
                  active={typeFilter === 'compliance'}
                  onClick={() => setTypeFilter('compliance')}
                >
                  Compliance
                </FilterButton>
                <FilterButton
                  active={typeFilter === 'consistency'}
                  onClick={() => setTypeFilter('consistency')}
                >
                  Consistency
                </FilterButton>
              </div>
            </div>

            {filteredViolations.length === 0 ? (
              <div className="rounded-2xl border border-border bg-secondary/30 px-6 py-16 text-center">
                <Eyebrow>{result.violations.length === 0 ? 'Clean' : 'No matches'}</Eyebrow>
                <p className="mt-3 text-2xl font-medium tracking-tight md:text-3xl">
                  {result.violations.length === 0
                    ? 'These plans look clean.'
                    : 'Nothing matches the current filter.'}
                </p>
                {result.violations.length > 0 && (
                  <button
                    onClick={() => {
                      setSeverityFilter('all');
                      setTypeFilter('all');
                    }}
                    className="mt-6 rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-foreground hover:text-background"
                  >
                    Clear filter
                  </button>
                )}
              </div>
            ) : (
              <ul className="space-y-3">
                {filteredViolations.map((v, i) => (
                  <ViolationCard key={i} violation={v} />
                ))}
              </ul>
            )}
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

function ViolationCard({ violation: v }: { violation: Violation }) {
  return (
    <li
      className="rounded-2xl border border-border bg-secondary/30 px-6 py-5"
      style={{ borderLeftColor: severityColor(v.severity), borderLeftWidth: 3 }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {v.type}
        </span>
        <span
          className="font-mono text-[10px] uppercase tracking-widest"
          style={{ color: severityColor(v.severity) }}
        >
          {v.severity}
        </span>
        {v.section_id && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            §{v.section_id}
          </span>
        )}
      </div>
      <p className="text-sm leading-relaxed md:text-base">{v.description}</p>
      <div className="mt-3 space-y-1">
        {v.code_citation && v.type === 'compliance' && (
          <p className="font-mono text-xs text-muted-foreground">{v.code_citation}</p>
        )}
        {v.affected_sheets && v.affected_sheets.length > 0 && v.type === 'consistency' && (
          <p className="font-mono text-xs text-muted-foreground">
            sheets: {v.affected_sheets.join(', ')}
          </p>
        )}
        {v.location_hint && (
          <p className="font-mono text-xs text-muted-foreground">
            location: {v.location_hint}
          </p>
        )}
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

function ExtractedSheetsPanel({ sheets }: { sheets: ExtractedSheet[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div>
      <Eyebrow>Extracted plan data</Eyebrow>
      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        {sheets.map((sheet, idx) => {
          const isOpen = openIndex === idx;
          const counts = [
            ['rooms', sheet.rooms.length],
            ['doors', sheet.doors.length],
            ['corridors', sheet.corridors.length],
            ['stairs', sheet.stairs.length],
            ['egress', sheet.egress_paths.length],
            ['dimensions', sheet.dimensions.length],
          ] as const;
          return (
            <div
              key={`${sheet.sheet_name}-${idx}`}
              className="border-b border-border last:border-b-0"
            >
              <button
                onClick={() => setOpenIndex(isOpen ? null : idx)}
                className="flex w-full flex-wrap items-center justify-between gap-3 bg-card px-5 py-4 text-left transition-colors hover:bg-secondary/50"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {sheet.file_type}
                  </span>
                  <span className="text-sm font-medium">{sheet.sheet_name}</span>
                  {(sheet.occupancy_type || sheet.building_type) && (
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {[sheet.occupancy_type, sheet.building_type].filter(Boolean).join(' / ')}
                    </span>
                  )}
                </div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {counts.map(([k, v]) => `${v} ${k}`).join('  ·  ')}
                </span>
              </button>
              {isOpen && (
                <div className="grid grid-cols-1 gap-8 border-t border-border bg-secondary/20 px-5 py-6 md:grid-cols-2">
                  {(sheet.occupancy_type || sheet.building_type) && (
                    <div className="md:col-span-2">
                      <SectionLabel>Classification</SectionLabel>
                      <p className="text-sm">
                        {sheet.occupancy_type ? (
                          <>
                            <span className="text-muted-foreground">occupancy:</span>{' '}
                            {sheet.occupancy_type}
                          </>
                        ) : null}
                        {sheet.occupancy_type && sheet.building_type ? '  ·  ' : null}
                        {sheet.building_type ? (
                          <>
                            <span className="text-muted-foreground">building type:</span>{' '}
                            {sheet.building_type}
                          </>
                        ) : null}
                      </p>
                    </div>
                  )}

                  <ListBlock label="Rooms" empty={sheet.rooms.length === 0}>
                    {sheet.rooms.map((r, i) => (
                      <li key={i} className="text-sm">
                        {r.name}
                        {r.dimensions ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {r.dimensions}
                          </span>
                        ) : null}
                        {r.area ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {r.area}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ListBlock>

                  <ListBlock label="Doors" empty={sheet.doors.length === 0}>
                    {sheet.doors.map((d, i) => (
                      <li key={i} className="text-sm">
                        {d.location}
                        {d.width ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {d.width}
                          </span>
                        ) : null}
                        {d.type ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {d.type}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ListBlock>

                  <ListBlock label="Corridors" empty={sheet.corridors.length === 0}>
                    {sheet.corridors.map((c, i) => (
                      <li key={i} className="text-sm">
                        {c.location}
                        {c.width ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {c.width}
                          </span>
                        ) : null}
                        {c.length ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {c.length}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ListBlock>

                  <ListBlock label="Stairs" empty={sheet.stairs.length === 0}>
                    {sheet.stairs.map((s, i) => (
                      <li key={i} className="text-sm">
                        {s.location}
                        {s.width ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · w {s.width}
                          </span>
                        ) : null}
                        {s.rise ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · r {s.rise}
                          </span>
                        ) : null}
                        {s.run ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · run {s.run}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ListBlock>

                  <ListBlock label="Egress paths" empty={sheet.egress_paths.length === 0}>
                    {sheet.egress_paths.map((e, i) => (
                      <li key={i} className="text-sm">
                        {e.from} → {e.to}
                        {e.width ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {' '}
                            · {e.width}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ListBlock>

                  <ListBlock label="Dimensions" empty={sheet.dimensions.length === 0}>
                    {sheet.dimensions.slice(0, 12).map((d, i) => (
                      <li key={i} className="font-mono text-[11px]">
                        {d.element}: {d.value} {d.unit}
                      </li>
                    ))}
                    {sheet.dimensions.length > 12 && (
                      <li className="font-mono text-[10px] text-muted-foreground">
                        …and {sheet.dimensions.length - 12} more
                      </li>
                    )}
                  </ListBlock>

                  {totalAnnotationCount(sheet.annotations) > 0 && (
                    <div className="md:col-span-2">
                      <AnnotationsView buckets={sheet.annotations} />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

function ListBlock({
  label,
  empty,
  children,
}: {
  label: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      {empty ? (
        <p className="font-mono text-[11px] text-muted-foreground">none</p>
      ) : (
        <ul className="space-y-1">{children}</ul>
      )}
    </div>
  );
}

function AnnotationsView({ buckets }: { buckets: AnnotationBuckets }) {
  const [showAll, setShowAll] = useState(false);
  const groups: Array<{ label: string; items: string[]; mono?: boolean }> = [
    { label: 'Rooms (from labels)', items: buckets.rooms },
    { label: 'Doors', items: buckets.doors, mono: true },
    { label: 'Dimensions', items: buckets.dimensions, mono: true },
    { label: 'Levels', items: buckets.levels, mono: true },
    { label: 'Totals & areas', items: buckets.totals },
    { label: 'Sections / elevations', items: buckets.sections },
    { label: 'Other', items: buckets.other },
  ].filter((g) => g.items.length > 0);

  if (groups.length === 0) return null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Annotations</SectionLabel>
        <button
          onClick={() => setShowAll((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          {showAll ? 'Collapse' : 'Show all'}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const limit = showAll ? g.items.length : Math.min(8, g.items.length);
          const shown = g.items.slice(0, limit);
          return (
            <div key={g.label} className="rounded-2xl border border-border bg-card px-4 py-3">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {g.label} ({g.items.length})
              </p>
              <ul className="space-y-[2px]">
                {shown.map((item, i) => (
                  <li
                    key={i}
                    className={`${
                      g.mono ? 'font-mono text-[11px]' : 'text-xs'
                    } text-foreground`}
                  >
                    {item}
                  </li>
                ))}
                {g.items.length > limit && (
                  <li className="font-mono text-[10px] text-muted-foreground">
                    …+{g.items.length - limit} more
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
