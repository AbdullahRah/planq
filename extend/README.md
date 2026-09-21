# Extend extraction

> ## ⏸ Parked — not built, not deployed
>
> Planq runs the OpenRouter vision path (`lib/extract.ts`). Extend is switched
> off and its build inputs have been moved out of the paths Vercel detects, so
> no Python runtime is provisioned, `pip install` does not run, and no function
> is deployed for it.
>
> **Nothing was deleted.** Everything needed to restore it is under
> `extend/parked/`:
>
> | Parked at | Restore to | Why it was moved |
> |---|---|---|
> | `extend/parked/api/extend_extract.py` | `api/extend_extract.py` | Vercel zero-config builds a Python function for any `api/*.py` |
> | `extend/parked/requirements.txt` | `requirements.txt` | a root `requirements.txt` triggers `pip install` on every build |
> | `extend/parked/.python-version` | `.python-version` | pins the Python runtime |
> | `extend/parked/vercel.json` | `vercel.json` | held only the `maxDuration`/`excludeFiles` config for that function |
> | `extend/parked/tests/test_extend_extract.py` | `tests/test_extend_extract.py` | runs via `npm run test:extend-py` (path already points at the parked copy) |
>
> `lib/extend-extract.ts` was **left in place and is still under test**
> (`npm run test:extend`), but `app/api/analyze/route.ts` no longer imports it,
> which is what keeps it out of the deployed bundle. Setting
> `EXTRACT_PROVIDER=extend` now returns a 500 that says so, rather than falling
> back to vision silently.
>
> **To restore:** move the five files back to the paths above, re-add
> `import { extractSheetViaExtend } from '@/lib/extend-extract'` and the
> `useExtend` branch in `route.ts`, remove the guard near the top of `POST`, then
> set `EXTEND_API_KEY` and `EXTRACT_PROVIDER=extend` in the Vercel project.
>
> Deleting `vercel.json` did not change the analyze route's timeout:
> `route.ts` declares `export const maxDuration = 300` itself.

Structured extraction of architectural sheets through [Extend](https://docs.extend.ai),
as an alternative to the OpenRouter vision path in `lib/extract.ts`.

## How it fits together

Planq's application code is TypeScript, but this integration is built on Extend's
**Python SDK**. Python therefore runs as its own Vercel Function:

```
app/api/analyze/route.ts      existing upload + analyze path
  └─ lib/extend-extract.ts    signs the Supabase object, calls the function, maps the result
      └─ api/extend_extract.py    extend-ai SDK; loads extend/extract.config.json
```

Vercel's Python runtime owns the root `api/` directory and Next.js owns `app/api/`,
so the two coexist in one deployment. `api/extend_extract.py` serves
`/api/extend_extract`.

Extend accepts a file as a URL, a file ID, or raw text — **not base64** — so the
route hands it a 10-minute signed URL for the object it just uploaded to the
Supabase `plans` bucket.

Output is mapped onto the existing `ExtractedSheet` type via `mergeExtraction()`,
so the rule engine and compliance passes are unchanged.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   pip install -r extend/parked/requirements.txt   # extend-ai, for api/ and the tests
   ```

2. **Add your API key.** Create one at <https://dashboard.extend.ai> → Developers.

   ```bash
   # .env.local  (gitignored — never commit a real key)
   EXTEND_API_KEY=sk_...
   ```

   For deploys, add the same variable to the Vercel project environment. The key
   is read server-side only, in `api/extend_extract.py`; it never reaches the browser.

3. **Turn the provider on.** It is off by default so nothing changes until you choose:

   ```bash
   EXTRACT_PROVIDER=extend     # or "vision" (default) for the OpenRouter path
   ```

   Only `pdf` and `image` sheets route through Extend. DXF still goes through
   `lib/parsers/dxf.ts`, which reads exact geometry and needs no model.

`EXTEND_FUNCTION_URL` is optional; the function URL is derived from `VERCEL_URL`
in production and `127.0.0.1:3000` locally.

## Iterating on the extraction

**`extend/extract.config.json` is the file to edit.** It holds the whole Extend
configuration — schema, extraction rules, parser and array settings — and is
loaded at runtime rather than hand-authored in code, so tuning accuracy never
means touching Python or TypeScript.

Current settings and why:

| Setting | Value | Reason |
|---|---|---|
| `baseProcessor` | `extraction_performance` | Drawings are visually complex; needs vision and figure parsing |
| `baseVersion` | *(unset)* | Lets the API pick its current default |
| `parseConfig.engine` | `parse_performance` | Dense linework and small dimension text |
| `advancedOptions.advancedMultimodalEnabled` | `true` | Layout and figures carry meaning here |
| `advancedOptions.citationsEnabled` | `true`, `citationMode: block` | Every value gets a page + bounding box, so a finding can be traced back to the sheet |
| `advancedOptions.arrayStrategy` | `large_array_max_context` | Door and room schedules must come back complete; a missed row is a missed violation |

Keys prefixed with `_` (such as `_comment`) are stripped before submission — the
API validates its request body strictly and would reject an unknown field.

**Measurements are numbers, not strings.** The schema asks for `{value, unit}`
pairs and `lib/extend-extract.ts` renders them as united strings like `"810 mm"`.
This is deliberate: `lib/rule-engine/units.ts` can only trust a magnitude whose
unit was stated, and a bare `2.4` could be metres or millimetres. When Extend
cannot read a unit, the bare number is passed through and stays flagged as
non-explicit, preserving the rule engine's existing low-trust path.

Where to iterate next:

- [Field names and prompt crafting](https://docs.extend.ai/extraction/best-practices/field-names-and-prompt-crafting.md) — accuracy
- [Latency optimization](https://docs.extend.ai/extraction/best-practices/latency-optimization.md) — cost and speed

## Failure reporting

An extraction that fails is **never** returned as an empty-but-clean sheet. The
sheet is annotated with one of:

| Marker | Meaning |
|---|---|
| `EXTEND_ERROR: <code> — <message>` | The run failed; carries the API error code and `requestId` |
| `EXTEND_LOW_CONFIDENCE: <field> (<score>)` | Read, but below the OCR confidence threshold |
| `EXTEND_RUN: <runId>` | The run id, for tracing in the dashboard |

`app/api/analyze/route.ts` lifts the first two into the response `warnings`, and
`sheetHasUsableData()` keeps a failed sheet out of the compliance pass — so a
sheet that could not be read can never be reported as having no violations.

Retries follow the [documented `retryable` flag](https://docs.extend.ai/api-reference/error-handling.md):
`RATE_LIMIT_EXCEEDED` and `INTERNAL_ERROR` back off and retry, everything else
surfaces immediately.

## Tests

```bash
npm test                  # everything
npm run test:extend       # TypeScript: output mapping, unit round-trip, error paths
npm run test:extend-py    # Python: config loading, retries, failure reporting
```

All Extend calls are mocked. No network, no credits. The Python suite skips with
a message if `pip install -r requirements.txt` has not been run.

## CLI

Useful for inspection without writing code — the application always uses the SDK.

```bash
extend whoami                     # which key and workspace are in effect
extend extractors list            # read-only connection check, spends nothing
extend parse <file>               # see what the parser sees
extend extract <file> --config extend/extract.config.json
```

Install: `npm install -g @extend-ai/cli` (or `brew install extend-hq/tap/extend`).
`EXTEND_API_KEY` in the environment always takes precedence.

## Cost

`extraction_performance` with citations and `large_array_max_context` is the
accurate-and-complete end of the dial, not the cheap end. Extend's published
Performance Parse figure is **$0.020/page**, so a 12-page set is roughly $0.24
per analysis versus about $0.003 through the OpenRouter path. Budget accordingly,
and see the latency-optimization guide above before turning it loose on a free tier.
