# ML Models & Datasets for Building Reconstruction and Analysis

Research conducted 2026-02-26 via Hugging Face Hub, Papers, and Spaces.

---

## 1. Monocular Depth Estimation (Single Image to Depth Map)

### Models (Production-Ready)

| Name | HF Link | Downloads | License | Input | Output | API/Self-Host |
|------|---------|-----------|---------|-------|--------|---------------|
| **Depth Anything V2 Small** | [depth-anything/Depth-Anything-V2-Small-hf](https://hf.co/depth-anything/Depth-Anything-V2-Small-hf) | 1.2M | Apache-2.0 | Single RGB image | Relative depth map | HF Inference API + self-host |
| **Depth Anything V2 Large** | [depth-anything/Depth-Anything-V2-Large-hf](https://hf.co/depth-anything/Depth-Anything-V2-Large-hf) | 148K | CC-BY-NC-4.0 | Single RGB image | Relative depth map | Self-host (NC license) |
| **Depth Anything 3 Metric Large** | [depth-anything/DA3METRIC-LARGE](https://hf.co/depth-anything/DA3METRIC-LARGE) | 517K | Apache-2.0 | Single RGB image | **Metric** depth map (meters) | Self-host (custom lib) |
| **Depth Anything 3 GIANT** | [depth-anything/DA3-GIANT-1.1](https://hf.co/depth-anything/DA3-GIANT-1.1) | 338K | CC-BY-NC-4.0 | Single RGB image | Metric depth + multi-view | Self-host |
| **Depth Anything 3 Nested Giant+Large** | [depth-anything/DA3NESTED-GIANT-LARGE-1.1](https://hf.co/depth-anything/DA3NESTED-GIANT-LARGE-1.1) | 96K | CC-BY-NC-4.0 | Single RGB image | Metric depth, pose | Self-host |
| **ZoeDepth (NYU+KITTI)** | [Intel/zoedepth-nyu-kitti](https://hf.co/Intel/zoedepth-nyu-kitti) | 1.8M | MIT | Single RGB image | Metric depth map | HF Inference API + self-host |
| **Intel DPT-Large** | [Intel/dpt-large](https://hf.co/Intel/dpt-large) | 88K | Apache-2.0 | Single RGB image | Relative depth map | HF Inference API + self-host |
| **Apple DepthPro** | [apple/DepthPro-hf](https://hf.co/apple/DepthPro-hf) | 17K | Apple AMLR | Single RGB image | **Metric** depth (focal-agnostic) | HF Inference API + self-host |
| **Marigold Depth v1.0** | [prs-eth/marigold-depth-v1-0](https://hf.co/prs-eth/marigold-depth-v1-0) | 83K | Apache-2.0 | Single RGB image | High-detail depth via diffusion | Self-host (diffusers) |
| **Marigold Depth v1.1** | [prs-eth/marigold-depth-v1-1](https://hf.co/prs-eth/marigold-depth-v1-1) | 23K | OpenRAIL++ | Single RGB image | High-detail depth via diffusion | Self-host (diffusers) |
| **Metric3D v2 (ViT-Giant2)** | [JUGGHM/Metric3D](https://hf.co/JUGGHM/Metric3D) | -- | BSD-2 | Single RGB image | Metric depth + surface normals | Self-host |

### Demos (Spaces)

| Name | Link | What It Does |
|------|------|--------------|
| **Depth Anything V2** | [spaces/depth-anything/Depth-Anything-V2](https://hf.co/spaces/depth-anything/Depth-Anything-V2) | Upload image, get depth map |
| **Depth Anything 3** | [spaces/depth-anything/depth-anything-3](https://hf.co/spaces/depth-anything/depth-anything-3) | Latest DA3 demo |
| **ZoeDepth** | [spaces/shariqfarooq/ZoeDepth](https://hf.co/spaces/shariqfarooq/ZoeDepth) | Metric depth + 3D view from photo |

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| AnyDepth (2026) | [2601.02760](https://hf.co/papers/2601.02760) | Lightweight DINOv3-based depth, compact transformer decoder, zero-shot |
| Depth Anything V2 (2024) | [2406.09414](https://arxiv.org/abs/2406.09414) | Foundation model for relative depth, massive scale |
| Marigold (2023) | [2312.02145](https://arxiv.org/abs/2312.02145) | Diffusion-based depth with fine detail preservation |
| Metric3D v2 (2023) | [2307.10984](https://arxiv.org/abs/2307.10984) | Metric depth + normals from a single image |

### Relevance to Craftmatic
- **ZoeDepth** and **Depth Anything 3 Metric**: Best for getting actual meter-scale depth from Street View images. Can replace/augment AWS Terrarium elevation tiles.
- **Apple DepthPro**: Focal-length-agnostic metric depth -- ideal for Street View where camera intrinsics are unknown.
- **Marigold**: Best edge detail for facade depth, useful for extracting window recesses and architectural relief.

---

## 2. Multi-View 3D Reconstruction (Images to 3D Point Cloud/Mesh)

### Models

| Name | HF Link | Downloads | License | Input | Output | API/Self-Host |
|------|---------|-----------|---------|-------|--------|---------------|
| **Facebook VGGT-1B** | [facebook/VGGT-1B](https://hf.co/facebook/VGGT-1B) | 317K | CC-BY-NC-4.0 | 2+ unposed images | 3D point cloud, depth, cameras | Self-host |
| **Facebook VGGT-1B Commercial** | [facebook/VGGT-1B-Commercial](https://hf.co/facebook/VGGT-1B-Commercial) | 288 | Custom (commercial OK) | 2+ unposed images | 3D point cloud, depth, cameras | Self-host |
| **Naver DUSt3R** | [naver/DUSt3R_ViTLarge_BaseDecoder_512_dpt](https://hf.co/naver/DUSt3R_ViTLarge_BaseDecoder_512_dpt) | 16K | -- | Image pairs | Dense 3D pointmaps | Self-host |
| **Naver MASt3R** | [naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric](https://hf.co/naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric) | 164K | -- | Image pairs | Metric 3D pointmaps + matches | Self-host |
| **Aerial MASt3R** | [kvuong2711/checkpoint-aerial-mast3r](https://hf.co/kvuong2711/checkpoint-aerial-mast3r) | 92 | -- | Aerial+ground pairs | Aerial-ground 3D reconstruction | Self-host |
| **Align3R (DepthPro variant)** | [cyun9286/Align3R_DepthPro_ViTLarge_BaseDecoder_512_dpt](https://hf.co/cyun9286/Align3R_DepthPro_ViTLarge_BaseDecoder_512_dpt) | 38 | -- | Image pairs | 3D alignment with metric depth | Self-host |

### Demos (Spaces)

| Name | Link | What It Does |
|------|------|--------------|
| **Facebook VGGT** | [spaces/facebook/vggt](https://hf.co/spaces/facebook/vggt) | Upload images, get 3D reconstruction (CVPR 2025) |
| **MASt3R + 3DGS** | [spaces/ostapient/mast3r-3dgs](https://hf.co/spaces/ostapient/mast3r-3dgs) | MASt3R reconstruction rendered via 3D Gaussian Splatting |
| **EDGS** | [spaces/CompVis/EDGS](https://hf.co/spaces/CompVis/EDGS) | 3D model from photos or video |
| **Map Anything (Facebook)** | [spaces/facebook/map-anything](https://hf.co/spaces/facebook/map-anything) | Images to 3D models and depth maps |

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| From Orbit to Ground (2025) | [2512.07527](https://hf.co/papers/2512.07527) | City-scale 3D from satellite via 2.5D height maps + differentiable rendering |
| AerialMegaDepth (2025) | [2504.13157](https://hf.co/papers/2504.13157) | Aerial-ground geometric reconstruction, hybrid dataset with 3D city meshes |
| Sat2Scene (2024) | [2401.10786](https://hf.co/papers/2401.10786) | 3D diffusion + neural rendering for scene generation from satellite |
| Sat-DN (2025) | [2502.08352](https://hf.co/papers/2502.08352) | Implicit surface reconstruction from multi-view satellite with depth/normal supervision |
| Sat2Density (2023) | [2303.14672](https://hf.co/papers/2303.14672) | 3D geometry from satellite via density field learning (no depth supervision) |
| S3R-GS (2025) | [2503.08217](https://hf.co/papers/2503.08217) | Efficient large-scale street scene 3DGS reconstruction |

### Datasets

| Name | HF Link | What It Contains |
|------|---------|------------------|
| **AerialMegaDepth** | [datasets/kvuong2711/aerialmegadepth](https://hf.co/datasets/kvuong2711/aerialmegadepth) | Co-registered aerial + ground images with depth, 3D city meshes (gated, CC-BY-NC-ND-4.0) |

### Relevance to Craftmatic
- **VGGT-1B**: Feed 2-4 Street View images of a building from different angles, get a 3D point cloud. Could directly replace procedural generation for buildings with SV coverage.
- **MASt3R**: Metric-scale 3D from image pairs. Pair front+side SV images for building reconstruction.
- **DUSt3R**: Foundation for multi-view reconstruction; MASt3R extends it with metric scale.
- **Aerial MASt3R**: Specifically fine-tuned for satellite-to-ground viewpoint bridging -- directly applicable to satellite+SV fusion.

---

## 3. Building Footprint Segmentation (Satellite Image to Building Polygons)

### Models

| Name | HF Link | Downloads | License | Input | Output | API/Self-Host |
|------|---------|-----------|---------|-------|--------|---------------|
| **YOLOv8m Building Segmentation** | [keremberke/yolov8m-building-segmentation](https://hf.co/keremberke/yolov8m-building-segmentation) | 1.2K | -- | Satellite image tile | Instance segmentation masks | Self-host (ultralytics) |
| **YOLOv8n Building Segmentation** | [keremberke/yolov8n-building-segmentation](https://hf.co/keremberke/yolov8n-building-segmentation) | 635 | -- | Satellite image tile | Instance segmentation masks | Self-host (ultralytics) |
| **Geobase Building Footprint** | [geobase/building-footprint-segmentation](https://hf.co/geobase/building-footprint-segmentation) | 23 | -- | Satellite image tile | Building footprint masks (ONNX) | Self-host (ONNX runtime) |

### Datasets

| Name | HF Link | Size | What It Contains |
|------|---------|------|------------------|
| **Satellite Building Segmentation** | [datasets/keremberke/satellite-building-segmentation](https://hf.co/datasets/keremberke/satellite-building-segmentation) | 9,665 images | Satellite tiles with building polygon labels |
| **China Building Footprints (CMAB)** | [datasets/DannHiroaki/China-Building-Footprints-CMAB-Mirror](https://hf.co/datasets/DannHiroaki/China-Building-Footprints-CMAB-Mirror) | National-scale | Building polygons, heights, roof types, multi-attribute |
| **Morocco Satellite Buildings** | [datasets/tferhan/morocco_satellite_buildings_semantic_segmentation_512_v2](https://hf.co/datasets/tferhan/morocco_satellite_buildings_semantic_segmentation_512_v2) | 1K-10K | 512px tiles with building masks |

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| Pix2Poly (2024) | [2412.07899](https://hf.co/papers/2412.07899) | End-to-end transformer for polygonal building footprints (vector output, not raster) |
| OBMv2 (SAM-based, 2024) | [2408.08645](https://hf.co/papers/2408.08645) | SAM-based building footprint extraction from off-nadir images with offset correction |
| DSAC (2018) | [1803.06329](https://hf.co/papers/1803.06329) | Active contours + CNN for building footprints with geometric priors |
| RSBuilding (2024) | [2403.07564](https://hf.co/papers/2403.07564) | Foundation model for building extraction + change detection, zero-shot generalization |
| GBSS Dataset (2024) | [2401.01178](https://hf.co/papers/2401.01178) | Global Building Semantic Segmentation dataset for cross-region generalization |
| Mask-to-Height (2025) | [2510.27224](https://hf.co/papers/2510.27224) | YOLOv11 joint instance segmentation + height classification from satellite |
| Satellite Sunroof (2024) | [2408.14400](https://hf.co/papers/2408.14400) | Google's DSM + roof segmentation from satellite for solar mapping |
| ControlCity (2024) | [2409.17049](https://hf.co/papers/2409.17049) | Multimodal diffusion model for building footprint generation from VGI data |

### Relevance to Craftmatic
- **YOLOv8 building segmentation**: Fastest option for real-time satellite footprint extraction in browser (convert to ONNX/TFJS). Directly replaces current Canvas-based satellite footprint extraction.
- **Pix2Poly**: Outputs vector polygons instead of raster masks -- could feed directly into generation pipeline without the current flood-fill + PCA OBB heuristic.
- **RSBuilding**: Foundation model approach could handle diverse geographies without per-region training.
- **Mask-to-Height**: Joint segmentation + height = exactly what Craftmatic needs (replaces Mapbox height + separate segmentation).

---

## 4. Building Feature Extraction (Facades, Windows, Doors, Materials)

### Models

| Name | HF Link | Downloads | License | Input | Output | API/Self-Host |
|------|---------|-----------|---------|-------|--------|---------------|
| **Facades Segmentation** | [walup/facades_segmentation](https://hf.co/walup/facades_segmentation) | 0 | -- | Facade image | Semantic segments | Self-host |

### Demos (Spaces)

| Name | Link | What It Does |
|------|------|--------------|
| **Florence-2** | [spaces/gokaygokay/Florence-2](https://hf.co/spaces/gokaygokay/Florence-2) | Multi-task vision: captioning, detection, segmentation. Can detect windows/doors with prompting |
| **YoloV8 Window/Door Detection** | [spaces/Ambrosepp/YoloV8](https://hf.co/spaces/Ambrosepp/YoloV8) | Detect and label windows and doors in building images |
| **Floor Plan Detection** | [spaces/Viraj2307/Floor-Plan-Detection](https://hf.co/spaces/Viraj2307/Floor-Plan-Detection) | Detect rooms, doors, and windows from floor plan images |

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| **OpenFACADES** (2025) | [2504.02866](https://hf.co/papers/2504.02866) | VLM-based multi-attribute building prediction from street-level panoramas. Uses isovist analysis + fine-tuned VLMs for open-vocabulary building feature extraction |
| **Texture2LoD3** (2025) | [2504.05249](https://hf.co/papers/2504.05249) | LoD3 building reconstruction from panoramic images: georeferencing, facade segmentation (windows/doors/walls), watertight geometry generation |
| **Window Detection in CityGML** (2018) | [1812.08095](https://hf.co/papers/1812.08095) | Mask R-CNN for window detection in CityGML texture files |
| **DoorDet** (2025) | [2508.07714](https://hf.co/papers/2508.07714) | Semi-automated multi-class door detection dataset via LLM-assisted labeling |
| **BRAILS** (2019) | [1910.06391](https://hf.co/papers/1910.06391) | City-scale building information modeling from street view: stories, structure type, occupancy, soft-story classification |
| **SYNBUILD-3D** (2025) | [2508.21169](https://hf.co/papers/2508.21169) | Large synthetic dataset of 3D residential buildings at LoD4 with semantic annotations (wireframe, floor plans, roof point clouds) |
| **WAFFLE** (2024) | [2412.00955](https://hf.co/papers/2412.00955) | 20K multimodal floorplan dataset for building understanding via LLMs |

### Relevance to Craftmatic
- **OpenFACADES**: Directly applicable -- uses VLMs on street view panoramas to extract building attributes (materials, windows, doors, stories, age, style). Could replace or augment the current SV color extraction pipeline.
- **Texture2LoD3**: Full pipeline from panoramic images to LoD3 CityGML-style models with facade semantic segmentation. The facade segmentation module could extract window/door positions for generation.
- **Florence-2**: General-purpose vision model that can detect architectural features with text prompting. Runs in-browser via transformers.js.
- **BRAILS**: Purpose-built for building attribute extraction from street view. Classifies structure type, stories, soft-story risk -- maps well to Craftmatic's PropertyData fields.

---

## 5. Roof Type Classification and Analysis

### Models

| Name | HF Link | Downloads | License | Input | Output | API/Self-Host |
|------|---------|-----------|---------|-------|--------|---------------|
| **Roof Classification (ViT)** | [Prahas10/roof_classification](https://hf.co/Prahas10/roof_classification) | 5 | Apache-2.0 | Aerial roof image | Roof type class | HF Inference API |
| **Roof Classification (ViT, alt)** | [nj1867/roof_classification_new_dataset_4_march](https://hf.co/nj1867/roof_classification_new_dataset_4_march) | 2 | Apache-2.0 | Aerial roof image | Roof type class | HF Inference API |

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| **RoofNet** (2025) | [2505.19358](https://hf.co/papers/2505.19358) | Global multimodal dataset for roof **material** classification (satellite + text). Vision-language model with geographic prompt tuning. Also annotates shape, solar panels, HVAC |
| **Intuitive Roof Modeling** (2021) | [2109.07683](https://hf.co/papers/2109.07683) | Graph-based roof modeling for 3D mesh generation. Uses transformers + GCN for roof structure prediction |
| **Satellite Sunroof** (2024) | [2408.14400](https://hf.co/papers/2408.14400) | Google's DSM + roof instance segmentation for solar potential. High-res roof pitch estimation |

### Relevance to Craftmatic
- **RoofNet**: Directly maps to the `roofType` field in Smarty/PropertyData. Vision-language approach means it could classify from satellite OR street view imagery. Covers materials (shingle, tile, metal, etc.) which maps to MaterialPalette.
- **Roof modeling paper**: Graph-based approach for generating 3D roof meshes from 2D outlines -- could replace the procedural `placeRoof()` function with learned roof shapes.
- The existing ViT-based roof classifiers are small community models but demonstrate the approach is viable with fine-tuned transformers.

---

## 6. Building Height Estimation

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| **GlobalBuildingAtlas** (2025) | [2506.04106](https://hf.co/papers/2506.04106) | Open global dataset of building polygons, heights, and LoD1 3D models |
| **Mask-to-Height** (2025) | [2510.27224](https://hf.co/papers/2510.27224) | YOLOv11 joint instance segmentation + categorical height from satellite |
| **Single-View Height Estimation** (2023) | [2304.13214](https://hf.co/papers/2304.13214) | Diffusion model for DSM estimation from single optical satellite image |
| **High-Res Building Detection (Sentinel-2)** (2023) | [2310.11622](https://hf.co/papers/2310.11622) | Student model for building segmentation + height prediction from Sentinel-2 |

### Relevance to Craftmatic
- **GlobalBuildingAtlas**: If released as a dataset, could provide building heights globally, replacing Mapbox height queries.
- **Mask-to-Height**: Single model that outputs both footprint mask and height category -- ideal for replacing the current multi-source height estimation chain (Smarty > OSM > Mapbox > Solar > Parcl).
- **Single-View Height Estimation**: Could estimate building height from a single satellite tile without requiring building databases.

---

## 7. City-Scale 3D Generation

### Models

| Name | HF Link | Likes | License | Input | Output | API/Self-Host |
|------|---------|-------|---------|-------|--------|---------------|
| **CityDreamer** | [hzxie/city-dreamer](https://hf.co/hzxie/city-dreamer) | 8 | Custom | OSM layout / text | Unbounded 3D city (NeRF) | Self-host |

### Demos

| Name | Link | What It Does |
|------|------|--------------|
| **CityDreamer** | [spaces/hzxie/city-dreamer](https://hf.co/spaces/hzxie/city-dreamer) | Generate 3D city from layout |

### Key Papers

| Paper | Link | Summary |
|-------|------|---------|
| **CityDreamer** (2023) | [2309.00610](https://hf.co/papers/2309.00610) | Compositional generative model for unbounded 3D cities, separates buildings from background |
| **CityDreamer4D** (2025) | [2501.08983](https://hf.co/papers/2501.08983) | Extension with dynamic elements (traffic, time-of-day) |
| **Point2Building** (2024) | [2403.02136](https://hf.co/papers/2403.02136) | Autoregressive model: LiDAR point cloud to 3D polygonal building mesh |

### Relevance to Craftmatic
- **CityDreamer**: Could generate context around a target building for more realistic scene composition.
- **Point2Building**: If combined with aerial LiDAR data, could produce high-fidelity building meshes. The autoregressive polygon generation approach is interesting for procedural generation.

---

## Priority Ranking for Craftmatic Integration

### Tier 1 -- High Impact, Feasible Now
1. **Depth Anything V2/V3** (Apache-2.0 Small model): Run on Street View images to get depth maps. Convert to ONNX/TFJS for browser inference. Augments current elevation pipeline.
2. **ZoeDepth** (MIT): Metric depth for actual meter-scale measurements from SV. Can run via HF Inference API.
3. **OpenFACADES approach**: Use a VLM (Florence-2 or similar) on SV panoramas to extract building attributes. Replaces manual color extraction pipeline.

### Tier 2 -- High Impact, Moderate Effort
4. **VGGT-1B / MASt3R**: Multi-view 3D from 2-4 Street View images. Requires GPU backend but produces actual building geometry.
5. **YOLOv8 building segmentation**: Replace satellite footprint canvas extraction with ML model. Can convert to TFJS.
6. **Mask-to-Height (YOLOv11)**: Joint footprint + height from satellite, replacing 3-source height estimation chain.

### Tier 3 -- Research-Stage, High Potential
7. **Pix2Poly**: Vector polygon footprints directly (no raster-to-vector conversion needed).
8. **Texture2LoD3**: Full facade-to-CityGML pipeline. Most complete but requires significant integration work.
9. **RoofNet**: Roof material + type classification from satellite.
10. **CityDreamer**: Contextual city generation for scene composition.

---

## License Summary

| Model | License | Commercial Use |
|-------|---------|----------------|
| Depth Anything V2 Small | Apache-2.0 | Yes |
| Depth Anything V2 Base/Large | CC-BY-NC-4.0 | No |
| DA3 Metric Large | Apache-2.0 | Yes |
| DA3 GIANT/Nested | CC-BY-NC-4.0 | No |
| ZoeDepth | MIT | Yes |
| Intel DPT-Large | Apache-2.0 | Yes |
| Apple DepthPro | Apple AMLR | Restricted |
| Marigold v1.0 | Apache-2.0 | Yes |
| Marigold v1.1 | OpenRAIL++ | Conditional |
| VGGT-1B | CC-BY-NC-4.0 | No |
| VGGT-1B-Commercial | Custom | Yes (with terms) |
| DUSt3R / MASt3R | Unspecified | Check repo |
| YOLOv8 building seg | Unspecified | Check repo |
| Metric3D | BSD-2 | Yes |

---

## Browser-Compatible Options (ONNX / TFJS / WASM)

Models that can potentially run client-side in Craftmatic's SPA:

1. **Depth Anything V2 Small** -- transformers.js compatible, runs in WebGPU
2. **Metric3D (ViT-Small ONNX)** -- already converted to ONNX at [onnx-community/metric3d-vit-small](https://hf.co/onnx-community/metric3d-vit-small)
3. **YOLOv8n building segmentation** -- ultralytics models export to ONNX/TFJS
4. **Geobase building footprint** -- already in ONNX format
5. **Florence-2** -- available via transformers.js for multi-task vision
6. **ViT roof classifiers** -- small enough for browser inference

For larger models (VGGT, MASt3R, DA3-GIANT), a server-side inference endpoint or HF Inference API is required.
