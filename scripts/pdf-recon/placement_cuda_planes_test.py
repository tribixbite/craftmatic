"""Bounded opt-in plane-depth controls; no external pose truth."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from placement_cuda_planes import PlaneTriangleRasterizer
from placement_cuda_triangles import TriangleRasterizer
from placement_renderer_reference import cpu_reference,compare


def score_inputs(scorer,items,M):
    parts=[];lo=[];hi=[]
    for p,c,T in items:
        data=scorer._project_part(p,c,T,M);offset=M@T[:3,3]
        parts.append((data,offset,float(data['camera']@T[:3,3])))
        lo.append(data['lo']+offset);hi.append(data['hi']+offset)
    origin=scorer.target_center-(np.min(lo,axis=0)+np.max(hi,axis=0))/2
    xy=np.concatenate([d['xy']+off+origin for d,off,z in parts])
    depth=np.concatenate([d['vertex_depth']+z for d,off,z in parts])
    colors=np.concatenate([d['shaded'] for d,off,z in parts])
    return np.concatenate((xy,depth[:,:,None]),axis=2)[None],colors[None]


def run(out):
    import pymupdf
    from placement_gpu_colored_scene_score import GpuColoredSceneScorer
    from placement_arrow_contacts import read_items
    from vector_scene import scene_images
    from vector_scene_components import component_graph
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    plane=PlaneTriangleRasterizer();old=TriangleRasterizer()
    square=np.array([[2.,2.],[28.,2.],[28.,28.],[2.,28.]])
    vertices=np.column_stack((square,.37*square[:,0]+.19*square[:,1]+3.))
    tris=np.array([vertices[[0,1,2]],vertices[[0,2,3]],vertices[[0,1,3]],vertices[[1,2,3]]])
    colors=np.array([[255,0,0],[255,0,0],[0,0,255],[0,0,255]],np.uint8)
    tests=[]
    for separation in [0.,.0001,.001,.01]:
        t=tris.copy();t[2:,:,2]+=separation
        rgb,mask=plane.render(t[None],colors[None],32,32)
        cpu,cm=cpu_reference(t,colors,32,32,tie_tolerance=1e-8)
        evidence=compare(cpu,cm,rgb[0],mask[0]);tests.append(dict(separation=separation,**evidence))
        assert evidence['different_pixels']==0
    crossing=np.array([[[2,2,3],[28,2,0],[2,28,3]],[[2,2,0],[28,2,3],[2,28,0]]],float)
    crossing_colors=colors[[0,2]]
    cr,cm=plane.render(crossing[None],crossing_colors[None],32,32)
    ref,rm=cpu_reference(crossing,crossing_colors,32,32)
    crossing_result=compare(ref,rm,cr[0],cm[0]);assert crossing_result['different_pixels']==0
    source=Path('output/pdf-placement-beam/40377-gpu-nine-v1')
    record=json.loads((source/'results.json').read_text());assert record['pdf_only'] and not record['truth_used']
    items=read_items(source/'model.ldr');M=np.asarray(record['results'][0]['projection'])
    doc=pymupdf.open(record['pdf']);scene=scene_images(doc,doc[record['page']])[0]
    scene=dict(scene,mask=component_graph(scene)['components'][0]['mask'])
    scorer=GpuColoredSceneScorer(scene);scorer.score(items,M)
    original_rgb=scorer.last_rgb.copy();original_mask=scorer.last_mask.copy()
    t,c=score_inputs(scorer,items,M);h,w=scene['mask'].shape
    rgb,mask=plane.render(t,c,w,h);ref,rm=cpu_reference(t[0],c[0],w,h)
    native_reference=compare(ref,rm,rgb[0],mask[0]);native_legacy=compare(original_rgb,original_mask,rgb[0],mask[0])
    integrated=GpuColoredSceneScorer(scene,plane_depth=True)
    integrated_evidence=integrated.score(items,M)
    integrated_exact=np.array_equal(rgb[0],integrated.last_rgb) and np.array_equal(mask[0],integrated.last_mask)
    assert integrated_exact
    cv2.imwrite(str(out/'native-plane.png'),cv2.cvtColor(rgb[0],cv2.COLOR_RGB2BGR))
    G=np.array([[0.,0.,1.],[0.,1.,0.],[-1.,0.,0.]])
    rotated=[]
    for p,c,pose in items:
        T=pose.copy();T[:3,:3]=G@pose[:3,:3];T[:3,3]=G@pose[:3,3];rotated.append((p,c,T))
    gt,gc=score_inputs(scorer,rotated,M@G.T)
    gauge,gm=plane.render(gt,gc,w,h)
    gauge_exact=np.array_equal(rgb,gauge) and np.array_equal(mask,gm)
    result=dict(coplanar_and_separated=tests,crossing=crossing_result,native_cpu_reference=native_reference,
        native_existing_mode=native_legacy,gauge_exact=gauge_exact,truth_used=False,
        integrated_scorer_exact=integrated_exact,integrated_evidence=integrated_evidence,
        requirement='Original float64 projected triangles; scorer rounding to float32 must be bypassed for this optional mode')
    (out/'results.json').write_text(json.dumps(result,indent=2))
    assert gauge_exact


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);run(p.parse_args().out)
