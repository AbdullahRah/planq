# Planq

Planq reviews residential drawing sets against the Alberta building code before
they go in for a permit. Upload a PDF of the drawings and Planq returns a list of
findings. Each one names the clause it rests on, quotes that clause word for word
and points to the spot on the drawings it was read from.

Planq is a pre-submission review aid. It is not a permit approval, and no report
is meant to reach a client until a qualified person has signed it off.

- **Code in force:** NBC(AE) 2023, Alberta Edition (in force from 1 May 2024),
  second printing including the April 2026 revisions.
- **Scope today:** Part 9 buildings (houses and small buildings: 3 storeys or
  less, not more than 600 m² building area) and Section 9.36 energy.
- **Live app:** https://planq-app.vercel.app

`PLANQ_SPEC.md` is the design contract and `ROADMAP.md` lists what is not built
yet. This file explains how the system works, why it gives answers you can check,
and how to run it.

---

## Contents

1. [What a review produces](#1-what-a-review-produces)
2. [The pipeline](#2-the-pipeline)
3. [How answers are kept correct](#3-how-answers-are-kept-correct)
4. [Tuning, training and what is proprietary](#4-tuning-training-and-what-is-proprietary)
5. [Rules covered](#5-rules-covered)
6. [Repository layout](#6-repository-layout)
7. [Running it locally](#7-running-it-locally)
8. [Deploying](#8-deploying)
9. [Cost](#9-cost)
10. [Known limits](#10-known-limits)

---

## 1. What a review produces

Every finding has one of five statuses:

| Status | Meaning |
| --- | --- |
| **Fail** | A value read off the drawings breaks a code requirement, and the rule has proven precise enough to say so outright (see G8 below). |
| **Needs confirmation** | Looks like a failure, but either the rule has not yet earned the right to say "Fail" or the verifier could not rule out an explanation. A human decides. |
| **Drawing conflict** | The drawings disagree with themselves, for example 16 risers on the plan and 17 on the section. |
| **Can't determine** | The drawings do not show what the rule needs. This is a gap in the drawings, not a defect in the building. |
| **Pass** | A value on the drawings positively meets the requirement. |

A finding carries the rule id, the clause ids, the exact clause text, the facts it
used (with sheet, location and the verbatim text read off the sheet), the
computed numbers, the verifier's verdict and the reviewer's decision.

Missing information never becomes a Pass or a Fail. On a typical house most
findings are **Can't determine**, because permit drawings usually leave out
things like window sizes or alarm locations. That is the honest answer, and the
report turns those into a checklist of information to add.

---

## 2. The pipeline

```
upload
  -> S0 intake            read the sheets, text layer, legend, page images
  -> S1 applicability     which code Part governs this building        (Haiku)
  -> S2 extraction        read values off the drawings                 (Sonnet, vision)
  -> S3 rule engine       compare values to the code, in code          (no model for numbers)
  -> S4 verifier          try to refute every proposed failure         (Opus)
  -> S5 report            assemble the report from finding records     (no model)
  -> human sign-off
```

### Reviews run in the background

A review is too much work for one web request. A 26-sheet set needs about 52
vision calls plus a verifier call for every proposed failure, and a Vercel
function is stopped at 300 seconds. Inside one request a large set either
failed with a 504 or had to skip sheets and the independent check, and a
review that skips evidence is not one anyone can defend.

So a review is a durable workflow (`workflows/review.ts`, Vercel Workflow):

```
browser --signed URL--> Supabase Storage        (the file never passes through the API)
browser --POST /api/analyze--> start workflow   (returns at once)
browser --GET /api/analyze/[planId] every 3 s--> progress, then the result

workflow
  prepare   S0 + S1                                    one step
  read      S2, one sheet per step, 8 at a time        every sheet
  rules     S3                                         one step
  verify    S4, one finding per step, 4 at a time      every proposed failure
  save      findings, result, status -> Supabase       one step
```

Each step has its own time limit and retries on its own: a rate-limited or
overloaded API call waits a minute and tries again instead of losing the
sheet. A sheet or a check that still fails after its retries is recorded in
the report, never dropped silently. Progress is real (stage, and "sheet 14 of
26"), the plan id is in the page URL so a reload picks the review back up, and
closing the tab does not stop it.

The stages themselves are plain functions in `lib/review.ts`, shared by the
workflow and the command line (`npm run review`), so there is exactly one
pipeline. Model calls are capped at 16 in flight per instance, which keeps
well inside the API's token rate limit. Every stage reads and writes JSON that is
validated against a zod schema. If validation fails, the stage retries once with
the error attached, and then the run stops as `needs_manual_review` instead of
guessing.

### S0 Intake (`lib/intake/`)

- Opens the PDF with `pdfjs-dist`, keeps the native text layer if there is one,
  and renders each sheet to images (whole-sheet thumbnail plus overlapping tiles
  sized so dimension text is legible).
- Builds a sheet inventory: number, title, scale, units, size. "Not to scale" is
  flagged. Dual-unit sheets (`10.00 m [32'-9 3/4"]`) are detected so an imperial
  figure is never read as metric, which would be a 3.28× error. Imperial sets
  are supported: feet and inches (`4'-5 3/4"`), the door tag shorthand `2/8`
  (2'-8") and areas in ft² are converted in code, never by the model.
- **Reads the sheet's own legend** (`legend.ts`). Drawings declare their own
  notation: one set writes `N.P.T.` for floor level, another writes `T/O SLAB`
  or `F.F.E.`. Planq learns the notation from each set instead of hardcoding
  one. Notation it had to assume rather than read is listed in the report under
  "Notation assumed rather than read".
- Reads any facts sitting in the text layer directly (`native-facts.ts`), at no
  model cost.
- Warns when a title block says "educational use only", since that is a
  licensing problem for client work.

### S1 Applicability (`lib/stages/applicability.ts`, Haiku)

This is the most important single decision: pick the wrong Part and every rule
after it comes from the wrong part of the code.

- The model is given the controlling clause text (Division A 1.3.3.3.(1)) rather
  than asked to remember it.
- The model only reports **observations**: occupancy, storey count, the area of
  each storey, garage presence. The **decision** (Part 9 or Part 3, 9.36 or NECB)
  is computed in code from those observations.
- Building area is the largest storey footprint, not the total floor area and
  not the lot size. Both mistakes happened during development (the model once
  returned the 200 m² lot as the building area) and are now ruled out
  structurally: areas are read per storey and the footprint is computed.
- Scanned sheets have no text, so S1 is given their images and runs on Sonnet,
  which reads drawings more reliably than Haiku. Sets with a text layer stay on
  Haiku.
- Most house drawings have no area schedule. Then the model copies each plan's
  overall dimension strings and code multiplies them. That rectangle is never
  smaller than the real footprint, so it is a safe upper bound for the 600 m²
  test.
- Low confidence and conflicting inputs stop the run only when they could
  change the answer. A residential building still inside the Part 9 limits at
  twice the area read and one storey more continues, with a note for the
  reviewer saying why. Below confidence 0.3 the run always stops.

### S2 Extraction (`lib/stages/vision.ts`, Sonnet with vision)

This is the main path, not a fallback. Most real drawing sets are scans or
flattened exports with no usable text layer.

- Only printed values count: dimension strings, level marks, tags, schedules.
  The model never measures anything off the geometry.
- Every fact must carry the sheet, a bounding box and the verbatim text it came
  from (G2). A fact without those is thrown away.
- **Double extraction (G6).** Extraction runs twice with the tiles in a
  different order. A value that appears in only one run, or with a different
  number, is marked unstable and can never support a Fail. Stability is judged
  on the value read, not on how the model described it, because the model words
  the same stair differently each time.
- **Negative evidence.** For each rule the model also reports what it searched
  for and did not find, so "smoke alarms are not shown" is a recorded fact
  rather than a silence.
- The model is told what kind of fact each rule needs, not what the notation
  looks like, and the legend from S0 is passed as a hint, never a filter.

### S3 Rule engine (`lib/engine/`, `lib/rules/part9.ts`)

A rule is data plus a small evaluator, not a prompt.

- Each rule lists its clause ids, when it applies, which facts it needs and its
  thresholds. Thresholds were transcribed by hand from the code PDF, never
  written by a model.
- Applicability conditions and every numeric comparison run in TypeScript after
  unit normalization (`units.ts`). The model never decides whether 800 mm is
  less than 810 mm.
- Rules that cannot be reduced to a number ("is this assembly described
  sufficiently") go to Sonnet, which returns structure only:
  `{rule_id, supported_by_fact_ids, judgment, reasoning}`. The reasoning is for
  the reviewer and never feeds the verdict.

### S4 Verifier (`lib/stages/verify.ts`, Opus)

Every proposed Fail and Needs confirmation goes to a stronger model whose only
job is to **refute** it: is there something else on the drawings that satisfies
this requirement? The prompt is deliberately different from S3's, so the two
stages are less likely to share a blind spot. A finding that is not upheld is
downgraded one level and sent to the reviewer.

The example it exists for: a rooftop guard is flagged at 0.50 m because a section
shows a parapet that low, but a rail may sit on the parapet without being drawn.
The honest status is "fail pending confirmation", and the verifier is what
produces it.

### S5 Report (`lib/stages/report.ts`, no model)

The report is assembled in code from the finding records. A model asked to
"write up these findings" adds connecting sentences, and each of those is a new
claim nobody checked, so the report is not written by a model at all. It carries
the edition and printing, the applicability decision, the findings table, the
details, a checklist of missing information, the method and limits, and the
disclaimer.

---

## 3. How answers are kept correct

Planq started as a retrieval system (embeddings, a reranker, a model choosing
which code sections to cite). That approach was scrapped in October 2026 because
it could not guarantee two things a compliance tool needs: that a quoted clause
is real, and that a verdict was not the model doing arithmetic. Everything below
replaced it. The guardrail numbers match `PLANQ_SPEC.md` §7.

| # | Guardrail | What it prevents |
| --- | --- | --- |
| G1 | **Corpus completeness.** The clause store is built from the full 1,578-page NBC(AE) 2023 PDF and the build fails if the page count or the article index does not match. | An early prototype read a truncated slice of the PDF and concluded Part 9 did not exist. |
| G2 | **Evidence rule.** A fact must have a sheet, a location and the verbatim source text. | Values the model "saw" that are not on the drawings. |
| G3 | **Substring citation check.** The model may name clause ids. The text comes from the store, and every quote must be an exact substring of the stored clause. | Paraphrased, misremembered or invented code text. |
| G4 | **Deterministic verdicts.** Applicability and every numeric test run in code with unit conversion. | The model getting a comparison or a unit wrong. |
| G5 | **Absence is not a result.** Missing information gives Can't determine. Pass needs a positive fact. | False passes on things the drawings never showed. |
| G6 | **Double extraction.** Values must be read the same way twice before they can support a Fail. | One-off misreads turning into failures. |
| G7 | **Independent verifier.** Opus tries to refute each failure, and anything not upheld goes to a human. | Failures that have an innocent explanation elsewhere on the sheets. |
| G8 | **Per-rule precision gate.** A rule may show Fail only once it has measured precision of at least 95% on a benchmark. Otherwise its failures display as Needs confirmation. | A new or unproven rule calling something a failure with confidence it has not earned. |
| G9 | **Human sign-off.** No report is released until a named reviewer approves it. | Unreviewed output reaching a client. |
| G10 | **Audit trail.** Each run records input hashes, code edition and store hash, model ids, prompt versions, token use and cost. | Not being able to explain or reproduce a past result. |
| G11 | **Budget and loop limits.** A per-run dollar budget and one retry per stage. | Runaway cost or retry loops. |
| G12 | **Output hygiene.** No claim outside a finding record, and the disclaimer on every report. | The report saying more than the evidence does. |

### Specific correctness fixes made along the way

These were each found by running real drawings and are now covered in code:

- **Building area vs total floor area.** The 600 m² Part 9 limit applies to the
  footprint. Comparing total floor area against it pushed a large house into
  Part 3 and changed every rule.
- **Dual-unit sheets.** Each value must carry its own unit, so a bracketed
  imperial figure is never read as millimetres.
- **Stability by value, not wording.** Comparing how the model described an
  element marked every vision fact unstable and silently disabled all failures.
- **Deduplicating by element, not value.** Merging facts by kind and value
  collapsed seven different 800 mm doors into one.
- **Door rules scoped by room.** The door-width rules fired on bathroom doors
  against the 810 mm entrance threshold until an applicability condition was
  added.
- **Notation learned from the legend.** Early versions hardcoded one drawing
  set's Spanish notation (`P2` door tags, `N.P.T.` levels). Planq now reads each
  set's legend and reports anything it had to assume.

### Regression fixture

`PLANQ_SPEC.md` §9 lists the expected findings for the Chesnut residence, a
two-sheet sample house: a rooftop guard failure, a door needing confirmation, a
riser-count conflict between plan and section, five Can't determines, two
passes, and S1 selecting Part 9 and 9.36 rather than NECB. That sample is under
an educational-use licence and is for internal testing only.

---

## 4. Tuning, training and what is proprietary

### No model is trained or fine-tuned

Planq uses Anthropic's Claude models as they come, through the API. There is no
fine-tuning, no custom model weights and no training run. Nothing a client
uploads is used to train any model.

That is deliberate. A fine-tuned model would still be a model making the call,
and the point of the design is that the model never makes the call. Its job is
narrow: read values off drawings and try to argue against findings. The
verdicts come from code.

### Where the value is

What makes Planq work, and what a competitor could not get by calling the same
API, is the system around the model:

1. **The clause store.** The full NBC(AE) 2023 parsed into individual clause
   records (id, title, exact text, tables, notes, cross references, page, and a
   hash of the text), with a completeness check on the build. Code PDFs are
   hard to parse well. Tables in particular needed a custom layout
   reconstruction (`lib/code-store/extract.ts`, `tables.ts`).
2. **The rule library.** Code requirements turned into machine-checkable rules
   with hand-transcribed thresholds, applicability conditions and the facts each
   one needs (`lib/rules/part9.ts`). Each rule is checked against the clause
   store by `npm run verify:rules`.
3. **The pipeline design and guardrails.** The split between what the model
   reads and what code decides, double extraction, negative evidence, the
   adversarial verifier and the precision gate. These are what make the output
   checkable.
4. **The prompts.** Each stage's prompt is versioned (for example
   `s2-2026-10-05`) and recorded in the audit trail of every run. They encode
   lessons like asking for per-storey areas instead of "building area", and
   asking for kinds of facts instead of particular notation.
5. **Notation handling.** Reading each drawing set's legend so the system adapts
   to how a given firm draws, and recording what it had to assume.
6. **Reviewer data (coming).** Every reviewer confirmation or dismissal is a
   labelled example of whether a finding was right. That data is the asset that
   grows with use.

### How "tuning" works today

Tuning means changing the system, not the model:

- **Rules** get tighter applicability conditions when they fire where they
  should not (the door-width fix above).
- **Prompts** get revised when a stage misreads something. Each revision gets a
  new prompt version so its effect can be traced.
- **Guardrails** get added when a failure mode is found, so it cannot recur.
- **Model routing** is in one place (`lib/claude.ts`): Haiku for applicability,
  Sonnet for extraction and judgment, Opus for verification. A stage can be
  moved to a different model without touching its prompt.

### How Planq will learn from use

The plan in `ROADMAP.md` needs no model training, only collecting data and
measuring against it. In order:

1. **Store reviewer decisions** (confirmed or dismissed) against each finding,
   rule, fact and drawing convention.
2. **Measure precision per rule** from those decisions. When a rule passes 95%,
   G8 lets it display Fail. Today every rule has no measured precision, so the
   tool reports at most Needs confirmation. This step is what lets Planq say
   "this is wrong" with authority.
3. **Build a notation dictionary** from every legend read, so a set with no
   legend starts from what other sets declared, and a firm's own house style
   can take priority.
4. **Turn dismissal patterns into rule conditions.** If reviewers keep
   dismissing a rule in a particular situation, that is a missing applicability
   condition.
5. **Show the extractor confirmed examples** (few-shot prompting) once there are
   enough confirmed readings. This comes last because it is the easiest way to
   overfit to whatever drawings happen to be in the pile.

The golden set in `PLANQ_SPEC.md` §9 (30 to 50 real Alberta permit sets with
municipal comment letters) is what step 2 is measured against, and collecting it
is worth more than any further code.

---

## 5. Rules covered

All from NBC(AE) 2023 Part 9, defined in `lib/rules/part9.ts`:

| Rule | Clauses | Checks |
| --- | --- | --- |
| `guard-height` | 9.8.8.3. | 1 070 mm, or 900 mm inside a dwelling unit and for low exterior guards serving one unit |
| `guard-openings` | 9.8.8.5. | 100 mm sphere, 150 mm at stair triangles |
| `door-width-entrance` | Table 9.5.5.1. | 810 mm at entrances, vestibules, stairs and the basement passage |
| `door-width-rooms` | Table 9.5.5.1. | 760 mm for other rooms and balconies |
| `door-width-bathroom` | Table 9.5.5.1. | 610 mm for bathrooms and walk-in closets |
| `door-height` | Table 9.5.5.1. | 1 980 mm |
| `stair-risers` | Table 9.8.4.1. | Private stair rise 125 to 200 mm |
| `stair-runs` | Table 9.8.4.2. | Private stair run 255 to 355 mm |
| `stair-consistency` | (internal) | Riser counts agree between plan and section |
| `ceiling-height` | Table 9.5.3.1. | 2.1 m in habitable rooms, halls and bathrooms |
| `bedroom-egress-area` | 9.9.10.1. | 0.35 m² openable area unless sprinklered |
| `bedroom-egress-dimension` | 9.9.10.1. | No opening dimension under 380 mm |
| `spatial-separation` | 9.10.15.4., 9.10.15.5. | Rating, cladding and glazing near property lines |
| `garage-separation` | 9.10.9.18.(4), 9.10.13.15. | Air barrier and a self-closing, weather-stripped door |
| `smoke-alarms` | 9.10.19.1., 9.10.19.3. | Every storey, each bedroom and the hall serving bedrooms |
| `co-alarms` | 9.32.3.9. | Where there is a garage or fuel-burning appliance |
| `energy-tier` | Section 9.36. | Compliance path and Tier 1 data are stated |

Part 3 and NECB are selected correctly by S1 for buildings outside Part 9, but no
rules exist behind them yet, so such a building produces no findings.

---

## 6. Repository layout

```
app/
  page.tsx                  upload UI and five-status findings view
  api/analyze/upload/       creates the plan and a signed upload URL
  api/analyze/route.ts      starts the review workflow
  api/analyze/[planId]/     progress while it runs, then the result
workflows/review.ts         the review as a durable workflow (one step per sheet and per finding)
  sign-in/, sign-up/        Clerk auth pages
lib/
  review.ts                 the pipeline stages (S0 to S4), shared by the workflow and the CLI
  claude.ts                 Anthropic client, model routing, prices, run budgets
  schemas.ts                zod schemas: Fact, Finding, Rule, Applicability, audit
  intake/                   S0: sheets, rendering, legend reading, text-layer facts
  stages/                   S1 applicability, S2 vision, S4 verify, S5 report, runner
  engine/                   S3 evaluator and unit conversion
  rules/part9.ts            the rule library
  code-store/               clause store loader, PDF extraction, clause and table parsing
  supabase.ts               service-role client
scripts/                    CLI tools and test probes (see below)
supabase/migrations/        database schema
data/
  code-store.json           the built clause store (committed; the app reads it at runtime)
  *.pdf                     code PDF and sample drawings (gitignored)
PLANQ_SPEC.md               design contract
ROADMAP.md                  deferred work
```

---

## 7. Running it locally

Requires Node.js 20 or later (Vercel runs 24).

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev                        # http://localhost:3000
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key. Every stage uses it. |
| `ANTHROPIC_WORKSPACE_ID` | Needed only if the key is organization-scoped. Must be the `wrkspc_` id, not the organization UUID. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access for storing uploads and findings. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk authentication. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-in` and `/sign-up`. |

### Commands

| Command | What it does |
| --- | --- |
| `npm run review <file.pdf>` | Run a full review from the terminal. Flags: `--no-vision`, `--no-verify`, `--out report.md`. |
| `npm run clause 9.8.8.3` | Print a clause from the store. |
| `npm run code:build` | Rebuild `data/code-store.json` from `data/NBCAE-2023.pdf`. Only needed for a new edition or printing. Commit the result. |
| `npm test` | Rule engine tests plus a check that every rule's clauses exist in the store. |
| `npm run test:verifier` | Probe the S4 verifier. |

### Database

Migrations live in `supabase/migrations/` and are applied with
`supabase db push`. The app uses the `plans`, `plan_sheets` and `findings`
tables and the `plans` storage bucket. If the `findings` table is missing, the
route logs a warning and still returns findings to the browser.

---

## 8. Deploying

Vercel deploys `main` to production automatically
(https://planq-app.vercel.app). Pull requests get preview deployments.

Things that have broken deploys before, so they are set up deliberately:

- **Reviews are workflows, not requests.** No review has to fit in one
  function's time limit; each step does. `next.config.js` is wrapped in
  `withWorkflow`, and the middleware matcher excludes `/.well-known/workflow/`,
  which the workflow runtime calls internally.
- **Uploads go straight to storage.** Vercel caps a request body at 4.5 MB, so
  the browser uploads to Supabase Storage with a signed URL from
  `/api/analyze/upload`.
- **Database reads are never cached.** Next.js 14 caches `fetch()` in route
  handlers, and supabase-js reads through it; the status route served a stale
  "S1" for a finished review until `lib/supabase.ts` forced `no-store`.
- **Files read at runtime must be bundled.** `next.config.js` lists them under
  `outputFileTracingIncludes`, for both `/api/analyze` and the workflow route
  `/.well-known/workflow/v1/flow`, where every step runs: the pdfjs worker, `data/code-store.json`,
  `@napi-rs/canvas` (which pdfjs needs on a server and loads in a way the
  bundler cannot see), and pdfjs's `standard_fonts` and `cmaps`. Without the
  fonts, a CAD export that does not embed Arial renders with every dimension
  blank and the vision pass silently reads nothing; `renderSheet` now refuses
  to run if they are missing. If a review fails on Vercel but works locally, a missing
  file here is the first thing to check.
- **The clause store is committed.** The rest of `data/` is gitignored, but
  `data/code-store.json` is tracked because there is no code PDF on Vercel to
  rebuild it from.
- **Environment variables** must exist in all three Vercel environments
  (Production, Preview, Development). `NEXT_PUBLIC_*` values are baked in at
  build time, so add them before the build, not after.

Runtime logs: Vercel dashboard, or `vercel logs`. The Hobby plan keeps them for
one hour.

---

## 9. Cost

Every model call is logged with its tokens and dollar cost (G10), and a run stops
if it goes over budget (G11). Budgets are in `lib/claude.ts`.

| Run | Measured | Budget |
| --- | --- | --- |
| 2-sheet house | about $0.44 in 5 model calls | $1.50 |
| 25-sheet permit set | not yet measured | $12 |

Prices used (per million tokens, input / output): Haiku 4.5 $1 / $5, Sonnet 5
$2 / $10, Opus 5 $5 / $25. Prompt caching is on for system prompts. Check
Anthropic's pricing page before quoting clients.

---

## 10. Known limits

- **Nothing displays Fail yet.** Every rule's precision is unmeasured, so G8
  caps findings at Needs confirmation until the golden set exists.
- **Tested on very few drawing sets.** One has a text layer and uses Spanish
  notation; the other is a scan. Expect new edge cases with each new set.
- **No reviewer sign-off screen yet.** Reports cannot be marked released from
  the app.
- **Evidence crops** (images of the drawing region behind each finding) are not
  produced yet.
- **The three door-width rules** report each door three times when the room type
  is unclear.
- **Part 3, NECB, DWG and IFC** are not supported yet. See `ROADMAP.md`.
