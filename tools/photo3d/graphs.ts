/**
 * ComfyUI API prompt graphs for photos -> 3D (BIZ-39 / WP B15). Ported from pokefit `imageto3d.py`:
 * `mask_prompt`, `_pixal3d_chain`, `generate_prompt`, `single_prompt`, and the `GenOptions` validation.
 *
 * Node classes come from ComfyUI >= 0.42's native TRELLIS.2 / Pixal3D nodes (`comfy_extras/nodes_trellis2.py`).
 * The remesh uses `sign_mode: "solid"`, not the template's "udf": UDF leaves a double-walled skin, while a
 * global inside/outside cut gives ONE watertight solid.
 */

/** A reference to another node's output: [node id, output slot]. */
export type NodeRef = [string, number];

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/** An API-format prompt: node id to node. */
export type ComfyPrompt = Record<string, ComfyNode>;

/** Pixal3D's view order; the first given view is the front. */
export const VIEWS = ['front', 'left', 'back', 'right'] as const;
export type ViewName = (typeof VIEWS)[number];

export const FRAME = 1024;
export const PAD = 1.1;
/** Horizontal FOV of Pixal3D's rig cameras, degrees. */
export const FOV_DEG = 20.0;
export const DEFAULT_FACES = 200_000;

/** KSampler samplers offered for the flow-matching stages (euler is the template's; the rest apply to flow models unchanged). */
export const SAMPLERS = ['euler', 'euler_ancestral', 'heun', 'dpmpp_2m'] as const;

// Weights by ComfyUI/models/<folder>. Licences are recorded in LICENSES.md.
export const MODEL = 'pixal3d_multiview_int8_convrot.safetensors'; // diffusion_models/ (int8: fits 16 GB)
export const MODEL_SINGLE = 'pixal3d_int8_convrot.safetensors'; // diffusion_models/ (one photo, any angle)
export const MOGE_MODEL = 'moge_2_vitl_normal_fp16.safetensors'; // geometry_estimation/: the photo's FOV
export const MODEL_TRELLIS2 = 'trellis_2_int8_convrot.safetensors'; // diffusion_models/
export const CLIP_TRELLIS2 = 'dino_v3_vit_l.safetensors'; // clip_vision/
export const CLIP = 'dino_v3_L_naf_fp32.safetensors'; // clip_vision/
export const VAE_SHAPE = 'trellis_2_shape_vae_bf16.safetensors'; // vae/
export const VAE_TEXTURE = 'trellis_2_texture_vae_bf16.safetensors'; // vae/
export const BG_MODEL = 'birefnet.safetensors'; // background_removal/

/** Generation settings (the ComfyUI nodes' inputs). Defaults are the template's sampler settings with pokefit's remesh. */
export interface GenOptions {
  /** Another seed = another plausible shape from the same photos. */
  seed: number;
  /** Triangles kept (DecimateMesh). Vertex colours live on vertices, so more faces keep finer colour. */
  faces: number;
  /** Shape upsampling resolution, 1024-1536 step 128 (Trellis2UpsampleStage). */
  detail: number;
  /** Watertight remesh grid, 256-2048. */
  remesh: number;
  /** Taubin smoothing passes after the remesh, 0-20. */
  smooth: number;
  /** Sampler steps multiplier (12 per stage, upstream's), 0.5-3. */
  steps: number;
  /** One photo only: "pixal3d" (pixel-aligned) or "trellis2". Several views always use Pixal3D. */
  model: 'pixal3d' | 'trellis2';
  /** 0: colour per vertex (PaintMesh); 512-8192: UV-unwrap and bake a texture of this size. */
  texture: number;
  /** CFG of the structure / shape / upsample samplers, 1-15. */
  guidance: number;
  /** CFG of the colour sampler, 1-10 (1 = no guidance). */
  texGuidance: number;
  /** ModelSamplingSD3 shift of the structure sampler, 1-10. */
  shift: number;
  sampler: (typeof SAMPLERS)[number];
  /** RemeshMesh drop_small_components: loose pieces under this share of the largest are removed, 0-0.2. */
  minPiece: number;
}

export const DEFAULT_OPTIONS: GenOptions = {
  seed: 0,
  faces: DEFAULT_FACES,
  detail: 1536,
  remesh: 768,
  smooth: 20,
  steps: 1.0,
  model: 'pixal3d',
  texture: 0,
  guidance: 7.5,
  texGuidance: 1.0,
  shift: 5.0,
  sampler: 'euler',
  minPiece: 0.01,
};

/** Merge `partial` over the defaults and validate every range as pokefit's `GenOptions.__post_init__` does. */
export function parseGenOptions(partial: Partial<Record<keyof GenOptions, unknown>> = {}): GenOptions {
  const o: GenOptions = { ...DEFAULT_OPTIONS };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || v === null || !(k in DEFAULT_OPTIONS)) continue;
    (o as unknown as Record<string, unknown>)[k] = v;
  }
  for (const k of ['seed', 'faces', 'detail', 'remesh', 'smooth', 'texture'] as const) o[k] = Math.trunc(Number(o[k]));
  for (const k of ['steps', 'guidance', 'texGuidance', 'shift', 'minPiece'] as const) o[k] = Number(o[k]);
  const range = (name: string, v: number, lo: number, hi: number): void => {
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be ${lo}..${hi}`);
  };
  if (o.model !== 'pixal3d' && o.model !== 'trellis2') throw new Error('model must be pixal3d or trellis2');
  if (!(SAMPLERS as readonly string[]).includes(o.sampler)) throw new Error(`sampler must be one of ${SAMPLERS.join(', ')}`);
  range('guidance', o.guidance, 1, 15);
  range('texGuidance', o.texGuidance, 1, 10);
  range('shift', o.shift, 1, 10);
  range('minPiece', o.minPiece, 0, 0.2);
  if (o.texture && (o.texture < 512 || o.texture > 8192)) throw new Error('texture must be 0 (vertex colours) or 512..8192');
  if (o.detail < 1024 || o.detail > 1536 || o.detail % 128) throw new Error('detail must be 1024..1536 in steps of 128');
  range('remesh', o.remesh, 256, 2048);
  range('smooth', o.smooth, 0, 20);
  range('faces', o.faces, 10_000, 2_000_000);
  range('steps', o.steps, 0.5, 3);
  return o;
}

/** BiRefNet masks of uploaded photos, saved as greyscale PNGs (one SaveImage per view). */
export function maskPrompt(images: Record<string, string>, prefix = 'photo3d'): ComfyPrompt {
  const p: ComfyPrompt = { bg: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: BG_MODEL } } };
  for (const [v, name] of Object.entries(images)) {
    p[`load_${v}`] = { class_type: 'LoadImage', inputs: { image: name } };
    p[`mask_${v}`] = { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bg', 0], image: [`load_${v}`, 0] } };
    p[`img_${v}`] = { class_type: 'MaskToImage', inputs: { mask: [`mask_${v}`, 0] } };
    p[`save_${v}`] = {
      class_type: 'SaveImage',
      inputs: { images: [`img_${v}`, 0], filename_prefix: `${prefix}/mask_${v}` },
    };
  }
  return p;
}

/**
 * Add the Pixal3D sampling chain after a conditioning node `cond` (positive 0, negative 1): the templates'
 * sampler settings (seeds offset by `opts.seed`, steps scaled by `opts.steps`), then RemeshMesh (solid) ->
 * DecimateMesh -> PaintMesh (or the texture bake) -> GLB (node `save`).
 */
function pixal3dChain(p: ComfyPrompt, model: string, opts: GenOptions, prefix: string, clip: string = CLIP): ComfyPrompt {
  const { seed, guidance: g } = opts;
  const n = (steps: number): number => Math.max(4, Math.round(steps * opts.steps));
  const ks = (
    modelNode: string,
    pos: NodeRef,
    neg: NodeRef,
    latent: NodeRef,
    s: number,
    steps: number,
    cfg: number,
    scheduler: string,
  ): ComfyNode => ({
    class_type: 'KSampler',
    inputs: {
      model: [modelNode, 0],
      seed: s,
      steps,
      cfg,
      sampler_name: opts.sampler,
      scheduler,
      positive: pos,
      negative: neg,
      latent_image: latent,
      denoise: 1.0,
    },
  });

  Object.assign(p, {
    clip: { class_type: 'CLIPVisionLoader', inputs: { clip_name: clip } },
    vae_shape: { class_type: 'VAELoader', inputs: { vae_name: VAE_SHAPE } },
    vae_tex: { class_type: 'VAELoader', inputs: { vae_name: VAE_TEXTURE } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    // CFG override and rescale match the original pipeline's defaults (template note).
    cfg_struct: { class_type: 'CFGOverride', inputs: { model: ['unet', 0], cfg: 1.0, start_percent: 0.667, end_percent: 1.0 } },
    cfg_shape: { class_type: 'CFGOverride', inputs: { model: ['unet', 0], cfg: 1.0, start_percent: 0.769, end_percent: 1.0 } },
    rescale_struct: { class_type: 'RescaleCFG', inputs: { model: ['cfg_struct', 0], multiplier: 0.7 } },
    rescale_shape: { class_type: 'RescaleCFG', inputs: { model: ['cfg_shape', 0], multiplier: 0.5 } },
    sampling: { class_type: 'ModelSamplingSD3', inputs: { model: ['rescale_struct', 0], shift: opts.shift } },
    empty: { class_type: 'EmptyTrellis2LatentStructure', inputs: { batch_size: 1 } },
  } satisfies ComfyPrompt);
  p['s_struct'] = ks('sampling', ['cond', 0], ['cond', 1], ['empty', 0], 56 + seed, n(12), g, 'normal');
  p['structure'] = {
    class_type: 'VaeDecodeStructureTrellis2',
    inputs: { samples: ['s_struct', 0], vae: ['vae_shape', 0], resolution: '32' },
  };
  p['shape_stage'] = {
    class_type: 'Trellis2ShapeStage',
    inputs: { positive: ['cond', 0], negative: ['cond', 1], voxel: ['structure', 0] },
  };
  // 12 steps: TRELLIS.2-4B pipeline.json and Pixal3D inference_mv.py (the ComfyUI template has 20).
  p['s_shape'] = ks('rescale_shape', ['shape_stage', 0], ['shape_stage', 1], ['shape_stage', 2], 42 + seed, n(12), g, 'normal');
  p['upsample'] = {
    class_type: 'Trellis2UpsampleStage',
    inputs: {
      positive: ['shape_stage', 0],
      negative: ['shape_stage', 1],
      shape_latent: ['s_shape', 0],
      vae: ['vae_shape', 0],
      target_resolution: opts.detail,
    },
  };
  p['s_up'] = ks('rescale_shape', ['upsample', 0], ['upsample', 1], ['upsample', 2], 42 + seed, n(12), g, 'simple');
  p['shape'] = { class_type: 'VaeDecodeShapeTrellis', inputs: { samples: ['s_up', 0], vae: ['vae_shape', 0] } };
  p['tex_stage'] = {
    class_type: 'Trellis2TextureStage',
    inputs: { positive: ['upsample', 0], negative: ['upsample', 1], shape_latent: ['s_up', 0] },
  };
  p['s_tex'] = ks('unet', ['tex_stage', 0], ['tex_stage', 1], ['tex_stage', 2], 43 + seed, n(12), opts.texGuidance, 'normal');
  p['texture'] = {
    class_type: 'VaeDecodeTextureTrellis',
    inputs: { samples: ['s_tex', 0], vae: ['vae_tex', 0], shape_subdivides: ['shape', 1] },
  };
  // "solid" (not the template's "udf"): one watertight solid, not a double-walled skin.
  p['remesh'] = {
    class_type: 'RemeshMesh',
    inputs: {
      mesh: ['shape', 0],
      resolution: opts.remesh,
      sign_mode: 'solid',
      'sign_mode.fill': 20.0,
      'sign_mode.qef': false,
      band: 1.0,
      project_back: 0.0,
      fix_poles: false,
      smooth_iters: opts.smooth,
      drop_small_components: opts.minPiece,
      precluster_max_verts: 20_000_000,
    },
  };
  p['decimate'] = {
    class_type: 'DecimateMesh',
    inputs: { mesh: ['remesh', 0], target_face_count: opts.faces, placement_mode: 'midpoint' },
  };
  if (opts.texture) {
    // UV atlas on the final mesh, colour baked from the voxels at each texel's nearest point of the
    // full-detail decoded shape (not the smoothed, decimated one).
    p['unwrap'] = {
      class_type: 'UnwrapMesh',
      inputs: { mesh: ['decimate', 0], segmenter: 'pec', resolution: opts.texture, padding: 2, weld_distance: 0.0 },
    };
    p['bake'] = {
      class_type: 'BakeTextureFromVoxel',
      inputs: { mesh: ['unwrap', 0], voxel_colors: ['texture', 0], texture_size: opts.texture, reference_mesh: ['shape', 0] },
    };
    p['paint'] = { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['unwrap', 0], base_color: ['bake', 0] } };
  } else {
    p['paint'] = { class_type: 'PaintMesh', inputs: { mesh: ['decimate', 0], voxel_colors: ['texture', 0] } };
  }
  p['glb'] = { class_type: 'MeshToFile3D', inputs: { mesh: ['paint', 0] } };
  p['save'] = {
    class_type: 'Save3DAdvanced',
    inputs: { model_3d: ['glb', 0], filename_prefix: prefix, viewport_state: '', width: 1024, height: 1024 },
  };
  return p;
}

/** The Pixal3D multi-view template as an API prompt: framed rig views -> GLB. `views` maps view name to an uploaded image name. */
export function generatePrompt(
  views: Record<string, string>,
  opts: GenOptions = DEFAULT_OPTIONS,
  prefix = 'photo3d/model',
  fov: number = FOV_DEG,
): ComfyPrompt {
  const cond: ComfyNode = {
    class_type: 'Pixal3DMultiViewConditioning',
    inputs: { clip_vision_model: ['clip', 0], fov },
  };
  const p: ComfyPrompt = { cond };
  for (const [v, name] of Object.entries(views)) {
    p[`view_${v}`] = { class_type: 'LoadImage', inputs: { image: name } };
    cond.inputs[v] = [`view_${v}`, 0];
  }
  return pixal3dChain(p, MODEL, opts, prefix);
}

/**
 * One photo from any angle -> GLB, as the template "Pixal3D & TRELLIS.2: Image to Model": BiRefNet mask, crop
 * to it (pad 1.1), MoGe-2 estimates the crop's horizontal FOV, single-view Pixal3D (or TRELLIS.2). The mesh is
 * posed as the photo shows it.
 */
export function singlePrompt(photo: string, opts: GenOptions = DEFAULT_OPTIONS, prefix = 'photo3d/model'): ComfyPrompt {
  const crop = (images: NodeRef, pad: number): ComfyNode => ({
    class_type: 'ImageCropToMask',
    inputs: { images, masks: ['mask', 0], width: FRAME, height: FRAME, pad_factor: pad, grow_mask: 0, background: '#000000' },
  });
  const p: ComfyPrompt = {
    load: { class_type: 'LoadImage', inputs: { image: photo } },
    bg: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: BG_MODEL } },
    mask: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bg', 0], image: ['load', 0] } },
    crop: crop(['load', 0], PAD),
    moge: { class_type: 'LoadMoGeModel', inputs: { model_name: MOGE_MODEL } },
    geometry: {
      class_type: 'MoGeInference',
      inputs: {
        moge_model: ['moge', 0],
        image: ['crop', 0],
        resolution_level: 9,
        fov_x_degrees: 0.0,
        batch_size: 4,
        force_projection: true,
        apply_mask: true,
        refine_steps: 3,
      },
    },
    fov: {
      class_type: 'MoGeGeometryToFOV',
      inputs: { moge_geometry: ['geometry', 0], axis: 'horizontal', unit: 'degrees' },
    },
    cond: {
      class_type: 'Pixal3DConditioning',
      inputs: { clip_vision_model: ['clip', 0], image: ['crop', 0], camera_angle_x: ['fov', 0] },
    },
    mask_img: { class_type: 'MaskToImage', inputs: { mask: ['mask', 0] } },
    mask_crop: crop(['mask_img', 0], PAD),
    save_crop: { class_type: 'SaveImage', inputs: { images: ['crop', 0], filename_prefix: `${prefix}_crop` } },
    save_mask: { class_type: 'SaveImage', inputs: { images: ['mask_crop', 0], filename_prefix: `${prefix}_mask` } },
    show_fov: { class_type: 'PreviewAny', inputs: { source: ['fov', 0] } },
  };
  if (opts.model === 'trellis2') {
    // TRELLIS.2: its own conditioning, the crop unpadded (the node's note), no camera (so no MoGe FOV).
    for (const k of ['moge', 'geometry', 'fov', 'show_fov']) delete p[k];
    p['crop']!.inputs['pad_factor'] = 1.0;
    p['mask_crop']!.inputs['pad_factor'] = 1.0;
    p['cond'] = { class_type: 'Trellis2Conditioning', inputs: { clip_vision_model: ['clip', 0], image: ['crop', 0] } };
    return pixal3dChain(p, MODEL_TRELLIS2, opts, prefix, CLIP_TRELLIS2);
  }
  return pixal3dChain(p, MODEL_SINGLE, opts, prefix);
}
