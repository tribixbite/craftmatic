"""Conservative image-geometry arrow proposals; preserves ambiguous colors.

No blanket hue erasure. Protected CAD base/print RGB colors require stronger
shaft evidence. Acceptance is a geometric hypothesis, never certification.
"""
from pathlib import Path
import argparse
import json
import cv2
import numpy as np


def protected_cad_colors(parts,resolver=None):
    """Collect actual base/print palette from (part, basecolor) universal CAD.

    Missing geometry is explicit; callers must not interpret an incomplete
    palette as evidence that an arrow hue is absent from real parts.
    """
    from placement_colored_cad import colored_triangles,_rgb
    from placement_part_library import PartLibrary
    resolver=resolver or PartLibrary().resolve;colors=set();missing=[]
    for part,color in sorted(set((str(p),str(c)) for p,c in parts)):
        try:colors.update(map(int,colored_triangles(part,color,resolver=resolver)['colors']))
        except (FileNotFoundError,ValueError) as exc:missing.append(dict(part=part,color=color,error=str(exc)))
    return dict(rgb=[_rgb(c).tolist() for c in sorted(colors)],ldraw_colors=sorted(colors),
        complete=not missing,missing=missing)


def hue_mask(rgb,hue):
    r,g,b=np.asarray(rgb,dtype=np.int16).transpose(2,0,1)
    if hue=='red':return (r>120)&(r>g+45)&(r>b+45)
    if hue=='green':return (g>95)&(g>r+25)&(g>b+20)
    raise ValueError('Only explicitly requested red/green arrow hues supported')


def classify_arrows(scene,protected_colors=(),hues=('red','green')):
    """Return accepted mask and reviewable accepted/rejected blob evidence.

    protected_colors: iterable of universal CAD base AND printed RGB triples.
    Rejected regions are retained unchanged; touching color blobs may abstain.
    """
    rgb=np.asarray(scene['rgb'],np.uint8);foreground=np.asarray(scene['mask'],bool)
    result_mask=np.zeros(foreground.shape,bool);records=[]
    palette=np.asarray(list(protected_colors),np.uint8).reshape(-1,1,3)
    for hue in hues:
        conflict=bool(len(palette) and hue_mask(palette,hue).any())
        colored=hue_mask(rgb,hue)&foreground
        count,labels,stats,_=cv2.connectedComponentsWithStats(colored.astype(np.uint8),8)
        for label in range(1,count):
            area=int(stats[label,cv2.CC_STAT_AREA])
            if area<8:continue
            yy,xx=np.nonzero(labels==label);points=np.column_stack((xx,yy)).astype(float)
            center=points.mean(0);_,singular,vh=np.linalg.svd(points-center,full_matrices=False)
            axis=vh[0];normal=np.array([-axis[1],axis[0]])
            along=(points-center)@axis;across=(points-center)@normal
            lo,hi=along.min(),along.max();length=hi-lo+1
            width=float(np.ptp(across)+1);cuts=np.linspace(lo,hi+1e-7,13)
            widths=[]
            for start,end in zip(cuts[:-1],cuts[1:]):
                selected=across[(along>=start)&(along<end)]
                widths.append(float(np.ptp(selected)+1) if len(selected) else 0.)
            first=max(widths[:4]);last=max(widths[-4:]);high_head=last>first
            ordered=np.asarray(widths if high_head else widths[::-1])
            head_width=float(max(ordered[-4:]));shaft_width=float(np.median(ordered[:7]))
            shaft_fraction=float(np.mean(ordered[:8]<=.60*max(1,head_width)))
            head_ratio=head_width/max(1.,shaft_width)
            end_ratio=max(first,last)/max(1.,min(first,last))
            aspect=length/max(1.,width)
            accepted=(length>=10 and aspect>=(2.5 if conflict else 2.) and
                head_ratio>=1.65 and end_ratio>=1.35 and shaft_fraction>=.625)
            head=center+axis*(hi if high_head else lo);tail=center+axis*(lo if high_head else hi)
            reasons=[]
            if length<10:reasons.append('too_short')
            if aspect<(2.5 if conflict else 2.):reasons.append('compact_or_wide_face')
            if head_ratio<1.65:reasons.append('no_wide_head_over_thin_shaft')
            if end_ratio<1.35:reasons.append('both_ends_similar_width')
            if shaft_fraction<.625:reasons.append('insufficient_long_thin_shaft')
            records.append(dict(hue=hue,area=area,bbox=stats[label,:4].tolist(),length=length,width=width,
                aspect=aspect,width_profile=widths,head_ratio=head_ratio,end_ratio=end_ratio,
                shaft_fraction=shaft_fraction,protected_color_conflict=conflict,accepted=bool(accepted),
                rejection_reasons=reasons,head=head.tolist(),tail=tail.tolist(),direction=(head-tail).tolist()))
            if accepted:result_mask|=labels==label
    return dict(mask=result_mask,candidates=records,certified=False,
        limitations=['Touching arrow/part same-color blobs may abstain.',
            'Geometric arrow-like decorations remain possible; accepted proposals need placement context.',
            'Only explicitly requested arrow hues are considered.'])


def conservative_components(scene,protected_colors=(),hues=('red','green'),min_area=12):
    """Build optional components using accepted arrow pixels only.

    No dilation over neighboring part pixels; no largest-component completion
    claim. Existing blanket-erasure component_graph remains unchanged.
    """
    from collections import Counter
    from vector_scene import background_mask
    result=classify_arrows(scene,protected_colors,hues)
    rgb=np.asarray(scene['rgb']).copy()
    border=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
    background=Counter(map(tuple,border.tolist())).most_common(1)[0][0]
    rgb[result['mask']]=background
    clean_mask=background_mask(rgb)&~result['mask']
    count,labels,stats,_=cv2.connectedComponentsWithStats(clean_mask.astype(np.uint8),8)
    components=[]
    for label in range(1,count):
        x,y,w,h,area=map(int,stats[label])
        if area>=min_area:components.append(dict(mask=labels==label,bbox=(x,y,x+w,y+h),area=area))
    components.sort(key=lambda c:-c['area'])
    return dict(components=components,arrows=[c for c in result['candidates'] if c['accepted']],
        arrow_mask=result['mask'],candidates=result['candidates'],clean_mask=clean_mask,
        certified=False,limitations=result['limitations'])


def selftest(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    rgb=np.full((130,230,3),245,np.uint8)
    cv2.rectangle(rgb,(10,15),(80,55),(220,0,0),-1)
    cv2.fillPoly(rgb,[np.array([[15,90],[40,76],[40,104]]),np.array([[65,90],[40,76],[40,104]])],(220,0,0))
    cv2.arrowedLine(rgb,(110,15),(110,110),(220,0,0),3,tipLength=.22)
    cv2.arrowedLine(rgb,(175,15),(175,110),(0,180,0),3,tipLength=.22)
    scene=dict(rgb=rgb,mask=(rgb!=245).any(2));result=classify_arrows(scene,[(220,0,0),(0,180,0)])
    accepted=[c for c in result['candidates'] if c['accepted']]
    record=dict(accepted_hues=[c['hue'] for c in accepted],
        red_face_preserved=not result['mask'][15:56,10:81].any(),
        bowtie_preserved=not result['mask'][75:106,10:81].any(),
        candidates=result['candidates'])
    component_result=conservative_components(scene,[(220,0,0),(0,180,0)])
    record['red_face_mask_preserved']=bool(component_result['clean_mask'][15:56,10:81].all())
    print_palette=protected_cad_colors([('3245cpb117',1)])
    record['printed_cad_palette']=print_palette
    record['printed_red_protected']=bool(hue_mask(np.asarray(print_palette['rgb'],np.uint8).reshape(-1,1,3),'red').any())
    (out/'synthetic.json').write_text(json.dumps(record,indent=2))
    assert sorted(record['accepted_hues'])==['green','red']
    assert record['red_face_preserved'] and record['bowtie_preserved']
    assert record['red_face_mask_preserved'] and record['printed_red_protected'] and print_palette['complete']


def diagnostic(out):
    import pymupdf
    from PIL import Image,ImageDraw
    from vector_scene import scene_images
    from placement_colored_cad import _rgb
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    fixtures=[('40377','6314914',[2,3,11],[_rgb(4)]),('41624','6248865',[2,3],[_rgb(4),_rgb(2)])]
    records=[];images=[]
    for name,pdf,pages,protected in fixtures:
        doc=pymupdf.open(f'C:/git/clego/lego_sets/PDF/{pdf}.pdf')
        for page in pages:
            for rank,scene in enumerate(scene_images(doc,doc[page])):
                result=classify_arrows(scene,protected_colors=protected)
                components=conservative_components(scene,protected_colors=protected)
                records.append(dict(set=name,page_index=page,xref=scene['xref'],rank=rank,
                    protected_rgb=np.asarray(protected).tolist(),candidates=result['candidates'],
                    conservative_component_count=len(components['components']),
                    removed_red_pixels=int((result['mask']&hue_mask(scene['rgb'],'red')).sum()),
                    removed_green_pixels=int((result['mask']&hue_mask(scene['rgb'],'green')).sum())))
                rgb=scene['rgb'].copy();rgb[result['mask']]=[255,0,255]
                im=Image.fromarray(rgb);im.thumbnail((350,280));images.append((f'{name} PDF{page+1} xref{scene["xref"]} accepted{sum(c["accepted"] for c in result["candidates"])}',im))
    sheet=Image.new('RGB',(1080,320*((len(images)+2)//3)),'white');draw=ImageDraw.Draw(sheet)
    for i,(label,im) in enumerate(images):
        x=(i%3)*360;y=(i//3)*320;draw.text((x+3,y+3),label,fill='black');sheet.paste(im,(x,y+25))
    sheet.save(out/'arrow-contact.png');(out/'results.json').write_text(json.dumps(records,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);args=p.parse_args()
    selftest(args.out);diagnostic(args.out)
