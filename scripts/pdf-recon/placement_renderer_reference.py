"""Independent float64 CPU depth reference and native-PDF renderer audit.

Only PDF-produced runtime poses, native PDF images, and universal CAD enter.
The legacy renderer is preserved. Coplanar surfaces use a documented tolerance.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


def cpu_reference(triangles,colors,width,height,tie_tolerance=1e-7):
    triangles=np.asarray(triangles,dtype=np.float64)
    image=np.full((height,width,3),245,np.uint8)
    depth=np.full((height,width),-np.inf)
    owner=np.full((height,width),-1,int)
    for index,(tri,color) in enumerate(zip(triangles,colors)):
        lo=np.maximum(0,np.ceil(tri[:,:2].min(0)).astype(int))
        hi=np.minimum([width-1,height-1],np.floor(tri[:,:2].max(0)).astype(int))
        if np.any(hi<lo):continue
        a,b,c=tri
        determinant=np.cross(b[:2]-a[:2],c[:2]-a[:2])
        if abs(determinant)<1e-7:continue
        yy,xx=np.mgrid[lo[1]:hi[1]+1,lo[0]:hi[0]+1]
        u=((xx-a[0])*(c[1]-a[1])-(yy-a[1])*(c[0]-a[0]))/determinant
        v=((b[0]-a[0])*(yy-a[1])-(b[1]-a[1])*(xx-a[0]))/determinant
        inside=(u>=-1e-5)&(v>=-1e-5)&(u+v<=1+1e-5)
        z=a[2]+u*(b[2]-a[2])+v*(c[2]-a[2])
        view=depth[lo[1]:hi[1]+1,lo[0]:hi[0]+1]
        take=inside&(z>=view-tie_tolerance)
        view[take]=z[take]
        image[lo[1]:hi[1]+1,lo[0]:hi[0]+1][take]=color
        owner[lo[1]:hi[1]+1,lo[0]:hi[0]+1][take]=index
    return image,owner>=0


class CapturingRasterizer:
    def __init__(self,real):self.real=real
    def render(self,triangles,colors,width,height):
        self.inputs=(triangles.copy(),colors.copy(),width,height)
        return self.real.render(triangles,colors,width,height)


def yellow(rgb,mask):
    hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
    return mask&(hsv[:,:,0]>=15)&(hsv[:,:,0]<=40)&(hsv[:,:,1]>=65)&(hsv[:,:,2]>=85)


def compare(a,am,b,bm):
    common=am|bm
    return dict(mask_iou=float((am&bm).sum()/max(1,common.sum())),
        rgb_agreement_foreground=float(((a==b).all(2)&common).sum()/max(1,common.sum())),
        different_pixels=int(((a!=b).any(2)&common).sum()))


def run(out):
    import pymupdf
    from placement_cuda_triangles import TriangleRasterizer
    from placement_gpu_colored_scene_score import GpuColoredSceneScorer
    from placement_colored_scene_score import ColoredSceneScorer
    from placement_arrow_contacts import read_items
    from placement_colored_cad import _rgb
    from placement_balanced_color_metric import balanced_color_metric
    from vector_scene import scene_images
    from vector_scene_components import component_graph
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    raster=TriangleRasterizer();controls={}
    colors=np.array([[255,0,0],[0,0,255]],np.uint8)
    crossing=np.array([[[2,2,3],[28,2,0],[2,28,3]],[[2,2,0],[28,2,3],[2,28,0]]],np.float32)
    for name,tris in [('crossing',crossing),('coplanar',crossing*np.array([1,1,0])+[0,0,7])]:
        gpu,gm=raster.render(tris[None],colors[None],32,32)
        cpu,cm=cpu_reference(tris,colors,32,32)
        controls[name]=compare(cpu,cm,gpu[0],gm[0])
        assert np.array_equal(cpu,gpu[0]) and np.array_equal(cm,gm[0])
    # Two differently triangulated copies of one slanted plane expose floating
    # near-tie behavior that a constant-depth synthetic cannot exercise.
    square=np.array([[2.,2.],[28.,2.],[28.,28.],[2.,28.]])
    plane=np.column_stack((square,.37*square[:,0]+.19*square[:,1]+3.))
    planar=np.array([plane[[0,1,2]],plane[[0,2,3]],plane[[0,1,3]],plane[[1,2,3]]],np.float32)
    plane_colors=np.array([[255,0,0],[255,0,0],[0,0,255],[0,0,255]],np.uint8)
    stress=[]
    for separation in [0.,.0001,.001,.01]:
        tris=planar.copy();tris[2:,:,2]+=separation
        gpu,gm=raster.render(tris[None],plane_colors[None],32,32)
        cpu,cm=cpu_reference(tris,plane_colors,32,32,tie_tolerance=1e-5)
        stress.append(dict(surface_separation=separation,**compare(cpu,cm,gpu[0],gm[0])))
    # Runtime cache carries PDF source hashes and explicitly no truth input.
    source=Path('output/pdf-placement-beam/40377-gpu-nine-v1')
    record=json.loads((source/'results.json').read_text())
    assert record['pdf_only'] and record['truth_used'] is False
    items=read_items(source/'model.ldr');M=np.asarray(record['results'][0]['projection'])
    doc=pymupdf.open(record['pdf']);scene=scene_images(doc,doc[record['page']])[0]
    scene=dict(scene,mask=component_graph(scene)['components'][0]['mask'])
    scorer=GpuColoredSceneScorer(scene);capture=CapturingRasterizer(scorer.rasterizer);scorer.rasterizer=capture
    gpu_evidence=scorer.score(items,M,out/'gpu.png');gpu=scorer.last_rgb.copy();gm=scorer.last_mask.copy()
    triangles,palette,w,h=capture.inputs
    cpu,cm=cpu_reference(triangles[0],palette[0],w,h)
    cv2.imwrite(str(out/'cpu-reference.png'),cv2.cvtColor(cpu,cv2.COLOR_RGB2BGR))
    legacy=ColoredSceneScorer(scene);legacy.score(items,M,out/'legacy.png')
    old=cv2.cvtColor(cv2.imread(str(out/'legacy.png')),cv2.COLOR_BGR2RGB)
    # Exact legacy background RGB is safe for this CAD output.
    oldmask=(old!=245).any(2)
    allowed=sorted(set(int(c) for p,c,T in items));color_table={c:_rgb(c).tolist() for c in allowed}
    native_yellow=yellow(scene['rgb'],scene['mask']);measurements={}
    for name,image,mask in [('gpu',gpu,gm),('cpu_reference',cpu,cm),('legacy',old,oldmask)]:
        ym=yellow(image,mask)
        measurements[name]=dict(balanced=balanced_color_metric(scene['rgb'],scene['mask'],image,mask,allowed,color_table),
            yellow_pixels=int(ym.sum()),yellow_iou=float((ym&native_yellow).sum()/max(1,(ym|native_yellow).sum())))
    cv2.imwrite(str(out/'native.png'),cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2BGR))
    result=dict(controls=controls,slanted_coplanar_stress=stress,native_pdf=dict(pdf=record['pdf'],page=record['page'],xref=record['xref'],
        runtime_model=str(source/'model.ldr'),truth_used=False,target_yellow_pixels=int(native_yellow.sum()),
        gpu_cpu=compare(gpu,gm,cpu,cm),measurements=measurements),
        reference='Independent float64 barycentric interpolation; coplanar tolerance 1e-7 toward-camera LDU; last triangle wins ties')
    (out/'results.json').write_text(json.dumps(result,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);run(parser.parse_args().out)
