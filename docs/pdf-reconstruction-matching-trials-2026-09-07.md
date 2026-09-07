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
