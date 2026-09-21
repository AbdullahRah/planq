# Verifying model-authored findings

Planq produces findings from two sources. The deterministic rule engine
(`lib/rule-engine/`) compares extracted measurements against the `code_rules`
table — arithmetic, with a citation that came from the rule row itself. The LLM
compliance pass (`lib/analyze.ts`) reads retrieved code text and writes findings
in prose, and those are the ones that can be wrong in ways that still look right.

This document covers the two stages that constrain them, both built on
TypeSafe's **Jev** System One model:

1. **Part resolution** (`lib/occupancy-resolve.ts`) settles which NBC Part
   governs the sheet, when the sheet's own text does not.
2. **Reranking** (`lib/rerank.ts`) narrows what reaches the prompt, which
   narrows what the model is permitted to cite.
3. **The verification gate** (`lib/verify.ts`) checks each surviving finding
   against the text of the section it cites.

None of the three can author a finding. They only constrain which rules apply,
which passages are visible, and which findings survive.

## The hole this closes

`compliancePass` already refuses citations whose section number never appeared
in the retrieved context. That catches numbers invented from memory. It cannot
catch a *misapplied* number, because the check is string matching:

> The main stair width is 700 mm, which is less than the required minimum of
> **900 mm** for stairs serving residential occupancies. — §9.8.2.1

`9.8.2.1` is a real section, it was in the retrieved text, and the allowlist
passes it. But 9.8.2.1 sets **860 mm**, not 900 mm. The finding's observation is
right, its authority is real, and its stated requirement is wrong — and nothing
in a string match can tell.

A citation that is *present* is not a citation that *supports*.

## What the gate does

For each model-authored finding, `lib/verify.ts` pulls the text of the section
actually cited and asks Jev two independent judgments over one state:

| Question | Type | What it decides |
|---|---|---|
| `relation` | Choice | Does the cited code text **support**, **contradict**, or **say nothing about** the requirement the finding asserts? |
| `grounded` | Noul | Is the element, with the measurement the finding reports, actually present in the extracted plan data? |

The two legs map onto the two ways a finding fails. `relation` catches "the code
does not say that". `grounded` catches "the plan does not show that" — a finding
written against a thinly-extracted sheet.

Both travel in one request, so they run in parallel and cost one round trip.

## From judgment to decision

`judgeFinding` returns the raw answer; `applyPolicy` decides. They are separate
so thresholds can be retuned and re-reviewed without re-running inference.

| Condition | Verdict | Action |
|---|---|---|
| `grounded` < 0.2 | `ungrounded` | **drop** — the plan does not contain this |
| `contradicts`, confidence ≥ 0.8 | `contradicted` | **drop** — the section says otherwise |
| `says_nothing`, confidence ≥ 0.8 | `unsupported` | **strip the citation**, keep the observation |
| `supports`, confidence ≥ 0.8, grounded ≥ 0.5 | `verified` | keep |
| anything less confident | `needs_review` | keep, flagged for a human |
| verification unavailable | `unchecked` | keep, and say why |

Three properties hold by construction:

1. **The gate can only remove or downgrade.** It never authors a finding, so
   turning it on cannot introduce a false positive.
2. **Nothing is dropped silently.** Every removal becomes a `warnings` entry on
   the analysis response, so "no violations" is always distinguishable from
   "the checks threw everything away".
3. **Deterministic findings never enter the gate.** Rule-engine output is
   arithmetic against a rules table; letting a probabilistic judgment veto it
   would trade a defensible result for a less defensible one.

An outage is not a verdict: if the API call fails, the finding survives marked
`unchecked` with the error attached.

## Narrowing retrieval first

The gate above is the second of two stages. The first is reranking, in
`lib/rerank.ts`.

`lib/retrieve.ts` is fast search — pgvector similarity, with a keyword
fallback. It produces a plausible shortlist and orders it badly, and in this
corpus that gap is expensive: because the chunker mislabels chunks,
`harvestAllowedSections` builds the citation allowlist out of chunk *bodies*, so
**every irrelevant chunk in the prompt widens the set of section numbers the
model is permitted to cite**.

So each retrieved chunk is scored on its own with a Noul — *does this passage
state a requirement that governs what we asked about?* — and only the best few
per category survive. Scoring one query-candidate pair at a time keeps the
scores comparable, as TypeSafe's reranking cookbook prescribes.

Chunk labels are deliberately **not** shown to the model. They are unreliable
here, and including them would let a wrong label vouch for the body.

```bash
npm run test:rerank     # cutoff, ordering, fallbacks — no network
npm run rerank:eval     # against the live corpus
```

Last `rerank:eval` run, all five compliance categories:

| | before | after |
|---|---|---|
| chunks in prompt | 40 | 17 |
| **permitted citations** | **289** | **135** (53% smaller) |

with all four gold sections surviving — the corridor-width 1 100 mm rule, stair
headroom 1 950 mm, the 810 mm doorway width, and the travel-distance limits.
There is no gold marker for `occupancy`: the only chunks in this corpus
mentioning "major occupancy" are 9.36 energy-efficiency text, so there is
nothing correct for that category to retrieve. Reranking drops those, which is
right, but it is a retrieval/corpus problem rather than something the reranker
can fix.

Reranking, like the gate, can only remove candidates. With no key the shortlist
passes through in fast-search order, and if every score fails it falls back to
that order rather than returning an empty prompt.

## Resolving which Part applies

The Part that governs a sheet is the most load-bearing single fact in an
analysis: it decides which rules the deterministic engine applies and which
sections may be cited. `lib/rule-engine/occupancy.ts` resolves it with a regex
over the sheet's stated occupancy and building type, and returns `undefined`
whenever that text is absent or ambiguous — which on real drawings is often.

`undefined` is not harmless. The engine responds by skipping Part conditions,
so Part 9 housing limits get evaluated against every sheet, and the LLM pass is
told the occupancy is unspecified and retrieves across both Parts.

`lib/occupancy-resolve.ts` asks Jev when, and only when, the regex is silent.
Three constraints:

- **the regex always wins** when it produced an answer; this never overrides it
- **`unclear` is an available answer**, so the model is never forced to guess
- **the confidence bar is the highest in the pipeline** (`occupancyAutoAccept`,
  0.85) because a wrong Part is a broad, quiet failure rather than one bad
  finding

Below the bar the Part stays unknown and the engine behaves exactly as it does
today. An inferred Part always produces a `warnings` line naming the model and
its confidence, so it is never invisible in a report.

```bash
npm run occupancy:eval
```

Last run: **no unsupported Part asserted**, 5/6 hand-labelled cases matched.
Both safety cases refused correctly — a sheet with bedroom names but no stated
storeys or area returns unknown rather than assuming housing, and so does an
empty sheet. The sixth is a conservative miss: a Part 9 sheet whose notes place
a gross-floor-area figure next to the building area came back Part 9 at 0.81,
under the bar, and fell back to unknown. The threshold was left where it is
rather than lowered to make the case pass.

## What this does not verify

**The gate checks the requirement, not the section number.**

A real example from the pipeline. The model reported a 1.9 m ceiling against a
2.1 m minimum and cited §9.5.5.1. The gate read the text
`codeTextForSection` returns for 9.5.5.1 and answered `supports` at high
confidence — correctly, because that text contains *Table 9.5.3.1 Room Ceiling
Heights*, which really does require 2.1 m for a living room.

But that table belongs to **9.5.3.1**. It matched 9.5.5.1 only because the
string `Division B9.5.5.1.` appears in the chunk body as a page-header artifact.
The requirement is real, the violation is real, and the citation is off by a
section.

This is a corpus problem, and it is the ceiling on how defensible the LLM path
can get. Tightening `codeTextForSection` to trust labels would make it worse,
not better — mislabelled chunks are the norm here, which is why body matching
exists at all. The fix is upstream, in the chunker: `section_id` needs to be
correct, and `section_title` values like `". for ramps.)"` and `".2."` show how
far from correct they currently are.

Two things limit the damage in the meantime. The deterministic rule engine
carries citations from the `code_rules` table rather than from retrieval, so
its section numbers are exact. And `coveredSections` removes LLM findings for
any section the rule engine already covered — which is why, on a sheet where
both fire, the deterministic finding is the one that survives.

## Thresholds

Every threshold lives in `THRESHOLDS` in `lib/typesafe.ts`, next to the
questions themselves, so the model's entire influence on results — both stages —
is auditable in one file: `retrievalFloor` and `retrievalKeep` for reranking,
`citationAutoAccept`, `groundedAccept` and `groundedFloor` for the gate. `0.8` follows TypeSafe's citation-check cookbook, which recommends
starting high and lowering it as trust builds on your own data. Planq has not
measured its own corpus yet, so it stays at the cookbook default.

## Evidence

```bash
npm run test:verify      # gate policy, scripted judgements — no network
npm run test:rerank      # rerank cutoff/ordering/fallbacks — no network
npm run verify:eval      # the gate's judgements, against the live API
npm run rerank:eval      # reranking, against the live corpus
npm run occupancy:eval   # Part resolution, against hand-labelled sheets
```

**The model is never asked to grade its own output.** Every evaluation above
scores against hand-written ground truth — verified requirement text from the
corpus, or Part limits read off Part 9's own scope. Using Jev to judge whether
Jev was right would make these numbers circular and worth less than they look.

`scripts/verify-eval.ts` runs eight findings against the real NBC Alberta 2019
corpus in `building_code_chunks`: three sound, five planted to fail in a
specific way. It scores the two properties that matter — no sound finding
deleted, no planted finding passed — and prints every probability so a
disagreement is visible rather than averaged away.

Last run: **8/8 verdicts matched, no sound finding deleted, no planted finding
passed, 1.3 s** for eight findings on `jev-1.13.0`.

The planted cases are worth reading as a description of the failure modes:
an inflated limit cited to a section stating a different one; a real door
observation citing the corridor-width section; a fire-separation claim on a plan
carrying no fire-separation data; findings about a stair and a bedroom that are
not on the sheet at all.

## Reading a result

Each finding carries a `verification` block through the API and into the
`violations.verification` column, and the UI badges it:

- **measured** — deterministic, from the rule engine
- **verified 94%** — checked against the cited section's text
- **citation unverified** — observation kept, citation removed
- **needs review** — the model would not stand behind its own verdict alone

## Configuration

```bash
# .env.local  (gitignored — never commit a real key)
TYPESAFE_API_KEY=apikey_...      # https://console.typesafe.ai/keys
TYPESAFE_MODEL=jev-latest        # pin e.g. jev-1.13 to freeze behaviour
TYPESAFE_VERIFY=                 # "off" disables the gate explicitly
```

The gate is on whenever a key is present. With no key, `compliancePass` behaves
exactly as it did before and every finding comes back without a `verification`
block.

## Cost

Jev is priced per token like an LLM but answers with a probability rather than
prose, so a judgment is a few hundred input tokens and ~20 output tokens. The
eight-finding evaluation above completed in 1.3 s. Verification scales with the
number of *model-authored* findings, not with sheets or pages, and findings the
rule engine already covered are dropped before a call is spent on them.

## Where to take it next

- **Fix the chunker.** This is now the largest source of residual error; see
  *What this does not verify* above. Correct `section_id` values would make the
  body-harvesting allowlist unnecessary and let a citation be checked as a
  citation rather than as a requirement.
- **Tune the threshold.** Collect reviewer decisions on `needs_review` findings,
  then move `citationAutoAccept` on evidence rather than on the cookbook default.
