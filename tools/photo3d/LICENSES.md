# Weights and licences used by `tools/photo3d` (BIZ-39 / WP B15, risk R10)

Read from the Hugging Face model cards (`cardData.license` via `https://huggingface.co/api/models/<repo>`) on
2026-11-09. A card's licence field is the uploader's claim, not legal advice; **read the linked licence text before
any public or paid route**. ComfyUI is run only from `C:/git/comfyui-3d` (v0.42.1), never `C:/git/ComfyUI`.

| Weight file (ComfyUI `models/...`) | Role | Source repo | Card licence | Status |
|---|---|---|---|---|
| `diffusion_models/pixal3d_multiview_int8_convrot.safetensors`, `pixal3d_int8_convrot.safetensors` | multi-view / single-view generation | `Comfy-Org/Pixal3D` (repack of `TencentARC/Pixal3D`) | MIT | OK per card; LICENSE file in the upstream repo to be kept with any redistribution |
| `diffusion_models/trellis_2_int8_convrot.safetensors`, `vae/trellis_2_shape_vae_bf16.safetensors`, `vae/trellis_2_texture_vae_bf16.safetensors` | TRELLIS.2 generation and the shape/texture VAEs Pixal3D also uses | `Comfy-Org/TRELLIS.2` (repack of `microsoft/TRELLIS.2-4B`) | MIT | OK per card |
| `background_removal/birefnet.safetensors` | background masks (BiRefNet) | `Comfy-Org/BiRefNet` (repack of `ZhengPeng7/BiRefNet`) | MIT | OK per card |
| `geometry_estimation/moge_2_vitl_normal_fp16.safetensors` | single-photo FOV (MoGe-2) | `Comfy-Org/MoGe` (repack of `Ruicheng/moge-2-vitl-normal`) | MIT | OK per card |
| `clip_vision/dino_v3_L_naf_fp32.safetensors`, `dino_v3_vit_l.safetensors` | image conditioning (DINOv3 ViT-L) | derived from `facebook/dinov3-vitl16-pretrain-lvd1689m` | **`other`: the DINOv3 License** (https://ai.meta.com/resources/models-and-libraries/dinov3-license) | **OPEN: custom licence, not MIT.** The MIT cards above cover the Pixal3D / TRELLIS.2 weights, not the DINOv3 encoder they condition on. Read the licence (commercial use, redistribution, outputs) before any public route. Not read yet. |
| `diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors` | not used by `tools/photo3d` (installed for other work) | `Qwen/Qwen-Image-Edit-2511` | Apache-2.0 | n/a |

## What this means now

- Local, private use (the corpus runs, the benchmark in B16/B17): fine.
- The generated mesh is a local measurement input. It is not shipped, and the photo corpus bytes stay under the
  gitignored `data/byom-corpus/` with their own per-set licences (`BIZ-48`).
- A public or paid photo-to-model route is blocked on the DINOv3 licence reading above, and on the photo
  uploader's rights (plan B section 7).
