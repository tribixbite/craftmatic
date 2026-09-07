# PDF reconstruction audit — September 7, 2026

The deterministic PDF-only assembler is **not production accurate**. No new
reconstruction from this audit qualifies for the user's >95% threshold. Do not
launch the proposed 13.4-day VLM batch: runtime VLM reconstruction is outside
the requested architecture and would scale a demonstrably defective assembler.

The production contract is: official PDF(s) as the only set-specific input;
universal part geometry, element/color catalogs and deterministic OCR are
reusable dependencies. VLM may assist development and independent verification,
but may not supply runtime extraction or placement. Ground-truth models and
set inventories are evaluation inputs only. Uncertainty must remain explicit.

## Corpus and site visibility

The saved production index, generated September 5, has SHA-256
`47d390627bd515b5fe1496156181aaba54392a83b7bb85b0c4d769bc33906e9a`.
`output/pdf-recon-audit/coverage.json` records the complete set lists.

| Question | Audited answer |
| --- | ---: |
| Indexed base set numbers | 10,092 |
| Sets with reconstruction as **every** indexed model source | **2,355** |
| Those with an official PDF available locally | 2,355 |
| Sets whose default model is reconstruction | 2,356 |
| V8 experiment files / distinct set numbers locally | 107 / 26 |
| Current reconstruction-only sets with any V8 experiment | **9** |
| V8 models indexed live | **2** |
| Newly verified >95% PDF-only, zero-VLM models from this audit | **0** |

These counts describe indexed base sets, not every LEGO set ever issued, and
not catalog variants or every set awaiting its first model. One set defaults
to reconstruction despite another indexed source; default and only-source
counts are intentionally different. The historical 1,006-item repair cohort
also contained 181 staged DBIX conversions and has since changed; it is not a
current PDF-only denominator.

The nine V8 experiment sets are 10992, 3851, 41677, 42010, 60135, 70200, 7581,
76076 and 910058. The two indexed V8 models are 42010 and 76076. Existing V8
output uses VLM; the engine name is not evidence of deterministic provenance
or >95% accuracy.

The website previously capped search at 2,000 entries **before** applying
source and piece filters. This hid most reconstruction results. Its source
filter also omitted V8. The fix filters the complete matching catalog and
still renders only 48 cards per page. Catalog entries can include variants,
so the displayed count need not equal the 2,355 unique only-source base sets.
Site change: `f08198a`; deployment workflow run `34100477290`.
Pages and Worker deployment succeeded. Production Chrome verification reports
**2,639 catalog entries**, 48 visible cards and 2,591 remaining. All eight
production smoke tests pass; the live model index is byte-identical to the
pre-deployment snapshot. The engine repairs are committed locally in clego as
`10f695ef`; they are not a deployed accurate reconstruction service.

## What the prior accuracy claims actually establish

The reported **95.4%** concerns deterministic extraction attempt coverage
under era/fallback gates. It is neither full-model accuracy nor proof of
equivalence for 95.4% of sets. The old automatic path still escalates to VLM.

The quoted **40–52% identity coverage** uses loose position matching: roughly
two studs horizontally and two bricks vertically after coordinate rounding.
It does not require correct orientation; color is not intrinsic to that
headline metric. Inventory conservation often starts from a supplied `.io`
inventory. Neither establishes nearly perfect PDF part recognition.

A new independent diagnostic matches resolved part ID **and color**, requires
one-to-one matches, position within 1 LDU per axis, and rotation matrix entries
within 0.0001, under a proper global rigid transform. It does not allow mirrors.

| Fixture/output | Strict full-pose matches |
| --- | ---: |
| Authentic OMR 41624 scored against itself | 109/109 (100%) |
| Existing VLM V8 41624 | 2/109 (1.83%) |
| Existing VLM V8 40377 | 1/90 (1.11%) |
| Historical and latest sampled 3931 outputs | 2/46 (4.35%) |
| PDF-only icon/template experiment 41624 | 2/109 (1.83%) |
| PDF-only icon/template experiment 40377 | 2/90 (2.22%) |
| Native PDF-only contact pipeline 41624 | 2/109 (1.83%) |

These are diagnostic fixtures, **not a representative population estimate**.
The scorer is conservative: it does not quotient equivalent part symmetries
and examines the top 128 voted alignment hypotheses. It is not a universal
physical-equivalence certificate. However, actual browser renders independently
show the reconstructed examples as piles beside a clean reference model.
The failure cannot plausibly be explained solely by symmetric part rotations.

The native run emits 99 parts for a 109-part reference, but its exact part/color
multiset covers only 83/109 reference parts (76.15%). Native PDF BOM labels
account for 109/109 and 90/90 quantities on 41624 and 40377; translating those
labels into exact reusable LDraw geometry remains ambiguous for 9 and 1 pieces,
respectively. Reading a printed element number is a different task from
assigning the correct part to a step or solving its pose.

The standing 92-crop PLI benchmark also has corrupted provenance: three labels
contain a tuple in the part field from a destructuring bug, and six use
noncanonical inline part identifiers. Some inspected auto-labels do not match
their crops. A diagnostic excluding the nine schema-invalid labels scored
9/83 for PDF icon matching; this is not a reliable hand-verified benchmark.
Do not silently repair those labels from the same predictions being tested,
or describe the old score as an established information-theoretic floor.

## Implemented pipeline repairs

The actual pipeline repository is `C:/git/clego`. Changes are made there;
Craftmatic retains reproducible diagnostics in `scripts/pdf-recon/`.

- Added `recon_extract.pdf_pipeline`: explicit PDF input, PDF-derived inventory,
  no `.io`/set-inventory fallback, runtime VLM entry points forbidden, hashed
  PDF/catalog/code provenance, approximate output, and unresolved evidence.
  No legal mate means unresolved, rather than inventing a stacked placement.
- Added PDF element inventory extraction with duplicate text-paint suppression,
  spatial quantity pairing, explicit color/part namespaces and ambiguous mapping
  rejection. Universal Studio/Rebrickable bridges preserve uncertainty rather
  than guessing a print, mold or color alias.
- Stopped treating printed BOM pages as build instructions. Partial PLI recall
  is now explicitly unresolved even if another item on the page matched.
- Included vector-only and first-page drawing candidates. They are candidates,
  not certified steps. PDF-only style selection samples quantity-bearing PLI
  across the booklet; it no longer lets cover colors decide the booklet style.
- Invalidated PDF-selection and rendered-page/crop caches by input content,
  page selection and render configuration. A different PDF cannot silently
  reuse another booklet's page-number cache.
- Fixed the benchmark singleton destructuring path; ambiguous quantity evidence
  cannot create an automatic truth label. Scoring/finalization now reject
  invalid existing labels rather than reporting an accuracy number from them.
  Original fixture labels remain untouched pending independent relabeling.
- Added conservative pose scoring and regression checks for false matches,
  duplicate placements, mirrors, source protection, cache changes, inventory
  ambiguity and malformed/nonfinite publication evidence.
- Tightened publication: every current source must be reconstruction-only;
  missing pairwise verification fails; candidate bytes must match strict >95%
  coverage **and** precision evidence, zero runtime VLM calls, PDF provenance,
  and no unresolved evidence. Tagged allow-list paths now identify/hash the
  exact file instead of indexing a stale untagged model.
- Disabled automatic reconstruction upload. The existing unconditional R2
  writer cannot make a GET/recheck/PUT sequence atomic. Immutable model keys and
  conditional index publication are prerequisites for re-enabling it. A scoped
  merge and upload readback alone cannot prevent a concurrent writer race.

The proof file is a local evidence contract, not a cryptographic attestation of
accuracy. No pipeline in this audit writes a passing proof automatically.
No production model, allow-list or R2 index was changed by these experiments.

## Verification and practical ceiling

Both application typechecks pass, including an isolated tracked checkout.
The full app suite passed: 65 test files passed, one skipped; 1,140 tests passed,
21 skipped. The production web build passed. Native regression tests: five
pose tests and eight pipeline tests passed. Read-only publication audit:
**0 of 10 pilot candidates qualify**.

Two native PDF-only contact runs on official `6248865.pdf` produced identical
99-part model bytes:
`5a0e11003bfa7500588b20a9a9deda45682341f1851c16aef0f4383e8c2a32c6`.
They made zero runtime VLM calls. Repeatability is demonstrated for this fixture,
not for every platform/catalog/library version. Geometry-library provenance
is not yet fully hashed, and manifests deliberately remain uncertified.

The remaining ceiling is structural, not a temperature/seed adjustment:
the engine pools a page's additions, assumes the main assembly, and has no
validated subassembly/multiplier/combination graph or reliable joint camera and
pose solver. Its image matching and local connector ranking do not recover the
assembly shown by the PDF. Contact and template ranking, external-inventory
controls, corrected PDF inventories, and PDF icon references did not approach
95%. No-PLI/scanned inventory handling, mixed page roles, flexible assemblies,
missing geometry and multi-booklet composition remain incomplete.

I have not solved that perception/assembly problem in this audit and cannot
honestly publish these outputs as accurate. Further progress needs a new,
independently validated deterministic step/subassembly and camera solver, not a
larger batch of this engine. Literal unique 100% recovery is also impossible
when a PDF omits the visual evidence distinguishing two valid hidden parts or
mold variants; such cases must remain unresolved or use an agreed equivalence.

## Open decisions

1. Does “100% accurate” require exact mold/print/orientation identity, or may
   physically and visually equivalent symmetric/mold variants count as equal?
   Current diagnostics use exact identifiers and conservative frames.
2. For a genuinely ambiguous or incomplete PDF, should the product expose an
   explicitly unresolved partial result or withhold the reconstructed model?
   Current publication behavior withholds it.
3. Should existing approximate reconstruction models stay visible with their
   current source labels, or should the UI distinguish verified/approximate
   quality explicitly? Existing models have been preserved.

None of these questions authorizes runtime VLM, set-inventory leakage, or
replacement of better-source models. The requested deterministic architecture
and source-protection requirement remain fixed.

## Instructions and evidence trail

Reviewed the repo `CLAUDE.md`, `ROADMAP.md`, Claude-specific project skills,
Craftmatic and clego Claude memories, and the reconstruction specifications,
results/verdict/playbook files. User-scoped `C:/Users/wills/.claude/CLAUDE.md`
exists but is empty. No clego `CLAUDE.md` was present. Applied the reconstruction
benchmark and visual/deployment QA practices where relevant; older VLM batch
instructions are superseded by the user's explicit zero-runtime-VLM request.
Protected historical benchmark implementation files were not edited.

Local evidence is preserved under `output/pdf-recon-audit/`: `coverage.json`,
`poses.json`, `pose-positive-control.json`, `icon-bench/quarantined-labels.json`,
`native-41624-b/{manifest,journal,inventory,pose}.json`, `native-repeat.json`,
`publish-decide.log`, test/build logs and browser renders. Upstream originals
and the exact staged-file hash manifest are preserved alongside them.
