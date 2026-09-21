import { supabaseAdmin } from './supabase';
import { mergeExtraction, type RawExtraction } from './extract';
import type { ExtractedSheet, FileType } from './types';

// ---------------------------------------------------------------------------
// Extend extraction path.
//
// The Extend integration is built on the official Python SDK, so the actual API
// call lives in api/extend_extract.py (a Vercel Python function). This module is
// the TypeScript half: it signs the uploaded plan, calls that function, and maps
// Extend's output onto the ExtractedSheet shape the rule engine already reads.
//
// Extend accepts a file as `url`, `id`, or `text` — not base64 — so we hand it a
// short-lived signed URL for the object app/api/analyze/route.ts just uploaded
// to the Supabase `plans` bucket. Their docs recommend presigned URLs with a
// 5-15 minute expiry for production use.
// ---------------------------------------------------------------------------

/** Units the schema is allowed to return; mirrors extend/extract.config.json. */
const UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);

/** Below this OCR confidence a field is reported rather than trusted silently. */
const LOW_CONFIDENCE = 0.7;

const SIGNED_URL_TTL_SECONDS = 600;

interface Measurement {
  value?: number | null;
  unit?: string | null;
}

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v: unknown): AnyRecord[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function asText(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function asMeasurement(v: unknown): Measurement | undefined {
  return isRecord(v) ? (v as Measurement) : undefined;
}

/**
 * Render a {value, unit} pair as the united string ExtractedSheet carries.
 *
 * This is the whole point of asking Extend for a number and a unit separately:
 * lib/rule-engine/units.ts can only trust a magnitude when the source named its
 * unit, and a model that writes dimensions as free text produces bare numbers
 * that may be metres or millimetres. Here the unit is always explicit, so
 * parseDimension() reports explicitUnit: true and the runner stops hedging.
 *
 * When Extend could not read a unit we deliberately emit the bare number. That
 * keeps the existing low-trust path intact rather than inventing a unit.
 */
export function formatMeasurement(m: unknown): string | undefined {
  const measurement = asMeasurement(m);
  if (!measurement) return undefined;
  const { value, unit } = measurement;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const cleanUnit = typeof unit === 'string' && UNITS.has(unit) ? unit : undefined;
  return cleanUnit ? `${value} ${cleanUnit}` : String(value);
}

/** Join two measurements into the "W x L" form ExtractedSheet.rooms uses. */
function formatSpan(a: unknown, b: unknown): string | undefined {
  const parts = [formatMeasurement(a), formatMeasurement(b)].filter((s): s is string => !!s);
  if (parts.length === 0) return undefined;
  return parts.join(' x ');
}

/**
 * Push a measurement that has no home in ExtractedSheet's typed arrays into
 * `dimensions`, so nothing Extend read is thrown away. Door heights, ceiling
 * heights, stair headroom and travel distances are all code-relevant and the
 * rule engine reads `dimensions`.
 */
function pushDimension(
  out: NonNullable<RawExtraction['dimensions']>,
  element: string | undefined,
  raw: unknown,
): void {
  const measurement = asMeasurement(raw);
  if (!element || !measurement) return;
  const { value, unit } = measurement;
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  out.push({
    element,
    value: String(value),
    unit: typeof unit === 'string' && UNITS.has(unit) ? unit : '',
  });
}

/**
 * Map Extend's extract output onto RawExtraction.
 *
 * With advancedOptions.citationsEnabled the run output is
 * { value: <your schema>, metadata: { "<path>": { citations, ocrConfidence } } },
 * so the schema data is under `value` rather than at the top level. Accept both
 * shapes: a future config change that turns citations off must not silently
 * produce an empty sheet.
 */
export function mapExtendOutput(output: unknown): RawExtraction {
  const root = isRecord(output) ? output : {};
  const data = isRecord(root.value) ? root.value : root;

  const dimensions: NonNullable<RawExtraction['dimensions']> = [];
  const annotations: string[] = [];

  const rooms = asArray(data.rooms).map((r) => {
    const name = asText(r.room_name) ?? 'unnamed room';
    pushDimension(dimensions, `${name} ceiling height`, r.ceiling_height);
    return {
      name,
      dimensions: formatSpan(r.room_width, r.room_length),
      area: formatMeasurement(r.room_floor_area),
    };
  });

  const doors = asArray(data.doors).map((d) => {
    const location = asText(d.door_label) ?? 'untagged door';
    pushDimension(dimensions, `${location} height`, d.door_height);
    const type = asText(d.door_type);
    const exterior = d.is_exterior_door === true ? 'exterior' : undefined;
    return {
      location,
      width: formatMeasurement(d.door_clear_width),
      // Keep the exterior flag visible to the rule engine, which has no
      // dedicated field for it but does read door `type`.
      type: [type, exterior].filter(Boolean).join(' ') || undefined,
    };
  });

  const corridors = asArray(data.corridors).map((c) => ({
    location: asText(c.corridor_location) ?? 'unnamed corridor',
    width: formatMeasurement(c.corridor_clear_width),
    length: formatMeasurement(c.corridor_length),
  }));

  const stairs = asArray(data.stairs).map((s) => {
    const location = asText(s.stair_location) ?? 'unnamed stair';
    pushDimension(dimensions, `${location} headroom`, s.headroom_height);
    if (typeof s.riser_count === 'number' && Number.isFinite(s.riser_count)) {
      annotations.push(`${location}: ${s.riser_count} risers`);
    }
    return {
      location,
      width: formatMeasurement(s.stair_clear_width),
      rise: formatMeasurement(s.riser_height),
      run: formatMeasurement(s.tread_run),
    };
  });

  const egress_paths = asArray(data.egress_paths).map((e) => {
    const from = asText(e.path_origin) ?? 'unspecified';
    const to = asText(e.path_destination) ?? 'unspecified';
    pushDimension(dimensions, `travel distance ${from} to ${to}`, e.travel_distance);
    return { from, to, width: formatMeasurement(e.path_clear_width) };
  });

  for (const d of asArray(data.dimensions)) {
    pushDimension(dimensions, asText(d.dimension_element), d.dimension_value);
  }

  for (const note of Array.isArray(data.plan_notes) ? data.plan_notes : []) {
    const text = asText(note);
    if (text) annotations.push(text);
  }

  return {
    rooms,
    doors,
    corridors,
    stairs,
    egress_paths,
    dimensions,
    annotations,
    occupancy_type: asText(data.occupancy_classification),
    building_type: asText(data.building_type),
  };
}

/**
 * Collect field paths Extend read with low OCR confidence.
 *
 * A compliance report must never present a doubtful reading as fact, so these
 * are surfaced as warnings on the sheet rather than being quietly accepted.
 */
export function lowConfidenceFields(output: unknown, threshold = LOW_CONFIDENCE): string[] {
  const root = isRecord(output) ? output : {};
  const metadata = isRecord(root.metadata) ? root.metadata : {};
  const flagged: string[] = [];

  for (const [path, meta] of Object.entries(metadata)) {
    if (!isRecord(meta)) continue;
    const confidence = meta.ocrConfidence;
    if (typeof confidence === 'number' && confidence < threshold) {
      flagged.push(`${path} (${confidence.toFixed(2)})`);
    }
  }

  return flagged.sort();
}

/** Absolute URL of the Python function, which differs per environment. */
function extendFunctionUrl(): string {
  const explicit = process.env.EXTEND_FUNCTION_URL;
  if (explicit) return explicit;
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  return `${base}/api/extend_extract`;
}

export interface ExtendRunResult {
  ok: boolean;
  runId?: string;
  status?: string;
  output?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean; requestId?: string };
}

/** Create a short-lived signed URL for an object already in the `plans` bucket. */
export async function signPlanUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from('plans')
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(`could not sign plan URL: ${error?.message ?? 'no URL returned'}`);
  }
  return data.signedUrl;
}

/** POST the signed URL to the Python function and return its parsed result. */
export async function callExtendFunction(
  fileUrl: string,
  fileName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtendRunResult> {
  const response = await fetchImpl(extendFunctionUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: fileUrl, name: fileName }),
  });

  const text = await response.text();
  try {
    return JSON.parse(text) as ExtendRunResult;
  } catch {
    return {
      ok: false,
      error: {
        code: `HTTP_${response.status}`,
        message: text.slice(0, 300) || 'extend function returned a non-JSON response',
        retryable: false,
      },
    };
  }
}

/**
 * Extract one sheet through Extend, returning the canonical ExtractedSheet.
 *
 * A failure is recorded in annotations.other with an EXTEND_ERROR: prefix, which
 * app/api/analyze/route.ts already lifts into the response `warnings` and which
 * sheetHasUsableData() treats as unusable. That matters: a sheet Extend could
 * not read must never reach the compliance pass looking like a clean one.
 */
export async function extractSheetViaExtend(args: {
  sheetName: string;
  fileType: FileType;
  storagePath: string;
  deps?: {
    sign?: typeof signPlanUrl;
    call?: typeof callExtendFunction;
  };
}): Promise<ExtractedSheet> {
  const { sheetName, fileType, storagePath, deps } = args;
  const sign = deps?.sign ?? signPlanUrl;
  const call = deps?.call ?? callExtendFunction;

  const fail = (message: string): ExtractedSheet => {
    const sheet = mergeExtraction(sheetName, fileType, {});
    sheet.annotations = {
      ...sheet.annotations,
      other: [...sheet.annotations.other, `EXTEND_ERROR: ${message}`],
    };
    return sheet;
  };

  let signedUrl: string;
  try {
    signedUrl = await sign(storagePath);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  let result: ExtendRunResult;
  try {
    result = await call(signedUrl, sheetName);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (!result.ok) {
    const e = result.error ?? {};
    const parts = [e.code ?? 'UNKNOWN', e.message ?? 'extract failed'];
    if (e.requestId) parts.push(`requestId=${e.requestId}`);
    return fail(parts.join(' — '));
  }

  const sheet = mergeExtraction(sheetName, fileType, mapExtendOutput(result.output));

  const notes: string[] = [];
  if (result.runId) notes.push(`EXTEND_RUN: ${result.runId}`);
  const lowConfidence = lowConfidenceFields(result.output);
  if (lowConfidence.length > 0) {
    notes.push(`EXTEND_LOW_CONFIDENCE: ${lowConfidence.slice(0, 12).join(', ')}`);
  }
  sheet.annotations = { ...sheet.annotations, other: [...sheet.annotations.other, ...notes] };

  return sheet;
}
