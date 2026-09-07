# GPU matching and placement trials — September 7, 2026

The RTX 5080 Laptop GPU works with the installed PyTorch 2.7.1/cu128. A compact
trained image encoder improves **inventory-artwork retrieval**, but no tested
method demonstrates better full-model reconstruction or reliable step-callout
recognition. No production models or engine defaults changed. Runtime VLM calls:
zero. The existing local llama-server process was left running and untouched.

## Trials actually run

| Method | Result | Interpretation |
| --- | --- | --- |
| Normalized pixel similarity | 357/411 eligible held-out inventory icons correct | Strong cheap baseline on this narrow task |
| HOG edge descriptor | 333/411 | Worse than pixels |
| Trained contrastive CNN | **374/411 (91.0%)** | +17 correct over pixels; worthwhile matching signal, not assembly accuracy |
| Frozen CNN on actual unseen-set step callouts | 13/67; pixels also 13/67 | No demonstrated domain-transfer gain; labels themselves need repair |
| Exact PDF image-object reuse | Two callouts in one of 80 PDFs | Visually checked wheel/tire identities; sparse compatibility |
| Learned linear placement ranker | 2/102 held-out placements on 41624; 0/38 on 3931 | Still fails as a placement method |
| Learned nonlinear placement ranker | 0/102 and 0/38 | No held-out top-1 improvement |

Placement rows are **historical truth-state diagnostics**, not generated-model
accuracy. They give the ranker a correct partial assembly and oracle part
identity, use permissive historical ID/2-LDU/5-degree matching, and only cache
rows where a correct candidate survived. The denominator above includes the
other placements as misses. They therefore remain optimistic component tests.
No VLM-derived hint features were included. An accurate model cannot be inferred
from them, and the cached features do not establish a PDF-only assembly input
path. The two folds train on one set and evaluate on the other; neither set is
in the protected 53-set training exclusion cohort.

## GPU experiment and evaluation boundaries

The dataset contains **3,995 automatically extracted labeled BOM icons from
80 official PDFs**: 54 training sets, eight validation sets, 18 test sets.
All 53 protected reconstruction benchmark sets, plus 41624, 3931 and 910058,
are excluded from CNN training. PDF content duplicates are deduplicated before
splitting. The correct part/color labels come from printed element numbers and
universal catalog mappings; no per-set inventory is supplied.

The model is a 433,264-parameter convolutional encoder trained from scratch
with contrastive image matching for 600 steps. Positive pairs share part ID;
augmentation changes scale, translation, grayscale mixing and noise. The best
checkpoint is selected on validation only, at step 300. Training runs on CUDA;
reported PyTorch peak allocated memory is 99,023,360 bytes (about 94 MiB), inside
a 10% per-process memory cap. This is allocator memory, not total driver VRAM.
The optimizer loop took about 5.5 seconds; data harvesting and descriptor
evaluation take additional time. A much larger model was unnecessary for this
initial trial. The existing llama-server already occupied about 13.9 GB.

The headline icon test is deliberately narrow:

- It supplies the correct **color from the PDF label** and evaluates shape
  recognition within that color. It is not joint unknown part/color recognition.
- There are 825 test queries, but only **411** have a matching part/color class
  available in training after exact image-duplicate exclusion. Counting all
  queries, the CNN is **374/825 (45.3%)**, versus pixels **357/825 (43.3%)**.
- Identical normalized images are excluded as candidate references. Near
  duplicates are not excluded; the same part designs occur across set splits.
  This is neither novel-part generalization nor a representative corpus score.
- Printed-label association and artwork cropping are automatic and not all
  independently verified. A recognition result can inherit label/crop errors.
- Of the paired eligible queries, the CNN fixes 26 pixel-baseline errors and
  introduces nine. This is preliminary evidence from 18 test booklets, not
  proof of a general four-percentage-point gain on independent parts.

The exact checkpoint is retained at
`output/pdf-recon-trials/artwork-encoder.pt`, SHA-256
`71ade4012374d9ccb9d164426e4c1eda99fdfc454f05194750b6a8c8621bfb48`.
Its trained weights are not loaded by the production reconstruction pipeline.

## Real callout transfer and label audit

The frozen encoder was evaluated against PDF-derived inventory references for
all 83 schema-valid historical PLI crops. No true-color filter or truth-derived
candidate selection is used in this transfer check. Pixels score 16/83, HOG
13/83, CNN 15/83. Excluding the one set whose inventory artwork was used in
training leaves 67 crops: pixels 13, HOG 11, CNN 13. Only 49 of those 67 have
their labeled exact part/color available in the PDF references.

These scores **cannot certify recognition accuracy**. Direct inspection of
`transfer-contact-sheet.png` shows step digits (30, 17, 5) in supposed part
crops, and clear gray-versus-yellow mismatches between some callouts and their
historical labels. Some wide inventory crop regions can include neighboring
artwork. Exact mold differences cannot be judged from these small crops alone.
No labels were silently changed to agree with the model's predictions. This
trial strengthens the need for independent crop/label validation before scaling
training; it does not establish a recognition information floor.

Exact XObject reuse initially looked promising because inventory-page image
digests reappear elsewhere in 50 booklets. Requiring the image to lie within
an individually labeled inventory region, have an unambiguous part/color,
and sit beside a quantity token reduces that to just two step callouts in
42059: four wheels and four tires. Their page-42 crops were visually inspected.
Repeated background/page graphics must never be counted as resolved parts.
Vector artwork and differently rendered copies are outside this method.

## What to pursue next

The next useful training target is a **part-image-conditioned detector/keypoint
model on independently verified real step crops**, with the output explicitly
distinguishing the loose callout from the destination in the assembly. The
current CNN is an embedding model; it has no representation of a destination,
subassembly, camera or occlusion. Training it longer cannot add those outputs.

The [MEPNet paper](https://www.ecva.net/papers/eccv_2022/papers_ECCV/papers/136970663.pdf)
provides a relevant architectural precedent: predict 2D keypoints, then resolve
3D placements through possible connections. Its reported results do not prove
it will solve these real PDFs, and the repo's earlier synthetic Florence
fine-tuning already failed to transfer. Real labels and explicit step/page
structure are the key prerequisites for a meaningful next training experiment.

For placement, richer image evidence and a reliable subassembly/camera state
are needed before simply learning weights over current scalar scores. The
linear and nonlinear trials use only 11 existing geometry/image signals; their
failure does not rule out learned dense correspondence, joint rendering/search
or a properly labeled keypoint architecture. It does rule out claiming this
small reranker has closed the placement gap.

## Reproduction and safeguards

New scripts are in `scripts/pdf-recon/`. Run them with explicit UTF-8 on Windows:

```powershell
python -X utf8 -B scripts/pdf-recon/matching_trials.py harvest --booklets 80
python -X utf8 -B scripts/pdf-recon/matching_trials.py train --steps 600
python -X utf8 -B scripts/pdf-recon/step_transfer_trial.py
python -X utf8 -B scripts/pdf-recon/artwork_reuse_trial.py
python -X utf8 -B scripts/pdf-recon/placement_rank_trial.py
python -X utf8 -B scripts/pdf-recon/test_matching_trials.py
python -X utf8 -B scripts/pdf-recon/summarize_trials.py
```

The harvest refuses to overwrite an existing artwork manifest. Other trial
commands write fixed research result/checkpoint paths: preserve a copy before
rerunning. They depend on the local clego assets and trusted local historical
pickle caches; never substitute an untrusted downloaded pickle.

Three protocol tests pass: held-out images cannot become references, identical
image references are excluded even when they would win, and blank crops are
rejected. `summary.json` is generated from the saved detailed results, not
terminal progress output. All outputs remain under `output/pdf-recon-trials/`.
Original PDFs, benchmark labels, existing model files and production data are
unchanged.

## Continued work after push approval: fixing the actual crop association

The original trials were pushed as `8528ee5`. Further work found a concrete
extractor defect: `extract_e4.slice_pli_items` assigns foreground components
by **horizontal distance only**, and excludes quantity text but not all other
PDF text. Thus artwork in another row, a step number or a rotation symbol can
be joined into the crop. Merely replacing its image classifier cannot repair
that input.

`pdf_crop_trial.py` trials a new association rule: remove text regions using
the PDF's text coordinates, find nearby nontext artwork **above** each quantity,
and reject ambiguous or duplicate claims. It is opt-in research code; the
historical extractor and production defaults remain unchanged. Across 41637,
42044 and 42058, it resolves 180 of 287 quantity anchors; the old method emits
261 crops. Those counts are not precision/recall. Side-by-side inspection shows
real plates/slopes replacing digits and rotation symbols, and isolated pieces
replacing multi-part crops. The reduced yield is a material regression risk.

To avoid scoring those new crops against the already-corrupted labels, eleven
clear 41637 crops were visually checked against the original printed inventory.
Their element IDs and catalog mappings are recorded in `crop_gold.json`, with
the review protocol. Predictions were scored after fixing those labels. 41637
was not used in CNN training; no true-color filter is supplied. Results:

| Matcher | Visually checked development callouts |
| --- | ---: |
| Pixels | 10/11 |
| HOG | 9/11 |
| Frozen CNN | 11/11 |

This is **not** 100% recognition on a benchmark. The eleven examples were
selected for visual clarity from four pages of one set, contain repeated parts,
and follow catalog mold naming. They are not training data and not evidence
that the CNN generalizes to obscured/ambiguous parts. They do demonstrate that
the old low score cannot be interpreted independently of crop/label quality.

The method was then tested in the complete PDF-only assembler, not only on
crops. `anchored_pipeline_trial.py` temporarily substitutes the research front
end and restores the original Python classes afterward. The frozen matcher
builds candidates from that PDF's inventory artwork and universal mappings;
it reads no truth model or external set inventory. Candidate-window CNN
placement compares the actual image at each projected legal candidate to the
PDF's part icon, instead of learning weights over scalar scores. Its camera fit
and candidate budget are unchanged. All models stay quarantined.

| Full-model trial | Parts emitted | Strict full-pose matches |
| --- | ---: | ---: |
| 41624 anchored crops + existing matcher + contact placement | 69 | 2/109 |
| 41624 anchored crops + frozen CNN + contact placement | 71 | 2/109 |
| 40377 anchored crops + frozen CNN + template placement | 45 | 1/90 |
| 40377 anchored crops + frozen CNN + CNN candidate-window placement | 45 | 2/90 |

The last trial changes model bytes, so the learned placement path actually ran.
One extra matching pose on this fixture is not a meaningful solved-assembly
gain. Inventory coverage regresses, and the current camera/candidate state
still prevents accurate placement. These variants are **not promoted**.

Three additional crop protocol tests pass: text/lower-row artwork are excluded,
two quantities cannot claim one component, and missing artwork stays unresolved.
`output/pdf-crop-trial/summary.json` aggregates the saved results; comparison
images, manifests, journals, gold scores and quarantined models are alongside
it. Trial manifests record code/checkpoint hashes for the CNN variants. The
first synthetic-matcher crop run preceded that extra trial-provenance field;
its source is preserved in this commit and its model bytes remain recorded.

The remaining engineering target is to raise crop coverage **without** losing
the new spatial/text safeguards, build a substantially larger independently
checked real-callout/destination dataset, and solve the camera/subassembly state.
The trained embedding and the optional crop extractor are useful research
components, but neither currently supports a production accuracy claim.

### Further continuation: crop coverage recovered; placement still fails

The low initial crop yield was not an inherent precision/recall ceiling.
Two concrete implementation problems were diagnosed from the rejected anchors:

1. A 2-by-2 morphological closing kernel shifts components by a pixel. Artwork
   touching the label baseline then failed a tight edge test. An odd, centered
   kernel recovers 257/287 anchors, versus the initial 180/287. Text is masked
   again after morphology so closing cannot refill the text mask.
2. An isometric part's far corner can extend below its left-aligned quantity
   label. Distance to the **global bounding-box bottom** is therefore wrong.
   Distance to actual nearby ink above the quantity, with the component center
   required above it, recovers 285/287. A tolerance scaled by label height and
   allowance for longer Technic parts completes this development slice.

The expanded check has **409/412 resolved anchors across five PDFs**:

| Set | Quantity anchors | Resolved crops |
| --- | ---: | ---: |
| 41637 | 92 | 92 |
| 42044 | 90 | 90 |
| 42058 | 105 | 105 |
| 41624 | 69 | 68 |
| 40377 | 56 | 54 |

The first three sets were development inputs; the last two test the association
on additional booklets. All were already familiar pipeline fixtures, so this
is not a fresh representative corpus sample. The three remaining rejects are
crowded layouts with ambiguous/multiply claimed artwork and remain unresolved.
**99.3% is detected-anchor crop coverage, not accurate part identification,
not true instruction-callout recall, and not model accuracy.** Five crop
regression tests now pass, including coordinate preservation and removing PDF
text from the final matcher pixels, not only the segmentation mask.

The same fixed eleven development identities still score pixels 10/11,
HOG 9/11, frozen CNN 11/11. Text deletion can affect genuine text-bearing artwork;
the experimental cropper does not claim complete printed-part preservation.

Full PDF-only reconstruction with the revised crops, original frozen CNN, and
CNN candidate-window placement emits **83 parts on 40377**, up from 45 with
the first crop trial. Exact part/color inventory coverage improves from
**31/90 to 69/90**; full-pose matching stays **2/90**. The intermediate centered-
kernel 41624 run emits 92 parts with 76/109 exact part/color instances and
2/109 correct poses. These are real extraction improvements but no placement
breakthrough. Historical baseline comparisons still need the strict metric's
part-mold/symmetry caveats.

The first CNN candidate-window experiment was repeated with invocation
counters: 44 calls scored 2,169 candidate windows and produced identical model
bytes (`08cf12273bbb6b0c6969fb4aa413c295fe26d4ac7509d973e1b38f1ede190a1a`).
This verifies the experimental path actually ran; it does not certify it.

A second GPU checkpoint adds random 16/20/24/32/48/64-pixel downsample/upscale
augmentation to address the measured sharp-BOM/tiny-callout resolution gap.
It uses the same excluded-set split and 600 steps, selecting step 200 on
validation. Eligible held-out icon recognition is **371/411**, below the first
checkpoint's 374/411; both score 11/11 on the small visual development slice.
No gain is established, so the first checkpoint remains the research default.
This pilot changes random minibatch sampling as well as augmentation and is
not a controlled causal estimate of the augmentation's isolated effect.

Evidence directories are preserved separately:
`output/pdf-crop-trial/`, `output/pdf-crop-trial-v2/`,
`output/pdf-crop-trial-v3/`, `output/pdf-crop-trial-v4/`.
The new checkpoint/results are `artwork-encoder-lowres.pt` and
`matching-results-lowres.json` under `output/pdf-recon-trials/`.
Use `PDF_CROP_OUT` to select a new crop-evidence directory and
`PDF_MATCHER_CHECKPOINT` to select an explicit frozen checkpoint. The normal
production pipeline and published model data remain unchanged.

### Joint identity assignment: execution resumed after credit restoration

`global_pdf_assignment.py` now prepares a binary optimization over all detected
callouts and PDF-derived inventory capacities. A quantity group must select one
part/color together; unused inventory and unresolved callouts remain allowed.
The purpose is to test whether global consistency beats greedy early depletion,
not to treat matching inventory totals as placement accuracy.

The first trial command was
rejected by automatic approval review with: “Your workspace is out of credits.
Add credits to continue.” The user has already authorized continued work and
feature-branch pushes. The user restored credits and this command completed:

```powershell
python -X utf8 -B scripts/pdf-recon/anchored_pipeline_trial.py C:/git/clego/lego_sets/PDF/6314914.pdf --out output/pdf-crop-trial-v4/40377-joint-cnn --matcher cnn --strategy template --placement-matcher cnn --joint
```

HiGHS reached an optimal solution for its stated objective (gap 0), assigning
53 of 54 usable callouts / 88 pieces. The assembler placed 86 pieces; two
assigned pieces could not be placed. Independent checks passed for inventory
capacities, unique callouts, and the correspondence between placements and
their assigned pages. Four regression tests reject over-capacity assignments,
duplicate callouts and placements on the wrong page, and report missing
placements without certifying accuracy.

Exact part/color inventory coverage is **72/90 (80%)**, up from greedy
**69/90 (76.7%)**. Strict full-pose coverage remains **2/90 (2.2%)**.
The CNN placement scorer ran on 84 calls / 4,663 candidate windows. There were
zero runtime VLM calls. Model SHA256:
`36c0e7004d431f1c77d1c6648763b7a549c5c54df2ee7a59a5c464d17accdb9a`.
Evidence: `output/pdf-crop-trial-v4/40377-joint-cnn/`, including
`global-assignment.json`, `assignment-validation.json`, `pose.json`, and
`manifest.json`. Capacity consistency does not independently verify the
identity assigned to each instruction step. This is a matching improvement
on one development fixture, not a placement breakthrough or a certified model.

### Candidate-budget ablation and duplicate PDF text fix

The default native assembler uses a 90-candidate proximity prefilter before
image localization. A joint-assignment run with `--candidate-budget 360
--page-prefilter` retained the same 86 emitted pieces / 72 exact identities,
but dropped to **1/90 strict poses**. CNN localization scored 16,708 windows
on 85 calls. Its independent assignment checks passed. Evidence is under
`output/pdf-crop-trial-v4/40377-joint-page360/`. The larger pool and page filter
are a combined ablation, not an estimate of either change independently; they
remain opt-in and are not the default.

Inspection then found two identical overprinted quantity tokens at the exact
same coordinates on 40377 page 31. Treating these as separate callouts inflated
the denominator and caused both to reject the same artwork. The cropper now
deduplicates only identical quantity/bounding-box pairs, preserving different
locations and conflicting quantities. Expected page totals use these unique
callouts as well. Two new regression tests cover this behavior.

The resulting v5 check has **412 raw tokens, 411 unique anchors, 410 resolved
crops** across the same five development PDFs. This is still association
coverage, not a population accuracy result. Consistent text masking in the
gold scorer retains pixels 10/11, HOG 9/11, CNN 11/11. All seven crop tests,
three matching-protocol tests and four assignment-validation tests pass.

The final v5 joint run assigns 89 pieces, emits **87**, and scores **73/90
exact part/color instances; 2/90 strict poses**. Inventory capacities, unique
assignments and per-page placement correspondence pass. Evidence is preserved
under `output/pdf-crop-trial-v5/40377-joint-cnn/`. No runtime VLM or production
model write occurred in any of these continuation trials.

### Exact-ID scoring also has a catalog-version limitation

`inventory_ceiling.py` compares the PDF-derived BOM with independent OMR only
after reconstruction. On 40377, the PDF supplies 89 resolved pieces but exact
identifier/color overlap is only **73/90** before any callout matching. The
v5 matcher reaches that exact-inventory ceiling, so its remaining identifier
disagreement must not all be charged to the CNN.

Twelve discrepancies are `3023b` versus `3023`; the installed universal part
file records that `3023b` moved from `3023.dat` in 2023. Two are `98138pb072`
versus `98138pz0`; the universal Studio catalog explicitly maps both to the
same BrickLink item. Two more concern printed torso identifiers (`3010pb291`
versus `3010py3`, `3245cpb117` versus `3245cpzc`), and the OMR contains a gray
`4032a` absent from the resolved PDF BOM. Those still require reconciliation.
No equivalences were silently applied to the strict score, and naming evidence
alone does not prove coordinate-frame equivalence. Evidence:
`output/pdf-crop-trial-v4/40377-joint-cnn/inventory-ceiling.json`.

These results establish a ceiling for the current greedy, camera-fitted
candidate-ranking architecture on these fixtures, not impossibility of a
better deterministic assembler. The remaining work needs independently
validated instruction panels, subassembly/multiplier and attachment graphs,
camera/depth recovery and multi-step backtracking. More icon training or a
large batch of this engine has not demonstrated a route to >95% full models.
No continuation model qualifies for publication.
