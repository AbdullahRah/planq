# Planq: Claude API Rebuild Spec

Handoff brief for Claude Code. Put this file at the repo root, read it end to end, then implement in the order given under "Build order". Where this spec conflicts with existing code, this spec wins. Do not over-engineer: reuse what already works (auth, storage, UI, upload flow) and replace only the analysis core.

Writing rule for all generated copy, reports and docs: no em dashes. Product name is "Planq" (no accent on the q).

## 1. Goal

Planq reviews residential and small-building drawing sets against the Alberta codes in force and returns findings that a builder or designer can trust enough to act on before permit submission. Each finding must be grounded in a quoted clause and a located spot on the drawings, with a status of Fail, Needs confirmation, Drawing conflict, Can't determine, or Pass.

Planq is a pre-submission review aid. It is not a permit approval. A qualified human signs off before any report is released to a client.

## 2. Decisions already made (do not revisit)

1. Replace the embedding-retrieval core (Qdrant, voyage-law-2, Cohere rerank) with a structured clause store plus a rules engine. Retrieval may stay only as a fallback for "find me related clauses", never as the source of a compliance verdict. Keep the old code behind a feature flag until the benchmark in section 9 passes, then remove it.
2. Use the Claude API for reading drawings, extracting facts, judging non-numeric rules and verifying findings. Numeric comparisons are done in code, never by the model.
3. Model routing: `claude-haiku-4-5-20251001` for applicability and cheap classification, `claude-sonnet-5-5` for extraction, rule checks and report assembly, `claude-opus-5-5` for the independent verifier. Keep model ids in one config file.
4. Jurisdiction for v1 is Alberta only, edition NBC(AE) 2023 (in force from 1 May 2024), second printing including the April 2026 revisions and errata.
5. A finding is only "Fail" when all three hold: a sourced fact exists, the clause conditions are met in code, and the numeric or logical test fails in code. Missing information produces "Can't determine", never "Pass" or "Fail".

## 3. Code documents

| Document | Use | Source |
| --- | --- | --- |
| NBC(AE) 2023, one PDF containing Volume 1 and Volume 2 (1,578 pages, includes Part 9) | Governs houses and small buildings (Part 9) and larger buildings (Parts 3 to 8) | https://nrc-publications.canada.ca/eng/view/ft/?id=0316d953-0d55-4311-af69-cad55efec499&dp=2&dsl=en |
| NECB 2020 (second printing) | Energy for buildings that are NOT regulated by Part 9. Not applicable to houses. Energy for houses is NBC(AE) Section 9.36, Tier 1 minimum | https://nrc-publications.canada.ca/eng/view/ft/?id=af36747e-3eee-4024-a1b4-73833555c7fa&dp=2&dsl=en |

Applicability: Division A 1.3.3.3.(1) applies Part 9 to residential buildings of 3 storeys or less in building height and not more than 600 m2 in building area. NECB 1.1.1.1.(1) limits NECB to buildings described in Division A 1.3.3.2.(1), which are Part 3 buildings. A house is checked against Part 9 and Section 9.36, not NECB.

Known pitfall from prototyping: the first attempt read a truncated slice of the PDF and wrongly concluded Part 9 was missing. Guardrail G1 exists to make that impossible.

## 4. Architecture

```
upload -> [S0 intake] -> [S1 applicability] -> [S2 extraction] -> [S3 rule engine]
       -> [S4 adversarial verify] -> [S5 report] -> human sign-off -> release
```

Every stage reads and writes typed JSON validated with a schema (zod in TypeScript). A failed validation retries once with the validation error appended, then the run stops as `needs_manual_review`.

### S0 Intake
- Accept PDF, and optionally DWG/IFC later (out of scope for v1).
- Rasterize each sheet. Keep the native text layer if present. For large sheets, create overlapping tiles (about 4 per sheet) at a resolution where dimension text is legible, plus one whole-sheet thumbnail for context.
- Produce a sheet inventory: sheet number, title, scale statement ("not to scale" is flagged), units, sheet size.
- Warn if the title block says educational or personal use only, since that is a licensing issue for client demos.

### S1 Applicability (Haiku)
Inputs: sheet inventory, area schedule, storey count, occupancy hints. Output `applicability.json`: major occupancy, storeys, building area, selected code Part(s), edition, whether Section 9.36 or NECB governs energy, plus a confidence value and the clause that justifies each choice. Low confidence or conflicting inputs stop the run and ask a human.

### S2 Fact extraction (Sonnet, vision)
Output a list of `Fact` records (schema below). Rules:
- Only use dimension strings, level marks, tags and schedules printed on the sheets. Never measure from pixels.
- Every fact must include the sheet, the region (bounding box in tile coordinates), and the verbatim text it came from.
- Run extraction twice with different tile orders. Facts present in only one run, or with different values, are flagged `unstable` and cannot support a Fail.
- Extract negative evidence explicitly: for each rule the engine will run, record `searched_for` and `not_found` so "not shown on the drawings" is a recorded fact.

### S3 Rule engine
A rule is data plus a small evaluator, not a prompt. See section 6. For each rule: check applicability conditions in code, gather the needed facts, evaluate numeric tests in code, and call Sonnet only for judgment rules that cannot be reduced to numbers (for example "is this assembly described sufficiently"). The model returns structured output only: `{rule_id, supported_by_fact_ids[], judgment, reasoning}`. Reasoning text is for the reviewer and is never used in the verdict.

### S4 Adversarial verifier (Opus)
Input per proposed Fail or Needs confirmation: the finding, the quoted clause text, the cropped drawing evidence, and an instruction to try to refute it (for example "is there another element on the drawings that satisfies this?"). Output: `upheld | refuted | uncertain` with a reason. `refuted` or `uncertain` downgrades the status one level and routes it to the reviewer queue. Run verification with a different prompt from S3.

### S5 Report
Generate the client report from the findings table (section 8). Include cropped evidence images, the quoted clause, the computed values and the drawing reference. The report generator may not introduce any claim that is not in a finding record.

## 5. Data model

### Code store (built once per edition, versioned)
Parse the NBC(AE) PDF into clause records. Use `pdftotext` in both raw and `-layout` modes; tables (for example Tables 9.5.5.1, 9.8.4.1, 9.8.4.2, 9.5.3.1) parse best from `-layout`.

```ts
type ClauseRecord = {
  id: string;            // "9.8.8.3.(1)"
  article: string;       // "9.8.8.3."
  title: string;         // "Height of Guards"
  text: string;          // exact text, normalized whitespace only
  tables: TableRecord[]; // referenced tables, parsed
  notes: string[];       // referenced A- notes
  cross_refs: string[];
  pdf_page: number;
  printed_page: string;  // "9-30"
  edition: "NBC(AE) 2023";
  printing: "second, April 2026 revisions";
  sha256: string;        // hash of text
};
```

Ingestion must record and assert: PDF page count (1,578 for the current file), that every article id appears in the parsed index, and that table row counts match a human-checked manifest for the tables used by rules.

### Fact
```ts
type Fact = {
  id: string;
  kind: string;               // "guard_height_mm", "door_width_mm", "riser_count", ...
  value: number | string | boolean;
  unit?: string;
  subject: string;            // "rooftop terrace guard"
  sheet: string;              // "02"
  tile: string;
  bbox: [number, number, number, number];
  source_text: string;        // verbatim from the sheet
  run: 1 | 2;
  stable: boolean;
};
```

### Finding
```ts
type Finding = {
  id: string;                      // "F1"
  rule_id: string;
  status: "fail" | "needs_confirmation" | "drawing_conflict" | "cant_determine" | "pass";
  summary: string;
  clause_ids: string[];            // must exist in the code store
  clause_quotes: string[];         // substring-verified against the store
  fact_ids: string[];              // must exist and be stable for a fail
  computed: Record<string, number | string>;
  evidence_crops: string[];        // image paths
  required_action: string;
  verifier: "upheld" | "refuted" | "uncertain" | "not_run";
  reviewer_state: "unreviewed" | "confirmed" | "dismissed";
};
```

## 6. Rules (v1 set, transcribed from NBC(AE) 2023)

Each rule file holds: id, clause ids, applicability conditions, facts required, numeric test, and the list of status outcomes. A human must transcribe thresholds from the PDF and add unit tests that cite the page. Do not let a model write thresholds.

| Rule id | Clauses | Test | Facts needed |
| --- | --- | --- | --- |
| guard-height | 9.8.8.3.(1) to (3) | Min 1 070 mm. 900 mm applies inside dwelling units, and for exterior guards serving one dwelling unit only where the walking surface is not more than 1 800 mm above finished ground | guard height, walking surface height above grade, guard location |
| guard-openings | 9.8.8.5. | Openings stop a 100 mm sphere; stair triangles stop 150 mm | guard type and spacing if shown |
| door-widths | 9.5.5.1., Table 9.5.5.1. | 810 mm at required entrance, vestibule or entrance hall, stairs to finished floor, one line of passage to basement; 760 mm other rooms and balconies; 610 mm bathrooms and walk-in closets; height 1 980 mm | door schedule or tags with widths and locations |
| stair-risers | 9.8.4.1., Table 9.8.4.1. | Private stair rise 125 to 200 mm | storey height, riser count |
| stair-runs | 9.8.4.2., Table 9.8.4.2. | Private stair run 255 to 355 mm | tread dimensions |
| stair-consistency | none (internal) | Riser count and dimensions agree across plan and sections | riser counts per sheet |
| ceiling-height | 9.5.3.1., Table 9.5.3.1. | 2.1 m for habitable rooms, hallways and bathrooms | ceiling heights from sections |
| bedroom-egress | 9.9.10.1.(1) to (6) | Unless sprinklered, openable window of at least 0.35 m2 clear, no dimension under 380 mm; 760 mm clearance in front of a window well | window schedule per bedroom, sprinkler status |
| spatial-separation | 9.10.15.4., 9.10.15.5. | Limiting distance under 0.6 m, or 0.6 to under 1.2 m: 45 min rating and cladding rules; glazing limited per Table 9.10.15.4. | limiting distance per face, wall assembly, glazing areas |
| garage-separation | 9.10.9.18.(4), 9.10.13.15. | Air barrier between garage and dwelling; self-closing, weather-stripped door not into a sleeping room | air barrier note, door spec, door location |
| smoke-alarms | 9.10.19.1., 9.10.19.3. | On every storey, in each sleeping room, and in the hall serving sleeping rooms | alarm locations |
| co-alarms | 9.32.3.9. | Required where there is a storage garage or fuel-burning appliance | alarm locations, garage presence |
| energy-tier | Section 9.36. | Compliance path and Tier 1 data are stated | compliance path, assembly values, window performance |

Add more rules as the benchmark shows gaps. Part 3 (non-house buildings) and NECB are future work, gated behind S1 selecting them.

## 7. Guardrails (all required)

G1. Corpus completeness. Fail closed if the parsed code does not match the page count or article index. Pin edition, printing and revision date in every report.
G2. Evidence rule. A fact without sheet, region and verbatim source text is discarded.
G3. Substring citation check. Every `clause_quotes` entry must be an exact substring of the stored clause text. The model supplies article ids, the system fetches the text.
G4. Deterministic verdicts. Applicability and numeric tests run in code with unit normalization. The model never produces a Pass or Fail by arithmetic.
G5. Absence is not a result. Missing information yields `cant_determine`. "Pass" requires a positive sourced fact.
G6. Double extraction. Unstable facts cannot support a Fail and are routed to review.
G7. Independent verifier. Opus tries to refute each Fail and Needs confirmation. Anything not upheld is downgraded and queued for a human.
G8. Per-rule precision gate. Only rules whose measured precision on the benchmark is at least 95 percent may display `fail` automatically. All others display `needs_confirmation`. Store the precision per rule and the benchmark date.
G9. Human sign-off. No report is released until a named reviewer marks it approved. Record who and when.
G10. Audit trail. For every run store input file hashes, code edition and store hash, model ids, prompt versions, token usage, and every intermediate JSON.
G11. Budget and loop limits. Per-run token budget, one retry per stage, then `needs_manual_review`.
G12. Output hygiene. Reports contain no claim outside finding records, no em dashes, and carry the disclaimer text in section 8.

Example of G5 and G7 working together: the rooftop guard was flagged because Section A shows a 0.50 m parapet at the roof edge. A guard rail on top of the parapet may exist without being drawn, so the status should read "Fail, pending confirmation that no additional guard is shown" until the verifier or reviewer confirms from the sheet.

## 8. Report format

Sections: review summary with status counts; applicability determination; findings table (id, status, finding, clause, drawing reference, action); finding details (requirement, what the drawings show, fix, evidence crop); information required to complete the review (checklist); method and limits.

Disclaimer text: "This is a pre-submission review to help prepare a permit application. It is not a permit approval or a substitute for review by the authority having jurisdiction or a registered professional. Zoning, structural design, plumbing and electrical were not reviewed unless stated."

## 9. Evaluation

- Build a golden set of 30 to 50 real Alberta permit drawing sets with known deficiencies (city comment letters) plus clean sets. Store expected findings as JSON per set.
- Metrics per rule: precision, recall, false-positive rate. Overall: percent of real deficiencies caught, false flags per set, and "can't determine" rate.
- Run the full benchmark on every change to prompts, models, rules or code edition. Block merges that reduce precision on any rule below its gate.
- Release bar for first client pilots: at least 90 percent recall on the rules in section 6 where the drawings contain the needed information, and at least 95 percent precision on every rule allowed to show `fail`.

### Regression fixture: Chesnut residence (freecadfloorplans.com sample, internal testing only)
Input: `Two-story-house-with-dining-room-in-back.pdf` (2 sheets). Educational-use license, do not use in client demos. Expected results:

| Id | Status | Item |
| --- | --- | --- |
| F1 | fail (pending confirmation of no additional guard) | Rooftop guard 0.50 m vs 1 070 mm, 9.8.8.3.(1) |
| F2 | needs_confirmation | P2 doors 800 mm vs 810 mm at entrance hall or stair, Table 9.5.5.1. |
| F3 | drawing_conflict | Plan shows 16 risers, Section B shows 17 |
| F4 | cant_determine | Side walls within 0.6 m of property lines, no rating or cladding shown, 9.10.15.4., 9.10.15.5. |
| F5 | cant_determine | No bedroom window sizes, 9.9.10.1. |
| F6 | cant_determine | Garage air barrier and door spec missing, 9.10.9.18.(4), 9.10.13.15. |
| F7 | cant_determine | No smoke or CO alarms shown |
| F8 | cant_determine | No Section 9.36 data |
| F9 | pass | Ceiling height about 2.60 m vs 2.1 m |
| F10 | pass | Bedroom and bathroom doors 800 mm vs 760 mm and 610 mm |

Also assert that S1 selects Part 9 and Section 9.36 for this house and does not select NECB.

## 10. Cost targets

Estimates from assumed token counts, to be replaced by measured usage logged per run. List prices at time of writing (per million tokens, input / output): Haiku 4.5 $1 / $5, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20, cache reads about $0.20, Batch API 50 percent off. Verify against Anthropic's pricing page before quoting clients.

| Run | Estimate |
| --- | --- |
| 2-sheet house | about $0.60, budget $1.50 |
| 25-sheet permit set | about $3, budget $12 |

Use prompt caching for the system prompt, rule definitions and clause text. Use the Batch API for non-urgent runs. Log tokens and cost per stage and alert if a run exceeds its budget.

## 11. Build order

1. Code store ingestion with G1 assertions and a CLI to look up any article by id. Unit test against the clauses cited in this file.
2. Schemas (Fact, Finding, Rule) and the rules engine with transcribed thresholds and tests for all rules in section 6. No model calls yet.
3. S0 intake and sheet inventory.
4. S1 applicability and S2 extraction with double runs and negative evidence.
5. S3 wiring, S4 verifier, G3 substring check, G8 gating.
6. S5 report, reviewer queue UI and sign-off (G9), audit trail (G10).
7. Benchmark harness (section 9), run against the Chesnut fixture first, then collect the golden set.
8. Remove the old RAG verdict path behind the flag once the release bar is met.

## 12. Open questions for the owner

1. Which Alberta municipalities are first (Calgary, Edmonton, others), and do they publish checklists or common deficiency lists we should mirror?
2. Who is the named human reviewer for sign-off during the pilot?
3. Input formats beyond PDF: DWG, IFC or Revit exports?
4. Pricing model for clients (per review, per seat, or per project) so cost budgets can be set against revenue.
5. Where to host the audit trail and cropped evidence images (existing Supabase or Azure storage).
