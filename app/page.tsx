'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function severityBorder(severity: Violation['severity']): string {
  if (severity === 'critical') return '#EF4444';
  if (severity === 'major') return '#F59E0B';
  return '#3B82F6';
}

function severityLabel(severity: Violation['severity']): string {
  return severity.toUpperCase();
}

const INITIAL_STEPS: PipelineStep[] = [
  { label: 'Parsing files', status: 'pending' },
  { label: 'Extracting plan data', status: 'pending' },
  { label: 'Retrieving code sections', status: 'pending' },
  { label: 'Analyzing violations', status: 'pending' },
];

export default function PlanqPage() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    const stored = (typeof window !== 'undefined'
      ? (localStorage.getItem('planq-theme') as Theme | null)
      : null) ?? 'dark';
    setTheme(stored === 'light' ? 'light' : 'dark');
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

  return (
    <main className="min-h-screen bg-bg text-fg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-baseline justify-between px-6 py-5">
          <div className="flex items-baseline gap-3">
            <span className="font-sans text-2xl font-bold tracking-tight">planq</span>
            <span className="font-mono text-xs text-muted">by staqtech</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden font-mono text-[11px] uppercase tracking-widest text-muted sm:inline">
              building code violation checker
            </span>
            <button
              onClick={toggleTheme}
              aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              className="border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted transition-colors hover:text-fg"
            >
              {theme === 'dark' ? 'light' : 'dark'} mode
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-10">
        <div className="space-y-6">
          <div>
            <label className="mb-2 block font-mono text-[11px] uppercase tracking-widest text-muted">
              Project name
            </label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. 240 Pine Street — 4-storey mixed-use"
              className="w-full border border-border bg-card px-4 py-3 text-fg placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

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
            className={`cursor-pointer border border-dashed px-6 py-12 text-center transition-colors ${
              dragActive ? 'border-accent bg-dropActive' : 'border-border bg-cardSubtle'
            }`}
          >
            <p className="font-sans text-base">Drag plans here, or click to browse</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted">
              .pdf · .png · .jpg · .tiff · .dxf · .dwg
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
            <ul className="border border-border">
              {files.map((pf, i) => (
                <li
                  key={`${pf.file.name}-${i}`}
                  className="flex items-center justify-between border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
                      {pf.fileType}
                    </span>
                    <span className="font-sans text-sm">{pf.file.name}</span>
                    <span className="font-mono text-[10px] text-muted">
                      {(pf.file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <button
                    onClick={() => removeFile(i)}
                    className="font-mono text-[11px] uppercase tracking-widest text-muted hover:text-fg"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={runAnalyze}
              disabled={analyzing || files.length === 0}
              className="bg-accent px-6 py-3 font-sans text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {analyzing ? 'Analyzing…' : 'Analyze Plans'}
            </button>
            {error && <span className="font-mono text-[11px] text-critical">{error}</span>}
          </div>

          {(analyzing || steps.some((s) => s.status !== 'pending')) && (
            <ol className="border border-border">
              {steps.map((step, i) => (
                <li
                  key={step.label}
                  className="flex items-center justify-between border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="font-sans text-sm">{step.label}</span>
                  </div>
                  <span
                    className={`font-mono text-[11px] uppercase tracking-widest ${
                      step.status === 'done'
                        ? 'text-accent'
                        : step.status === 'active'
                          ? 'text-fg'
                          : 'text-muted'
                    }`}
                  >
                    {step.status === 'done'
                      ? 'done'
                      : step.status === 'active'
                        ? 'running'
                        : 'pending'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {result && (
          <div className="mt-12 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border border-border px-5 py-4">
              <div className="flex items-baseline gap-6">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
                    total violations
                  </p>
                  <p className="font-sans text-3xl font-bold">
                    {result.violations.length}
                  </p>
                </div>
                <SummaryStat label="critical" value={result.summary.critical} color="#EF4444" />
                <SummaryStat label="major" value={result.summary.major} color="#F59E0B" />
                <SummaryStat label="minor" value={result.summary.minor} color="#3B82F6" />
                <SummaryStat label="compliance" value={result.summary.compliance} />
                <SummaryStat label="consistency" value={result.summary.consistency} />
              </div>
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted">
                sheets analyzed: {result.sheets_analyzed}
              </p>
            </div>

            {result.sheets && result.sheets.length > 0 && (
              <ExtractedSheetsPanel sheets={result.sheets} />
            )}

            <div className="flex flex-wrap gap-2">
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

            {filteredViolations.length === 0 ? (
              <div className="border border-border px-6 py-12 text-center">
                <p className="font-sans text-2xl text-emerald-400">✓</p>
                <p className="mt-2 font-sans text-base">No violations found</p>
                <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted">
                  {result.violations.length === 0
                    ? 'plans look clean'
                    : 'no matches for current filter'}
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {filteredViolations.map((v, i) => (
                  <li
                    key={i}
                    className="border border-border bg-cardSubtle px-5 py-4"
                    style={{ borderLeftColor: severityBorder(v.severity), borderLeftWidth: 3 }}
                  >
                    <div className="mb-2 flex items-center gap-3">
                      <span className="border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest">
                        {v.type}
                      </span>
                      <span
                        className="font-mono text-[10px] uppercase tracking-widest"
                        style={{ color: severityBorder(v.severity) }}
                      >
                        {severityLabel(v.severity)}
                      </span>
                      {v.section_id && (
                        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                          §{v.section_id}
                        </span>
                      )}
                    </div>
                    <p className="font-sans text-sm leading-relaxed">{v.description}</p>
                    {v.code_citation && v.type === 'compliance' && (
                      <p className="mt-2 font-mono text-[11px] text-muted">
                        {v.code_citation}
                      </p>
                    )}
                    {v.affected_sheets && v.affected_sheets.length > 0 && v.type === 'consistency' && (
                      <p className="mt-2 font-mono text-[11px] text-muted">
                        sheets: {v.affected_sheets.join(', ')}
                      </p>
                    )}
                    {v.location_hint && (
                      <p className="mt-2 font-mono text-[11px] text-muted">
                        location: {v.location_hint}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function SummaryStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{label}</p>
      <p className="font-sans text-xl font-bold text-fg" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
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
      className={`border px-3 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-fg'
          : 'border-border text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

function ExtractedSheetsPanel({ sheets }: { sheets: ExtractedSheet[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="border border-border">
      <div className="border-b border-border px-5 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
          extracted plan data
        </p>
      </div>
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
          <div key={`${sheet.sheet_name}-${idx}`} className="border-b border-border last:border-b-0">
            <button
              onClick={() => setOpenIndex(isOpen ? null : idx)}
              className="flex w-full items-center justify-between px-5 py-3 text-left transition-colors hover:bg-cardHover"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
                  {sheet.file_type}
                </span>
                <span className="font-sans text-sm">{sheet.sheet_name}</span>
                {(sheet.occupancy_type || sheet.building_type) && (
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                    {[sheet.occupancy_type, sheet.building_type].filter(Boolean).join(' / ')}
                  </span>
                )}
              </div>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {counts.map(([k, v]) => `${v} ${k}`).join('  ·  ')}
              </span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-1 gap-6 border-t border-border px-5 py-4 md:grid-cols-2">
                {(sheet.occupancy_type || sheet.building_type) && (
                  <div className="md:col-span-2">
                    <SectionLabel>classification</SectionLabel>
                    <p className="font-sans text-sm">
                      {sheet.occupancy_type ? (
                        <>
                          <span className="text-muted">occupancy:</span> {sheet.occupancy_type}
                        </>
                      ) : null}
                      {sheet.occupancy_type && sheet.building_type ? '  ·  ' : null}
                      {sheet.building_type ? (
                        <>
                          <span className="text-muted">building type:</span> {sheet.building_type}
                        </>
                      ) : null}
                    </p>
                  </div>
                )}

                <ListBlock label="rooms" empty={sheet.rooms.length === 0}>
                  {sheet.rooms.map((r, i) => (
                    <li key={i} className="font-sans text-sm">
                      {r.name}
                      {r.dimensions ? (
                        <span className="font-mono text-[11px] text-muted"> · {r.dimensions}</span>
                      ) : null}
                      {r.area ? (
                        <span className="font-mono text-[11px] text-muted"> · {r.area}</span>
                      ) : null}
                    </li>
                  ))}
                </ListBlock>

                <ListBlock label="doors" empty={sheet.doors.length === 0}>
                  {sheet.doors.map((d, i) => (
                    <li key={i} className="font-sans text-sm">
                      {d.location}
                      {d.width ? (
                        <span className="font-mono text-[11px] text-muted"> · {d.width}</span>
                      ) : null}
                      {d.type ? (
                        <span className="font-mono text-[11px] text-muted"> · {d.type}</span>
                      ) : null}
                    </li>
                  ))}
                </ListBlock>

                <ListBlock label="corridors" empty={sheet.corridors.length === 0}>
                  {sheet.corridors.map((c, i) => (
                    <li key={i} className="font-sans text-sm">
                      {c.location}
                      {c.width ? (
                        <span className="font-mono text-[11px] text-muted"> · {c.width}</span>
                      ) : null}
                      {c.length ? (
                        <span className="font-mono text-[11px] text-muted"> · {c.length}</span>
                      ) : null}
                    </li>
                  ))}
                </ListBlock>

                <ListBlock label="stairs" empty={sheet.stairs.length === 0}>
                  {sheet.stairs.map((s, i) => (
                    <li key={i} className="font-sans text-sm">
                      {s.location}
                      {s.width ? (
                        <span className="font-mono text-[11px] text-muted"> · w {s.width}</span>
                      ) : null}
                      {s.rise ? (
                        <span className="font-mono text-[11px] text-muted"> · r {s.rise}</span>
                      ) : null}
                      {s.run ? (
                        <span className="font-mono text-[11px] text-muted"> · run {s.run}</span>
                      ) : null}
                    </li>
                  ))}
                </ListBlock>

                <ListBlock label="egress paths" empty={sheet.egress_paths.length === 0}>
                  {sheet.egress_paths.map((e, i) => (
                    <li key={i} className="font-sans text-sm">
                      {e.from} → {e.to}
                      {e.width ? (
                        <span className="font-mono text-[11px] text-muted"> · {e.width}</span>
                      ) : null}
                    </li>
                  ))}
                </ListBlock>

                <ListBlock label="dimensions" empty={sheet.dimensions.length === 0}>
                  {sheet.dimensions.slice(0, 12).map((d, i) => (
                    <li key={i} className="font-mono text-[11px]">
                      {d.element}: {d.value} {d.unit}
                    </li>
                  ))}
                  {sheet.dimensions.length > 12 && (
                    <li className="font-mono text-[10px] text-muted">
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
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">{children}</p>
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
        <p className="font-mono text-[11px] text-muted">none</p>
      ) : (
        <ul className="space-y-1">{children}</ul>
      )}
    </div>
  );
}

function AnnotationsView({ buckets }: { buckets: AnnotationBuckets }) {
  const [showAll, setShowAll] = useState(false);
  const groups: Array<{ label: string; items: string[]; mono?: boolean }> = [
    { label: 'rooms (from labels)', items: buckets.rooms },
    { label: 'doors', items: buckets.doors, mono: true },
    { label: 'dimensions', items: buckets.dimensions, mono: true },
    { label: 'levels', items: buckets.levels, mono: true },
    { label: 'totals & areas', items: buckets.totals },
    { label: 'sections / elevations', items: buckets.sections },
    { label: 'other', items: buckets.other },
  ].filter((g) => g.items.length > 0);

  if (groups.length === 0) return null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>annotations</SectionLabel>
        <button
          onClick={() => setShowAll((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-widest text-muted hover:text-fg"
        >
          {showAll ? 'collapse' : 'show all'}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const limit = showAll ? g.items.length : Math.min(8, g.items.length);
          const shown = g.items.slice(0, limit);
          return (
            <div key={g.label} className="border border-border bg-cardSubtle px-3 py-2">
              <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                {g.label} ({g.items.length})
              </p>
              <ul className="space-y-[2px]">
                {shown.map((item, i) => (
                  <li
                    key={i}
                    className={`${g.mono ? 'font-mono text-[11px]' : 'font-sans text-xs'} text-fg`}
                  >
                    {item}
                  </li>
                ))}
                {g.items.length > limit && (
                  <li className="font-mono text-[10px] text-muted">
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
