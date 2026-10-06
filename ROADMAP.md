# Planq roadmap

Deferred work, with enough context to pick each item up cold. `PLANQ_SPEC.md` is
the contract; this file is what is not built yet and why.

## Where learning stands today

Planq adapts **within** a run and forgets everything between runs.

What it already does, per run:

- **Reads each sheet's own legend** (`lib/intake/legend.ts`) to learn what that
  set's notation means, so `N.P.T. = GROUND LEVEL` is learned from the drawing
  rather than hardcoded. A set that writes `T/O SLAB` or `F.F.E.` is read the
  same way, if its legend declares it.
- **Separates declared from assumed.** A convention the sheet did not declare is
  recorded as assumed and printed in the report under "Notation assumed rather
  than read", so a reviewer knows which findings rest on a guess.
- **Asks the vision pass for notation-agnostic readings.** S2 is told what kind
  of fact each rule needs, not what the notation looks like, and the legend is
  passed as a hint rather than a filter.

What it does **not** do:

- Remember anything from a previous set. Two reviews of drawings from the same
  firm learn the same legend twice and benefit nothing from the first.
- Improve from reviewer corrections. `Finding.reviewer_state` already records
  `confirmed` or `dismissed` per finding, and that is thrown away.
- Measure its own precision. Every rule still carries `precision: null`, so §G8
  caps the whole tool at `needs_confirmation`; it cannot report a failure.

## Self-learning, in the order the pieces unlock each other

The reviewer queue is the key: §G9 already makes a human mark every finding
confirmed or dismissed, which is labelled training data generated as a
by-product of the work. Nothing below needs a model to be trained; it is all
accumulation plus measurement.

1. **Persist reviewer decisions.** Store every `reviewer_state` against the
   finding, the rule, the fact it rested on and the drawing conventions in play.
   This is the dataset everything else reads, and it costs nothing to start
   collecting now. Without it, items 2 to 5 have no input.
2. **Measure precision per rule and fill the §G8 gate.** Precision is confirmed
   over (confirmed plus dismissed) per rule. Once a rule clears 95 percent it
   may display `fail`, which is what turns Planq from a tool that always says
   "needs confirmation" into one that says "this is wrong". This is the single
   highest-value item in this file.
3. **A learned notation dictionary.** Accumulate the legend entries read across
   every set, keyed by token, with how often each meaning was confirmed. A new
   set with no legend then starts from what other sets declared instead of from
   the hardcoded `ASSUMED_LEVEL_TOKENS` list. Keep per-source provenance so a
   firm's house style can outrank the global prior.
4. **Dismissal patterns become rules.** When reviewers dismiss the same finding
   shape repeatedly, that is a missing applicability condition, not noise. The
   door-width rules are the live example: they fired on bathroom doors until an
   `applies_when` predicate was added. Surfacing "this rule is dismissed 80
   percent of the time when X" turns reviewer effort into rule improvements.
5. **Few-shot the extractor from confirmed reads.** Once there are confirmed
   fact readings with their crops, the highest-value ones can be shown to S2 as
   examples. Worth doing only after 2 and 3, since it is the easiest way to
   overfit to whatever sets happen to be in the pile.

Each step is useful alone and none requires the next.

## Known overfitting risk

We have **one** drawing set with a text layer, and it is not an Alberta set. It
labels doors `PUERTA` / `P2` and levels `N.P.T.` / `N.L.T.`, which are Spanish
conventions. The second set we have is a scan with no text layer at all and
yields zero native facts.

So: the native reader in `lib/intake/native-facts.ts` is a fast path for sets
that happen to have a text layer, the vision pass is the real path, and the
hardcoded fallback vocabulary is a stopgap that item 3 above replaces. Four
overfitting defects have already been found and fixed by testing against a
second set; expect more with every new set.

## Known report-quality issue

The three door-width rules (810 mm at a required entrance or stair, 760 mm for
other rooms, 610 mm for bathrooms and closets) are all the same clause,
Table 9.5.5.1., split by what the door serves. Until the vision pass resolves
which threshold applies to a given door, every door is reported against all
three, so one door produces three "Can't determine" rows that say almost the
same thing. On the Chesnut set that is 18 rows where 6 would do.

The fix is to group rules that share a clause and a fact kind into one finding
carrying the candidate thresholds, rather than one finding per candidate. That
is a change to how `evaluate()` emits findings, not to the rules themselves.

## Other deferred work

- **The §9 golden set.** 30 to 50 real Alberta permit sets with municipal
  comment letters. This gates item 2 above and therefore gates the product being
  able to report a failure at all. Worth more than any further code.
- **IFC geometry extraction.** The owner put IFC in scope and chose to measure
  its geometry directly. `Fact` already carries an `ifc_geometry` provenance
  with an entity path in place of a bounding box; nothing reads an IFC file yet.
  `web-ifc` is the intended library.
- **DWG.** Explicitly deferred. There is no pure-JS DWG reader, so it needs a
  converter (ODA File Converter in a container was the preferred option).
- **The reviewer queue UI and §G9 sign-off.** `buildReport` already refuses to
  mark a report released without a named reviewer, and `scripts/review.ts`
  always passes `signOff: null`. There is no interface to approve anything.
- **The Finding-shaped app UI.** `app/page.tsx` still renders the old
  three-level severity model. The five-way status, clause quotes, evidence crops
  and reviewer controls are not in the app.
- **Evidence crops.** `Finding.evidence_crops` is always empty. The tiles and
  bounding boxes needed to cut them already exist in `lib/intake/render.ts`.
- **Part 3 and NECB.** S1 already selects them; no rules exist behind that
  selection, so a non-house building produces nothing.
- **Batch API and prompt-cache tuning.** §10 wants both. Caching is wired on the
  system prompt; a 2-sheet house currently runs about $0.44 against a $1.50
  budget, so there is headroom and no pressure yet.
- **Re-derive the §10 cost ceilings.** They assume Opus 5 at $4/$20 per MTok
  when it lists at $5/$25.
