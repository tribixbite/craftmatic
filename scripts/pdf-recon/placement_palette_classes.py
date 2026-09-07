"""Optional pastel-aware target classes and true CAD material labels.

Known pastel palette colors retain hue. CAD render class identity comes from
triangle material codes, never from shaded RGB. Legacy scorers are unchanged.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


def palette_labels(rgb,mask,palette):
    """Return uint8 class(index+1,0unknown), valid mask; <=254palette entries.

    Hue-bearing palette entries have S>=20; each requires image saturation
    >=max(20,min(65,paletteS/2)) and V>=max(30,paletteV/4).
    The brightness floor suppresses unstable hue in near-black edge pixels.
    Neutral image classes require S<20.
    Neutral-dark target pixels stay unknown unless actual black is allowed.
    """
    palette=np.asarray(palette,np.uint8)
    if not 0<len(palette)<255:raise ValueError('Expected1..254 palette entries')
    ph=cv2.cvtColor(palette[None],cv2.COLOR_RGB2HSV)[0].astype(float)
    hsv=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2HSV).astype(float)
    h,s,v=hsv.transpose(2,0,1);mask=np.asarray(mask,bool);chromatic=ph[:,1]>=20
    labels=np.zeros(mask.shape,np.uint8)
    choices=np.flatnonzero(chromatic)
    if len(choices):
        difference=abs(h[:,:,None]-ph[choices,0]);difference=np.minimum(difference,180-difference)
        minimum=np.maximum(20,np.minimum(65,ph[choices,1]/2))
        bright=np.maximum(30,ph[choices,2]/4)
        difference=np.where((s[:,:,None]>=minimum)&(v[:,:,None]>=bright),difference,np.inf)
        nearest=np.argmin(difference,2);accepted=mask&(difference.min(2)<=20)
        labels[accepted]=choices[nearest[accepted]]+1
    choices=np.flatnonzero(~chromatic);black=bool(np.any((~chromatic)&(ph[:,2]<85)))
    if len(choices):
        distance=abs(v[:,:,None]-ph[choices,2]);nearest=np.argmin(distance,2)
        accepted=mask&(s<20)&((v>=85)|black)
        labels[accepted]=choices[nearest[accepted]]+1
    valid=np.ones(mask.shape,bool) if black else ~(mask&(v<85)&((s<20)|(labels==0)))
    return labels,valid


def material_render(scorer,items,projection):
    """Independent optional label render using actual per-triangle CAD codes.

    Same physical projection, geometry and bbox-center origin as GPU scorer;
    returns explicit color order, per-pixel material labels and mask.
    """
    M=np.asarray(projection,float);colors=sorted(set(int(c) for p,c,T in items));parts=[];lo=[];hi=[]
    for p,c,T in items:
        d=scorer._project_part(p,c,T,M);off=M@T[:3,3]
        parts.append((p,c,T,d,off));lo.append(d['lo']+off);hi.append(d['hi']+off)
    origin=scorer.target_center-(np.min(lo,0)+np.max(hi,0))/2
    triangles=[];paint=[]
    for p,c,T,d,off in parts:
        xy=d['xy']+off+origin;z=d['vertex_depth']+d['camera']@T[:3,3]
        triangles.append(np.concatenate((xy,z[:,:,None]),2))
        codes=scorer.geometry[(p,str(c))]['colors'];rgb=np.zeros((len(codes),3),np.uint8)
        for index,color in enumerate(colors):rgb[codes==color,0]=index+1
        paint.append(rgb)
    from placement_cuda_planes import PlaneTriangleRasterizer
    raster=PlaneTriangleRasterizer()
    rgb,mask=raster.render(np.concatenate(triangles)[None],np.concatenate(paint)[None],scorer.rgb.shape[1],scorer.rgb.shape[0])
    labels=np.where(mask[0],rgb[0,:,:,0],0).astype(np.uint8)
    return dict(labels=labels,mask=mask[0],colors=colors,image_origin=origin.tolist(),
        protocol='Actual visible CAD triangle material ID; no shaded-RGB reclassification')


def diagnostic(out):
    import pymupdf
    from vector_scene import scene_images
    from placement_colored_cad import _rgb,nativecolor_render
    from placement_arrow_mask import conservative_components,protected_cad_colors
    from placement_layer_pair_screen import classify
    from placement_gpu_colored_scene_score import GpuColoredSceneScorer
    from placement_part_library import PartLibrary
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    colors=[29,71,15,322];palette=np.stack([_rgb(c) for c in colors]).astype(np.uint8)
    pixels=np.array([[[228,173,200],[255,153,204],[169,169,169],[255,255,255],[62,194,221],[40,40,40]]],np.uint8)
    labs,valid=palette_labels(pixels,np.ones(pixels.shape[:2],bool),palette)
    assert labs.tolist()==[[1,1,2,3,4,0]] and not valid[0,-1]
    doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf');native=[]
    available=[('3003',29),('3003',322),('4032a',72),('4032b',72)]
    protected=protected_cad_colors(available);codes=[29,72,322];pal=np.stack([_rgb(c) for c in codes]).astype(np.uint8)
    for scene in scene_images(doc,doc[13]):
        graph=conservative_components(scene,protected['rgb']);mask=graph['clean_mask']
        old,_=classify(scene['rgb'],mask,pal);new,_=palette_labels(scene['rgb'],mask,pal)
        native.append(dict(xref=scene['xref'],old_counts={str(c):int((old==i+1).sum()) for i,c in enumerate(codes)},
            pastel_counts={str(c):int((new==i+1).sum()) for i,c in enumerate(codes)}))
    # Known universal white/gray materials remain their original material
    # classes on every visible face, including darkly shaded white sides.
    T=np.eye(4);other=T.copy();other[0,3]=100
    items=[('3001',15,T),('3001',71,other)];M=np.array([[1.,0,-1.],[.5,1,.5]])
    rendered=nativecolor_render(items,M,out/'synthetic-material-target.png',resolver=PartLibrary().resolve)
    scorer=GpuColoredSceneScorer(rendered,plane_depth=True);scorer.score(items,M,out/'shaded.png')
    materials=material_render(scorer,items,M)
    matpalette=np.stack([_rgb(c) for c in materials['colors']]).astype(np.uint8)
    shaded,_=classify(scorer.last_rgb,scorer.last_mask,matpalette)
    white=materials['colors'].index(15)+1;gray=materials['colors'].index(71)+1
    mistaken=int(((materials['labels']==white)&(shaded==gray)).sum())
    assert mistaken>0
    record=dict(synthetic_pastel_classes=labs.tolist(),dark_unknown=not bool(valid[0,-1]),
        native=native,material_control=dict(visible_white_material_pixels=int((materials['labels']==white).sum()),
            white_material_pixels_misclassified_gray_from_shading=mistaken,
            exact_material_labels=True),truth_used=False,legacy_scorers_changed=False,
        limitations=['Target white versus gray remains ambiguous under lighting; material labels only fix the CAD side.',
            'Pastel thresholds are deterministic color heuristics, not sensor-calibrated reflectance inference.'])
    (out/'results.json').write_text(json.dumps(record,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);diagnostic(p.parse_args().out)
