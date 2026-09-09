"""Optional pastel-aware target classes and true CAD material labels.

Known pastel palette colors retain hue. CAD render class identity comes from
triangle material codes, never from shaded RGB. Legacy scorers are unchanged.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


NEUTRAL_CHANNEL_SPREAD=30

# Process-wide defaults, so one driver flag settles the classifier for every
# consumer at once. The classifier is shared by the coarse target, the
# undrawn-colour rule and the camera gate, and those three must agree about
# which class a pixel is: turning something on for one of them would produce a
# run that contradicts itself. Callers that pass an explicit value still win.
SATURATION_TIEBREAK=0.
CHROMATIC_METRIC='hue'


def palette_labels(rgb,mask,palette,neutral_spread=NEUTRAL_CHANNEL_SPREAD,saturation_tiebreak=None,
                   chromatic_metric=None):
    """Return uint8 class(index+1,0unknown), valid mask; <=254palette entries.

    Hue-bearing palette entries are those whose RGB channels spread by more than
    `neutral_spread`; each requires image saturation
    >=max(20,min(65,paletteS/2)) and V>=max(30,paletteV/4).
    The brightness floor suppresses unstable hue in near-black edge pixels.
    Neutral image classes require S<20.
    Neutral-dark target pixels stay unknown unless actual black is allowed.

    Neutrality is decided on the channel spread rather than HSV saturation
    because saturation is unstable at low value, and LDraw black #05131D is the
    case that matters: its channels differ by only 24 levels, but at V=29 that
    reads as S=211, so it was treated as a hue. Two consequences, both measured
    on 40377 page index 17, whose drawing puts a black 4x4 round plate on the
    head: the "actual black is allowed" flag never fired, so every dark neutral
    target pixel was excluded as invalid, and the black class matched only
    pixels with S>=105, which drawn black (median S of 0) never has. The class-0
    target was 629 pixels where the plate covers about 12,700, so *placing* the
    correct black plate rendered 4,581 class-0 pixels against that stub target
    for an IoU of 0.0105, while hiding the plate scored 0.0576 - and the search
    duly hid it. With the spread rule the class-0 target is 12,695 pixels, the
    correct assembly's class-0 IoU is 0.3353, and the correct assembly outscores
    the hiding one (0.5411 against 0.5215) where before it lost (0.5570 against
    0.5699). Hue-bearing colours are unaffected: blue, red, tan, yellow, pink
    and azure all spread by 55 to 192 levels, while black, white and the two
    greys spread by 0 to 24.

    Saved scores from before this fix are not comparable with scores after it.

    `saturation_tiebreak` is opt-in and defaults to the module-level
    `SATURATION_TIEBREAK`, which is off, so nothing changes unless it is asked
    for - and asking for it once settles it for every consumer of the
    classifier at the same time, which is the only coherent way to ask. It adds that multiple of the saturation difference to
    the hue distance, which only orders palette entries the hue test has already
    made equal. It exists because hue is currently the sole discriminator among
    chromatic entries, and two LDraw colours can share one: 19 (Tan) and 191
    (Bright Light Orange) both convert to hue 20, so `argmin` decides between
    them by palette position. Turning it on changes classifications and therefore
    scores; before-and-after numbers are not comparable, exactly as for the
    neutral-spread fix above.

    `chromatic_metric='lab'` replaces hue with CIE Lab nearest neighbour, and
    subsumes the tie-break: the hue collision is not one unlucky pair. 40377
    collides 19 and 191 at hue 20; 41624 has four colours inside nine hue
    degrees covering 25 of its 109 parts, and the bias inverts between the two
    fixtures because the commoner colour differs. A weight tuned on one pair
    cannot fix a cluster, and 14 and 191 are not separable in HSV at all, while
    Lab separates every pair in that cluster by at least 16.7.

    It is applied to the ORDERING only, exactly like the tie-break, and for the
    same reason: acceptance stays the 20-degree hue test and the saturation and
    brightness gates are untouched, so the same pixels are classified as before
    and only *which* class each gets can change. A full Lab acceptance rule
    would also move the accept/refuse boundary that the containment and camera
    gates are calibrated against, which is a different change wearing this one's
    name, and it is not adopted here.
    """
    saturation_tiebreak=SATURATION_TIEBREAK if saturation_tiebreak is None else saturation_tiebreak
    chromatic_metric=CHROMATIC_METRIC if chromatic_metric is None else chromatic_metric
    if chromatic_metric not in ('hue','lab'):raise ValueError('Unknown chromatic metric')
    palette=np.asarray(palette,np.uint8)
    if not 0<len(palette)<255:raise ValueError('Expected1..254 palette entries')
    if neutral_spread<0:raise ValueError('Neutral channel spread must be nonnegative')
    if saturation_tiebreak<0:raise ValueError('Saturation tie-break weight must be nonnegative')
    ph=cv2.cvtColor(palette[None],cv2.COLOR_RGB2HSV)[0].astype(float)
    hsv=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2HSV).astype(float)
    h,s,v=hsv.transpose(2,0,1);mask=np.asarray(mask,bool)
    chromatic=(palette.max(1).astype(int)-palette.min(1).astype(int))>neutral_spread
    labels=np.zeros(mask.shape,np.uint8)
    choices=np.flatnonzero(chromatic)
    if len(choices):
        difference=abs(h[:,:,None]-ph[choices,0]);difference=np.minimum(difference,180-difference)
        minimum=np.maximum(20,np.minimum(65,ph[choices,1]/2))
        bright=np.maximum(30,ph[choices,2]/4)
        difference=np.where((s[:,:,None]>=minimum)&(v[:,:,None]>=bright),difference,np.inf)
        order=difference
        if chromatic_metric=='lab':
            # Ordering only: `difference` still decides acceptance below, and
            # the infinities it carries are the saturation and brightness gates,
            # so an entry this pixel is not eligible for stays ineligible.
            pl=cv2.cvtColor(palette[None],cv2.COLOR_RGB2LAB)[0].astype(float)[choices]
            il=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2LAB).astype(float)
            distance=np.sqrt(((il[:,:,None,:]-pl[None,None,:,:])**2).sum(3))
            order=np.where(np.isfinite(difference),distance,np.inf)
        elif saturation_tiebreak:
            # Hue alone cannot separate two palette entries that share one, and
            # argmin then resolves a perfect tie by lower palette index - so which
            # colour wins is decided by the order of the list passed in. LDraw 19
            # (Tan) and 191 (Bright Light Orange) both convert to hue 20, and on
            # 40377 page 26 that hands all 12,353 of the drawing's orange pixels
            # to tan under a numerically sorted palette and all 12,236 back to
            # orange under an allocated-first one. Saturation separates them
            # cleanly (78 against 192), so it breaks the tie here.
            #
            # Applied to the ORDERING only, never to acceptance. Adding it to the
            # accepted distance as well would tighten the 20-degree test as a
            # side effect - measured on page 26 that pushed 182 pink pixels and
            # two others into unclassified, which is a different change wearing
            # this one's name. With this split the unclassified count is
            # identical at every weight.
            saturation=abs(s[:,:,None]-ph[choices,1])
            order=difference+np.where(np.isfinite(difference),
                                      saturation*saturation_tiebreak,0.)
        nearest=np.argmin(order,2);accepted=mask&(difference.min(2)<=20)
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
    key=(tuple((p,str(c),np.asarray(T,float).tobytes()) for p,c,T in items),M.tobytes())
    if getattr(scorer,'last_layer_key',None)==key and getattr(scorer,'last_layer',None) is not None:
        layer=scorer.last_layer;mask=layer['mask'][0];owner=layer['owner'][0]
        codes=np.concatenate([scorer.geometry[(p,str(c))]['colors'] for p,c,T in items])
        lookup=np.zeros(len(codes),np.uint8)
        for index,color in enumerate(colors):lookup[codes==color]=index+1
        labels=np.zeros(mask.shape,np.uint8);labels[mask]=lookup[owner[mask].astype(int)-1]
        return dict(labels=labels,mask=mask,colors=colors,reused_owner_buffer=True,
            protocol='Actual visible CAD triangle material ID from shared depth/owner buffer; no shaded-RGB reclassification')
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
