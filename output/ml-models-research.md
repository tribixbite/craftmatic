# ML Models & Datasets Research for Craftmatic Building Analysis

Research date: 2026-02-26
Source: Hugging Face Hub, HF Papers

---

## 1. Facade Parsing / Semantic Segmentation

### Models

#### **Xpitfire/segformer-finetuned-segments-cmp-facade** -- BEST CANDIDATE
- **HF Repo:** [Xpitfire/segformer-finetuned-segments-cmp-facade](https://hf.co/Xpitfire/segformer-finetuned-segments-cmp-facade)
- **Architecture:** SegFormer (MIT-B0 backbone)
- **Training Data:** CMP Facade dataset (606 rectified facade images, 12 classes)
- **Classes:** facade, molding, cornice, pillar, window, door, sill, blind, balcony, shop, deco, background
- **Input:** 512x512 RGB images
- **Output:** Per-pixel segmentation mask (12 classes)
- **Downloads:** 164 | **Likes:** 3
- **License:** MIT
- **Library:** HuggingFace Transformers (PyTorch)
- **Browser viability:** HIGH -- SegFormer-B0 is ~3.7M params. ONNX conversion straightforward. Xenova already has ADE-trained SegFormer ONNX variants. This could be exported to ONNX and run via Transformers.js.
- **Production readiness:** Medium. CMP Facade is a small dataset (606 images). Good starting point but may need fine-tuning on additional data for robustness on diverse US residential buildings.
- **Notes:** The most directly relevant model on HF. SegFormer architecture is efficient and well-suited for browser deployment. The CMP Facade classes map well to craftmatic's needs (windows, doors, walls, balconies, moldings).

#### walup/facades_segmentation
- **HF Repo:** [walup/facades_segmentation](https://hf.co/walup/facades_segmentation)
- **Created:** Jan 2026 (very recent)
- **Downloads:** 0
- **Details:** Sparse -- no tags, no documentation. Likely a personal experiment.
- **Production readiness:** Unknown/low

#### galthran/segformer-facade
- **HF Repo:** [galthran/segformer-facade](https://hf.co/galthran/segformer-facade)
- **Architecture:** SegFormer
- **Library:** Transformers (PyTorch)
- **Production readiness:** Low -- no downloads, no documentation

#### galthran/maskformer-facade-panoptic
- **HF Repo:** [galthran/maskformer-facade-panoptic](https://hf.co/galthran/maskformer-facade-panoptic)
- **Architecture:** MaskFormer (panoptic)
- **Library:** Transformers (PyTorch)
- **Production readiness:** Low -- experimental

### General-Purpose Segmentation (adaptable to facade parsing)

#### **nvidia/segformer-b0-finetuned-ade-512-512** -- RECOMMENDED BASELINE
- **HF Repo:** [nvidia/segformer-b0-finetuned-ade-512-512](https://hf.co/nvidia/segformer-b0-finetuned-ade-512-512)
- **Architecture:** SegFormer-B0
- **Downloads:** 590K | **Likes:** 179
- **Training:** ADE20K (150 classes including building, wall, window, door, fence, column, etc.)
- **Input:** 512x512 RGB
- **Output:** 150-class segmentation mask
- **License:** "other" (NVIDIA open model license)
- **ONNX/Browser:** Already available as [Xenova/segformer-b0-finetuned-ade-512-512](https://hf.co/Xenova/segformer-b0-finetuned-ade-512-512) (495K downloads, Transformers.js + ONNX)
- **Browser viability:** PROVEN -- already running in-browser via Transformers.js
- **Relevance:** ADE20K has building-related classes (building, house, wall, window, door, column, fence, awning, etc.) but NOT facade-specific fine-grained classes (no separate "molding", "cornice", "sill", "blind"). Could be used as a strong pre-trained backbone for fine-tuning on CMP Facade data.
- **Production readiness:** HIGH for general segmentation. Would need fine-tuning for facade-specific classes.

#### facebook/mask2former-swin-large-ade-semantic
- **HF Repo:** [facebook/mask2former-swin-large-ade-semantic](https://hf.co/facebook/mask2former-swin-large-ade-semantic)
- **Architecture:** Mask2Former + Swin-Large backbone
- **Downloads:** 70K | **Likes:** 21
- **Training:** ADE20K (150 classes)
- **License:** "other" (Meta license)
- **Browser viability:** LOW -- Swin-Large is ~197M params, too heavy for browser
- **Production readiness:** High on server-side, not suitable for browser

#### CIDAS/clipseg-rd64-refined -- ZERO-SHOT OPTION
- **HF Repo:** [CIDAS/clipseg-rd64-refined](https://hf.co/CIDAS/clipseg-rd64-refined)
- **Architecture:** CLIPSeg (CLIP + decoder)
- **Downloads:** 1.6M | **Likes:** 137
- **Input:** Image + text prompt (e.g., "window", "door", "brick wall")
- **Output:** Binary segmentation mask per text query
- **License:** Apache 2.0
- **Browser viability:** Medium -- ~150M params, would need ONNX conversion. Text-guided means no training needed for new classes.
- **Production readiness:** High for flexible zero-shot segmentation. Can segment "windows on a building facade" without training. Lower precision than dedicated models.

### Datasets

#### **Xpitfire/cmp_facade** -- PRIMARY DATASET
- **HF Repo:** [Xpitfire/cmp_facade](https://hf.co/datasets/Xpitfire/cmp_facade)
- **Size:** 606 rectified facade images
- **Classes:** 12 (facade, molding, cornice, pillar, window, door, sill, blind, balcony, shop, deco, background)
- **Format:** Parquet (image + mask pairs)
- **License:** MIT
- **Downloads:** 49 | **Likes:** 4
- **Notes:** The canonical CMP Facade dataset on HF. Small but well-annotated. European buildings predominantly.

#### murai-lab/WorcesterMA_Housing_Facades
- **HF Repo:** [murai-lab/WorcesterMA_Housing_Facades](https://hf.co/datasets/murai-lab/WorcesterMA_Housing_Facades)
- **Size:** 10K-100K images
- **Task:** Image classification (4 facade classes)
- **Downloads:** 18.7K
- **License:** MIT
- **Notes:** US housing facades from Worcester, MA. 4 class classification (not segmentation). Could supplement training data.

#### seshing/openfacades-dataset-full
- **HF Repo:** [seshing/openfacades-dataset-full](https://hf.co/datasets/seshing/openfacades-dataset-full)
- **Size:** 1K-10K images with CSV metadata
- **License:** CC-BY-4.0
- **Notes:** From the OpenFACADES paper (2025). Multi-attribute annotations from street-level imagery.

#### Ymx1025/FacadeTrack
- **HF Repo:** [Ymx1025/FacadeTrack](https://hf.co/datasets/Ymx1025/FacadeTrack)
- **Size:** 1K-10K images
- **Notes:** Hurricane Helene building facade damage dataset. Could be useful for condition assessment.

### Papers of Interest

- **OpenFACADES (2025):** Uses VLMs (InternVL, ChatGPT-4o) to infer building attributes from street-level imagery. Multi-attribute prediction including materials, stories, style. HF models: `seshing/openfacades-internvl3-2b` (InternVL3 2B fine-tuned for facade analysis).
- **ADE20K (2016):** 150-class scene understanding. Includes building elements.

---

## 2. Window/Door Detection

### Models

#### **IDEA-Research/grounding-dino-tiny** -- BEST ZERO-SHOT OPTION
- **HF Repo:** [IDEA-Research/grounding-dino-tiny](https://hf.co/IDEA-Research/grounding-dino-tiny)
- **Architecture:** Grounding DINO (DINO + grounded pre-training)
- **Downloads:** 463K | **Likes:** 96
- **Input:** Image + text prompt (e.g., "window", "door", "garage door")
- **Output:** Bounding boxes with confidence scores
- **License:** Apache 2.0
- **Browser viability:** Medium-Low -- 172M params. Could work with ONNX but heavy for mobile. Text-guided means no retraining needed.
- **Production readiness:** HIGH. State-of-the-art open-vocabulary object detection. Can detect windows, doors, garage doors, chimneys by text prompt. Could count windows per floor by combining with vertical position analysis.

#### mukesh3444/window_detection_model
- **HF Repo:** [mukesh3444/window_detection_model](https://hf.co/mukesh3444/window_detection_model)
- **Architecture:** MaskFormer
- **Downloads:** 9
- **License:** Apache 2.0
- **Notes:** Dedicated window detection but very low usage. Uncertain quality.

#### darius-muc/YOLOv7_Window_Detection_with_Measurements
- **HF Repo:** [darius-muc/YOLOv7_Window_Detection_with_Measurements](https://hf.co/darius-muc/YOLOv7_Window_Detection_with_Measurements)
- **Architecture:** YOLOv7
- **Notes:** Includes window measurement capabilities. Dec 2025. No downloads yet but architecturally promising for counting + sizing windows.
- **Browser viability:** Medium -- YOLO models can run in ONNX/browser but YOLOv7 is moderately heavy.

#### yiqianlow/door_detection
- **HF Repo:** [yiqianlow/door_detection](https://hf.co/yiqianlow/door_detection)
- **License:** Apache 2.0
- **Notes:** Dedicated door detection. No downloads, unknown quality.

### Spaces

- **kurakula-Prashanth2004/door-window-detection** (Docker)
- **girishdongrekar/Door_window_detection** (Gradio)

### Recommended Strategy
For window/door detection, the most practical approach is either:
1. **Grounding DINO** (zero-shot, text-prompted "window", "door") -- highest quality, heaviest
2. **CLIPSeg** for binary segmentation of windows/doors -- lighter, less precise bounding
3. **Fine-tuned YOLOv8-nano** on a custom window/door dataset -- lightest for browser, requires training data
4. **SegFormer fine-tuned on CMP Facade** -- gets windows/doors as part of full facade parse

---

## 3. Architectural Style Classification

### Models

#### **gatecitypreservation/architectural_styles** -- MOST ESTABLISHED
- **HF Repo:** [gatecitypreservation/architectural_styles](https://hf.co/gatecitypreservation/architectural_styles)
- **Architecture:** ViT (Vision Transformer) -- HuggingPics training
- **Task:** Image classification
- **Downloads:** 4 | **Likes:** 6
- **Library:** Transformers (PyTorch)
- **Notes:** Built by a historic preservation organization. Likely covers common US architectural styles. ViT-based so could be exported to ONNX.
- **Browser viability:** HIGH -- ViT-Base is ~86M params, well within browser capability
- **Production readiness:** Medium. Low download count suggests limited validation. Style taxonomy may match craftmatic's needs.

#### hanslab37/architectural_styles_classifier
- **HF Repo:** [hanslab37/architectural_styles_classifier](https://hf.co/hanslab37/architectural_styles_classifier)
- **Architecture:** SegFormer (MIT-B0) for classification
- **Base model:** nvidia/mit-b0
- **Notes:** Very lightweight (~3.7M params). SegFormer repurposed for classification.
- **Browser viability:** VERY HIGH

#### sameerhimati/architectural-style-classifier-EfficientNetFineTuned
- **HF Repo:** [sameerhimati/architectural-style-classifier-EfficientNetFineTuned](https://hf.co/sameerhimati/architectural-style-classifier-EfficientNetFineTuned)
- **Architecture:** EfficientNet (fine-tuned)
- **License:** MIT
- **Browser viability:** HIGH -- EfficientNet is designed for efficiency

#### fxxkingusername/architectural-style-classifier
- **HF Repo:** [fxxkingusername/architectural-style-classifier](https://hf.co/fxxkingusername/architectural-style-classifier)
- **Architecture:** PyTorch (unspecified)
- **Likes:** 1

### Zero-Shot Alternative

#### **openai/clip-vit-base-patch32** -- ZERO-SHOT STYLE CLASSIFICATION
- **HF Repo:** [openai/clip-vit-base-patch32](https://hf.co/openai/clip-vit-base-patch32)
- **Downloads:** 18.3M | **Likes:** 867
- **License:** MIT-like (OpenAI)
- **Approach:** Zero-shot classify with prompts: "a photo of a Victorian building", "a photo of a Colonial building", "a photo of a Modern building", etc.
- **Browser viability:** PROVEN -- ONNX variants exist via Xenova/Transformers.js
- **Production readiness:** HIGH for zero-shot. Accuracy depends on prompt engineering. Likely 60-75% accuracy on architectural styles without training.
- **Notes:** Most practical immediate option. No training needed. Style labels can be updated/extended by changing text prompts.

### VLM Alternative

#### seshing/openfacades-internvl3-2b
- **HF Repo:** [seshing/openfacades-internvl3-2b](https://hf.co/seshing/openfacades-internvl3-2b)
- **Architecture:** InternVL3-2B fine-tuned
- **Input:** Image + text query about building
- **Output:** Free-text description of architectural attributes (style, materials, stories, age)
- **License:** Apache 2.0
- **Browser viability:** LOW -- 2B params, server-side only
- **Production readiness:** Medium-High. Can answer "What architectural style is this building?" but requires GPU inference server.

### Spaces (demos)
- `ossaili/architectural_styles` -- Gradio, 2 likes
- `ossaili/27_Architectural_Styles_Classifier` -- 27-class classifier
- `jphwang/architectural_styles` -- Gradio
- `dacor/architectural_style_classification` -- Gradio
- `ZoeCD/architectural-styles-classifier` -- Gradio (Jan 2026, most recent)
- `cansoysall/architectural-style-classifier` -- Gradio

### Recommended Strategy
1. **Immediate/browser:** CLIP zero-shot with architectural style prompts
2. **Better accuracy:** Fine-tune ViT or EfficientNet on an architectural styles dataset (not found on HF, but the 25-class "Architectural Styles" dataset exists on Kaggle)
3. **Best quality:** OpenFACADES InternVL3 model (server-side API call)

---

## 4. Roof Type Classification

### Models

#### **Prahas10/roof_classification** -- MOST DOWNLOADS
- **HF Repo:** [Prahas10/roof_classification](https://hf.co/Prahas10/roof_classification)
- **Architecture:** ViT-Base (patch32, 384px) fine-tuned
- **Base model:** google/vit-base-patch32-384
- **Downloads:** 5
- **License:** Apache 2.0
- **Library:** Transformers (TensorFlow/Keras)
- **Browser viability:** HIGH -- ViT-Base ~86M params, ONNX convertible, TF.js compatible
- **Production readiness:** Low -- very few downloads, needs validation

#### issatingzon/cnn-roof_type-efficientnetb0-RGB_DOM_LCA
- **HF Repo:** [issatingzon/cnn-roof_type-efficientnetb0-RGB_DOM_LCA](https://hf.co/issatingzon/cnn-roof_type-efficientnetb0-RGB_DOM_LCA)
- **Architecture:** EfficientNet-B0
- **Input:** RGB + DOM (Digital Orthophoto Map) + LCA
- **Notes:** Multi-modal input (not just satellite RGB). Research-grade.
- **Browser viability:** Medium -- EfficientNet-B0 is very light but multi-modal input complicates browser use

#### HarshaSingamshetty1/roof_classification_rearrange_labels
- **Architecture:** ViT-Base (patch16, 224px)
- **License:** Apache 2.0

#### z1th1z/RoofType_Detect
- **HF Repo:** [z1th1z/RoofType_Detect](https://hf.co/z1th1z/RoofType_Detect)
- **Notes:** No documentation, no tags

### Datasets

#### MElHuseyni/building_height_estimation
- **HF Repo:** [MElHuseyni/building_height_estimation](https://hf.co/datasets/MElHuseyni/building_height_estimation)
- **Size:** 1K-10K satellite images with building footprints and height annotations
- **License:** MIT
- **Notes:** From the Mask-to-Height paper (YOLOv11-based). Includes height classification labels. Could derive roof type from overhead shape.

### Papers of Interest

- **RoofNet (2025):** A multimodal dataset for global roof material classification using satellite imagery + text. Vision-language model with geographic-aware prompt tuning. Includes roof shape, footprint area, solar panel presence. Not yet on HF as a dataset/model.
- **ZRG: Zeitview Rooftop Geometry (2023):** Multimodal 3D residential rooftop dataset with aerial orthomosaics, DSMs, point clouds, and 3D roof wireframe annotations. Supports roof outline extraction, monocular height estimation, planar structure extraction. Research paper -- no HF model released.
- **Satellite Sunroof (2024):** Google's Solar API approach. DSM + roof instance segmentation from satellite. Production-grade (powers Google Solar API) but not open-source.

### Recommended Strategy
1. **Immediate/browser:** CLIP zero-shot with "flat roof", "gable roof", "hip roof", "mansard roof" prompts on satellite crops
2. **Better accuracy:** Fine-tune ViT-Base on a roof type dataset (would need to assemble from satellite imagery)
3. **Hybrid:** Use existing Google Solar API roof segmentation (already integrated in craftmatic) combined with CLIP classification on the segmented roof area

---

## 5. Material Recognition

### Models

None found with significant production quality on HF specifically for building material recognition from images.

### Spaces

#### canadianjosieharrison/facade-material-classifier
- **HF Repo:** [spaces/canadianjosieharrison/facade-material-classifier](https://hf.co/spaces/canadianjosieharrison/facade-material-classifier)
- **SDK:** Gradio
- **Notes:** The only HF Space dedicated to facade material classification. Jan 2025. Unknown architecture/accuracy. Worth investigating the underlying model.

### Zero-Shot Approaches

#### **CLIP Zero-Shot Material Classification** -- RECOMMENDED
- Use `openai/clip-vit-base-patch32` or `openai/clip-vit-large-patch14`
- Prompts: "a brick building facade", "a wood siding building", "a stucco building wall", "a stone facade", "a vinyl siding house", "a concrete building"
- **Browser viability:** PROVEN (ONNX variants available)
- **Expected accuracy:** 50-70% for material classification (CLIP is weaker on texture/material than on object/scene recognition)

#### **CLIPSeg for Material Region Segmentation**
- Use `CIDAS/clipseg-rd64-refined` with prompts like "brick wall area", "wooden siding area"
- Returns per-pixel probability masks
- **Browser viability:** Medium (needs ONNX conversion)

### Papers of Interest

- **OpenFACADES (2025):** Multi-attribute prediction including wall material, cladding, color from street-view imagery. The fine-tuned InternVL3 model (`seshing/openfacades-internvl3-2b`) can describe materials but requires server-side inference.

### Datasets Needed (not found on HF)
- DTD (Describable Textures Dataset) -- contains material textures but not building-specific
- MINC (Materials in Context) -- 23 material categories from real-world images
- Facade material datasets are scarce on HF

### Recommended Strategy
1. **Immediate:** CLIP zero-shot with material prompts (cheapest, runs in browser)
2. **Better:** Fine-tune a lightweight classifier (MobileNet/EfficientNet-B0) on a building materials dataset. Assemble training data from Google Street View crops + manual labels.
3. **Best:** CLIPSeg for spatial material segmentation (where on the facade is brick vs. stone)
4. **Server-side:** OpenFACADES InternVL3 model for comprehensive material descriptions

---

## 6. Height/Floor Estimation from Single Image

### Models

#### **Depth Anything V2 Small** -- BEST FOR BROWSER
- **HF Repo:** [depth-anything/Depth-Anything-V2-Small-hf](https://hf.co/depth-anything/Depth-Anything-V2-Small-hf)
- **Architecture:** DINOv2 backbone + DPT head
- **Downloads:** 1.2M | **Likes:** 30
- **Input:** Any RGB image (auto-resizes)
- **Output:** Relative depth map (not metric)
- **License:** Apache 2.0
- **ONNX/Browser:** [onnx-community/depth-anything-v2-small](https://hf.co/onnx-community/depth-anything-v2-small) (2K downloads, Transformers.js)
- **Browser viability:** PROVEN -- already available as ONNX via Transformers.js
- **Relevance for height:** Produces relative depth. Combined with camera intrinsics/SV metadata, can estimate relative building height. Not directly "floor count" but enables geometric reasoning.

#### Depth Anything V3 (Nov 2025, latest)
- **HF Repo:** [depth-anything/DA3METRIC-LARGE](https://hf.co/depth-anything/DA3METRIC-LARGE) (metric depth)
- **Downloads:** 517K
- **Output:** METRIC depth maps (actual meters, not relative)
- **License:** Apache 2.0
- **ONNX:** [onnx-community/depth-anything-v3-small](https://hf.co/onnx-community/depth-anything-v3-small), [v3-base](https://hf.co/onnx-community/depth-anything-v3-base), [v3-large](https://hf.co/onnx-community/depth-anything-v3-large)
- **Browser viability:** Available as ONNX (small/base/large variants)
- **Relevance for height:** METRIC depth is much more useful -- can estimate actual building height in meters from a single street-level photo if the ground plane is visible. Divide by ~3.0-3.5m per floor for story count.
- **Production readiness:** HIGH -- actively maintained, large community

### Height from Satellite

#### Mask-to-Height (YOLOv11)
- **Paper:** [Mask-to-Height (2025)](https://hf.co/papers/2510.27224)
- **Dataset:** [MElHuseyni/building_height_estimation](https://hf.co/datasets/MElHuseyni/building_height_estimation)
- **Architecture:** YOLOv11 for joint building instance segmentation + height classification
- **Notes:** Classifies buildings into height categories from satellite imagery. Research-stage.

### Recommended Strategy
1. **Immediate/browser:** Depth Anything V2 Small ONNX for relative depth, use camera geometry to estimate building height
2. **Better:** Depth Anything V3 metric model (ONNX) for actual meter-scale depth estimation
3. **Floor count algorithm:**
   - Run metric depth on SV image
   - Measure depth at building base vs. building top
   - With SV camera height (~2.5m), triangulate building height
   - Divide by 3.0-3.5m per floor (residential) or 3.5-4.0m (commercial)
4. **Supplementary:** Use floor-line detection (horizontal edges on facade segmentation) to directly count visible floors

---

## 7. Cross-Cutting: Browser-Ready Models (ONNX / Transformers.js)

These are the models with proven browser deployment paths:

| Model | Task | ONNX Repo | Size | Downloads |
|-------|------|-----------|------|-----------|
| SegFormer-B0 ADE20K | Scene segmentation | Xenova/segformer-b0-finetuned-ade-512-512 | ~15MB | 495K |
| Depth Anything V2 Small | Depth estimation | onnx-community/depth-anything-v2-small | ~98MB | 2K |
| Depth Anything V3 Small | Metric depth | onnx-community/depth-anything-v3-small | ~98MB | 26 |
| CLIP ViT-B/32 | Zero-shot classify | Xenova/clip-vit-base-patch32 (exists) | ~338MB | -- |
| SegFormer-B2 Cityscapes | Street scene seg | Xenova/segformer-b2-finetuned-cityscapes | ~100MB | 1.2K |

### Not yet ONNX but convertible:
- Xpitfire/segformer-finetuned-segments-cmp-facade (SegFormer, ~15MB)
- gatecitypreservation/architectural_styles (ViT, ~330MB)
- Prahas10/roof_classification (ViT, ~330MB)
- CLIPSeg (CIDAS/clipseg-rd64-refined, ~600MB)
- Grounding DINO tiny (IDEA-Research, ~690MB -- heavy for browser)

---

## 8. Recommended Integration Priority for Craftmatic

### Phase 1: Zero-Shot (no training, browser-ready)
1. **CLIP zero-shot** for architectural style + material classification
   - Model: `openai/clip-vit-base-patch32` (ONNX via Xenova)
   - Custom prompts for styles, materials, roof types
   - Replace/supplement current year-based style inference

2. **Depth Anything V3 Small** for building height estimation
   - Model: `onnx-community/depth-anything-v3-small` (ONNX)
   - Metric depth from SV images
   - Better than current heuristic floor count estimation

### Phase 2: Fine-Tuned Facade Parsing
3. **SegFormer-B0 fine-tuned on CMP Facade**
   - Base: `nvidia/segformer-b0-finetuned-ade-512-512`
   - Fine-tune on: `Xpitfire/cmp_facade` dataset
   - Export to ONNX for browser deployment
   - Extracts: windows, doors, walls, balconies, cornices, pillars
   - Enables: window counting per floor, door style detection, symmetry analysis

4. **Grounding DINO** for window/door counting (server-side fallback)
   - Use via HF Inference API if browser model insufficient
   - Text-prompted: "window", "front door", "garage door"

### Phase 3: Specialized Models
5. **Roof type classifier** from satellite imagery
   - Fine-tune ViT or EfficientNet-B0 on assembled roof dataset
   - Or use CLIP zero-shot as interim

6. **Material segmentation** via CLIPSeg
   - Segment facade into material regions
   - Feed into material palette resolver

### Implementation Notes
- **Transformers.js** is the primary runtime for browser inference
- Models load asynchronously, cache in IndexedDB
- Inference on a 512x512 image takes ~100-500ms on modern hardware
- Mobile devices: prefer SegFormer-B0 / Depth Anything Small over larger variants
- All ONNX models support WebGPU acceleration in Transformers.js v3+

---

## 9. Key External Resources (Not on HF)

### Datasets available elsewhere:
- **CMP Facade Database** (original): cmp.felk.cvut.cz/~tylecr1/facade/ -- 606 images, 12 classes
- **ECP (Ecole Centrale Paris)**: 104 Haussmann-style building facades
- **eTRIMS**: 60 images, 8 classes (building, car, door, pavement, road, sky, vegetation, window)
- **Graz50**: 50 facade images, 4 classes (door, window, wall, sky)
- **RueMonge2014**: Paris street facades with 3D reconstruction
- **25 Architectural Styles Dataset (Kaggle)**: 10K images, 25 styles including Art Deco, Art Nouveau, Baroque, Colonial, Gothic, Greek Revival, Victorian, etc.
- **DTD (Describable Textures)**: 5640 images, 47 texture categories
- **MINC (Materials in Context)**: 3 million patches, 23 material categories

### Papers with code (no HF release):
- **DeepFacade (2017)**: CNN-based facade parsing with structured output
- **Pyramid ALKNet (2021)**: Facade segmentation with adaptive large kernel attention
- **FacadeNet (2020)**: Multi-task facade parsing
