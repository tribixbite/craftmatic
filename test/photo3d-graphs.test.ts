/** Pixal3D / TRELLIS.2 prompt graphs ported from pokefit's imageto3d.py (BIZ-39 / WP B15). */
import { describe, it, expect } from 'vitest';
import { generatePrompt, maskPrompt, singlePrompt, parseGenOptions, type ComfyPrompt } from '../tools/photo3d/graphs';

const views = { front: 'a.png', left: 'b.png', back: 'c.png', right: 'd.png' };

function nodesOf(p: ComfyPrompt, cls: string) {
  return Object.values(p).filter((n) => n.class_type === cls);
}

describe('photo3d graphs', () => {
  it('the multi-view graph remeshes with sign_mode solid', () => {
    const p = generatePrompt(views);
    const [remesh] = nodesOf(p, 'RemeshMesh');
    expect(remesh!.inputs['sign_mode']).toBe('solid');
    // "udf" is the template's double-walled skin; it must not appear anywhere.
    expect(JSON.stringify(p)).not.toContain('"udf"');
  });

  it('wires every view into the multi-view conditioning and ends in a saved GLB', () => {
    const p = generatePrompt(views, parseGenOptions({ seed: 7 }), 'photo3d/x');
    const cond = p['cond']!;
    expect(cond.class_type).toBe('Pixal3DMultiViewConditioning');
    for (const v of Object.keys(views)) {
      const ref = cond.inputs[v] as [string, number];
      expect(p[ref[0]]!.class_type).toBe('LoadImage');
      expect(p[ref[0]]!.inputs['image']).toBe(views[v as keyof typeof views]);
    }
    expect(p['save']!.class_type).toBe('Save3DAdvanced');
    expect(p['save']!.inputs['filename_prefix']).toBe('photo3d/x');
    expect(p['s_struct']!.inputs['seed']).toBe(56 + 7);
    expect(p['unet']!.inputs['unet_name']).toBe('pixal3d_multiview_int8_convrot.safetensors');
  });

  it('every node reference points at a node that exists', () => {
    const graphs = [
      generatePrompt(views),
      singlePrompt('p.png'),
      singlePrompt('p.png', parseGenOptions({ model: 'trellis2' })),
      maskPrompt(views),
    ];
    for (const p of graphs) {
      for (const node of Object.values(p)) {
        for (const v of Object.values(node.inputs)) {
          if (Array.isArray(v) && typeof v[0] === 'string') expect(p[v[0]], `dangling ${v[0]}`).toBeDefined();
        }
      }
    }
  });

  it('the mask graph saves one greyscale mask per view', () => {
    const p = maskPrompt({ front: 'a.png', back: 'b.png' });
    expect(nodesOf(p, 'RemoveBackground')).toHaveLength(2);
    expect(p['save_front']!.inputs['filename_prefix']).toBe('photo3d/mask_front');
  });

  it('the single-photo graph uses MoGe + Pixal3D, or TRELLIS.2 without a camera', () => {
    const pix = singlePrompt('p.png');
    expect(pix['cond']!.class_type).toBe('Pixal3DConditioning');
    expect(pix['moge']).toBeDefined();
    expect(pix['unet']!.inputs['unet_name']).toBe('pixal3d_int8_convrot.safetensors');
    const tri = singlePrompt('p.png', parseGenOptions({ model: 'trellis2' }));
    expect(tri['cond']!.class_type).toBe('Trellis2Conditioning');
    expect(tri['moge']).toBeUndefined();
    expect(tri['crop']!.inputs['pad_factor']).toBe(1.0);
    expect(tri['unet']!.inputs['unet_name']).toBe('trellis_2_int8_convrot.safetensors');
    expect(nodesOf(tri, 'RemeshMesh')[0]!.inputs['sign_mode']).toBe('solid');
  });

  it('texture mode swaps PaintMesh for the UV bake chain', () => {
    expect(nodesOf(generatePrompt(views), 'PaintMesh')).toHaveLength(1);
    const p = generatePrompt(views, parseGenOptions({ texture: 2048 }));
    expect(nodesOf(p, 'PaintMesh')).toHaveLength(0);
    expect(nodesOf(p, 'BakeTextureFromVoxel')).toHaveLength(1);
  });

  it('validates options like the source does', () => {
    expect(() => parseGenOptions({ detail: 1500 })).toThrow(/detail/);
    expect(() => parseGenOptions({ sampler: 'ddim' })).toThrow(/sampler/);
    expect(() => parseGenOptions({ faces: 5 })).toThrow(/faces/);
    expect(parseGenOptions({}).remesh).toBe(768);
  });
});
