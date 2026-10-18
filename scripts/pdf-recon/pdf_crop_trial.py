"""Quantity-anchored PDF artwork crops; experimental, no runtime VLM."""
import argparse
import json
import os
from pathlib import Path
import sys
import cv2
import numpy as np
import pymupdf

BASE=Path('C:/git/clego')
OUT=Path(os.environ.get('PDF_CROP_OUT',str(Path(__file__).resolve().parents[2]/'output/pdf-crop-trial')))
sys.path.insert(0,str(BASE))


def unique_quantities(quantities):
    """Collapse identical overprinted PDF quantities, preserving distinct labels."""
    seen=set()
    for quantity in quantities:
        key=(quantity['qty'],tuple(quantity['bbox']))
        if key not in seen:
            seen.add(key)
            yield quantity


def pdf_pli_panel_bounds(page,background,scale=1.6):
    """Native PDF filled panels matching the declared PLI background color."""
    boxes=[]
    for drawing in page.get_drawings():
        fill=drawing.get('fill');rect=drawing['rect']
        if fill is None or len(fill)!=3 or rect.width<20 or rect.height<20:continue
        if np.max(np.abs(np.asarray(fill)*255-np.asarray(background)))>5:continue
        boxes.append([float(v)*scale for v in rect])
    return boxes


INK_THRESHOLD=90
# Translucent artwork sits far closer to the PLI background than opaque plastic
# does: measured on 41601 page 5 the trans-light-blue 2x2 round brick reaches
# the strong threshold only on its studs and outline, so its body fragments and
# the nearest fragment to the quantity label is an 8x9 stud. A weak threshold
# joins those fragments without ever being used as a boundary - see
# `component_groups`. 45 sits above the panel background's own spread (its 25th
# percentile distance is 8) and below the weakest translucent body ink.
WEAK_INK_THRESHOLD=45
# Two association costs closer than this are indistinguishable evidence. Used
# both for the per-anchor ambiguity test and for the shared-artwork guard.
AMBIGUITY_TOLERANCE=3.0
MAX_COMPONENT_SPAN=320
MAX_COMPONENT_AREA=40000


def ink_masks(rgb,words,background,scale=1.6):
    """Strong and weak ink masks, text-excluded and closed identically."""
    distance=np.abs(rgb.astype('int16')-np.asarray(background,dtype='int16')).sum(2)
    textmask=np.zeros(distance.shape,dtype='uint8')
    for word in words:
        x0,y0,x1,y1=[int(round(v*scale)) for v in word[:4]]
        textmask[max(0,y0-1):y1+2,max(0,x0-1):x1+2]=1
    masks=[]
    for threshold in (INK_THRESHOLD,WEAK_INK_THRESHOLD):
        mask=(distance>threshold).astype('uint8')
        mask[textmask>0]=0
        # Even-sized morphology kernels shift components by a pixel. That broke
        # the quantity-edge test on legitimate artwork touching its label
        # baseline. An odd kernel preserves coordinates; never refill masked
        # text afterward.
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        mask[textmask>0]=0
        masks.append(mask)
    return masks


def component_groups(mask,weak,group=True):
    """Strong components, grouped when one weak component contains several.

    The reported box is always the union of the group's *strong* boxes and the
    reported pixels are always strong pixels, so a part whose strong mask is
    already one component is byte-identical to ungrouped behaviour - the weak
    mask decides only which fragments belong together, never where a part ends.
    A weak component too large to be one part's artwork groups nothing, so the
    page's white surround (which is itself far from the PLI background) cannot
    merge unrelated callouts.
    """
    count,labels,stats,_=cv2.connectedComponentsWithStats(mask,8)
    buckets={}
    if group:
        weak_count,weak_labels,weak_stats,_=cv2.connectedComponentsWithStats(weak,8)
        oversize=np.zeros(weak_count,dtype=bool)
        for index in range(1,weak_count):
            _,_,width,height,_=[int(v) for v in weak_stats[index]]
            oversize[index]=(max(width,height)>MAX_COMPONENT_SPAN
                             or width*height>MAX_COMPONENT_AREA)
        # Every strong pixel is a weak pixel, and one strong component lies
        # inside exactly one weak component, so a single scatter recovers the
        # mapping without touching a component at a time.
        strong_to_weak=np.zeros(count,dtype=np.int32)
        selected=mask.astype(bool)
        strong_to_weak[labels[selected]]=weak_labels[selected]
        for index in range(1,count):
            parent=int(strong_to_weak[index])
            key=('own',index) if parent==0 or oversize[parent] else ('weak',parent)
            buckets.setdefault(key,[]).append(index)
    else:
        for index in range(1,count):
            buckets[('own',index)]=[index]
    groups=[]
    for members in buckets.values():
        boxes=[[int(v) for v in stats[i][:4]] for i in members]
        x=min(b[0] for b in boxes);y=min(b[1] for b in boxes)
        x1=max(b[0]+b[2] for b in boxes);y1=max(b[1]+b[3] for b in boxes)
        area=sum(int(stats[i][4]) for i in members)
        groups.append((min(members),(x,y,x1,y1),area,members))
    groups.sort()
    return groups,labels


def _matching(costs,anchors,groups_count,forbid=None):
    """Minimum-cost matching that first maximises the number of associations.

    One drawn artwork component belongs to one quantity label, so the
    association is an assignment problem rather than a per-anchor nearest
    lookup - the same shape the callout/inventory-slot solver already uses.
    """
    from scipy.optimize import linear_sum_assignment
    finite=[c for row in costs for c in row if c is not None]
    penalty=(max(finite)+1.)*(len(anchors)+1.) if finite else 1.
    matrix=np.full((len(anchors),max(groups_count,len(anchors))),penalty,dtype=float)
    for a,row in enumerate(costs):
        for g,cost in enumerate(row):
            if cost is not None and (forbid is None or (a,g)!=forbid):
                matrix[a,g]=cost
    rows,cols=linear_sum_assignment(matrix)
    assignment={};total=0.
    for a,g in zip(rows,cols):
        if g<groups_count and matrix[a,g]<penalty:
            assignment[int(a)]=int(g);total+=float(matrix[a,g])
        else:
            total+=penalty
    return assignment,total


def crop_items(rgb, words, quantities, background, scale=1.6,panel_bounds=(),
               group_fragments=True,exclusive=True):
    """Find local components ABOVE each quantity, excluding all PDF text.

    Unlike x-only partitioning, this cannot assign a step digit or artwork
    from a lower row to a quantity merely because it shares the same x.
    Returns rejected/ambiguous anchors explicitly; no inventory fallback.
    """
    mask,weak=ink_masks(rgb,words,background,scale)
    groups,labels=component_groups(mask,weak,group_fragments)
    candidates=[]
    for index,box,area,members in groups:
        x,y,x1,y1=box;w,h=x1-x,y1-y
        if area<12 or min(w,h)<3 or max(w,h)>MAX_COMPONENT_SPAN or w*h>MAX_COMPONENT_AREA:
            continue
        if max(w,h)/min(w,h)>35:
            continue
        # A sparse component matching an actual PDF filled-panel boundary is
        # decoration, not competing part artwork. Without PDF geometry this
        # rule abstains; ordinary hollow/frame-shaped parts remain eligible.
        if area/(w*h)<.12 and any(np.max(np.abs(np.asarray(box)-b))<=3 for b in panel_bounds):
            continue
        window=labels[y:y1,x:x1]
        py,px=np.where(np.isin(window,members) if len(members)>1 else window==members[0])
        candidates.append((index,box,area,px+x,py+y))
    anchors=list(unique_quantities(quantities))
    costs=[]
    for q in anchors:
        qx,qy,qright,qbottom=q['bbox']
        row=[]
        for index,box,area,px,py in candidates:
            x0,y0,x1,y1=box
            cost=None
            if not (y0>=qy or (y0+y1)/2>qy or qy-y0>260) and x0-24<=qx<=x1+12:
                # In an isometric drawing the far-right corner can extend BELOW
                # its left-aligned quantity label. Global bbox-bottom distance
                # wrongly rejects such parts. Use the nearest actual ink above
                # the label instead, while requiring the part's centre above it.
                above=py<=qy+2
                if above.any():
                    distance=float(np.sqrt(((px[above]-qx)**2+(py[above]-qy)**2).min()))
                    if distance<=max(24,2*(qbottom-qy)):
                        cost=distance
            row.append(cost)
        costs.append(row)
    if exclusive and candidates and any(c is not None for row in costs for c in row):
        assignment,base=_matching(costs,anchors,len(candidates))
    else:
        assignment,base={},0.
        for a,row in enumerate(costs):
            ranked=sorted((c,g) for g,c in enumerate(row) if c is not None)
            if ranked:assignment[a]=ranked[0][1]
    out=[]
    for a,q in enumerate(anchors):
        record={'qty':q['qty'],'anchor':list(q['bbox'])}
        ranked=sorted((c,g) for g,c in enumerate(costs[a]) if c is not None)
        if a not in assignment:
            record['unresolved']='no nearby nontext artwork' if not ranked else \
                'artwork already associated with another quantity'
            if ranked:
                record['crop_candidates']=[dict(association_cost=c,component=candidates[g][0],
                                                bbox=list(candidates[g][1]),area=candidates[g][2])
                                           for c,g in ranked]
            out.append(record);continue
        chosen=assignment[a]
        if exclusive:
            # An assignment is ambiguous when forbidding it costs the whole
            # page almost nothing: the alternative explains the drawing just as
            # well. Where a competing anchor has no substitute, forbidding is
            # expensive and the association is decided by exclusivity rather
            # than left refused.
            alternative,total=_matching(costs,anchors,len(candidates),forbid=(a,chosen))
            rival=alternative.get(a)
            contested=rival is not None and total-base<AMBIGUITY_TOLERANCE
        else:
            contested=len(ranked)>1 and ranked[1][0]-ranked[0][0]<AMBIGUITY_TOLERANCE
            rival=ranked[1][1] if len(ranked)>1 else None
        if contested:
            order=[chosen,rival]+[g for _,g in ranked if g not in (chosen,rival)]
            record['unresolved']='ambiguous artwork association'
            record['crop_candidates']=[dict(association_cost=costs[a][g],component=candidates[g][0],
                                            bbox=list(candidates[g][1]),area=candidates[g][2])
                                       for g in order]
            out.append(record);continue
        index,box,area,_,_=candidates[chosen]
        record.update(bbox=list(box),component=index,association_cost=costs[a][chosen],
                      group=chosen)
        out.append(record)
    # Two labels whose parts' artwork merged into ONE component is a real case
    # and a matching would silently hand it to the nearer label. Where two
    # anchors' best evidence is the same component at indistinguishable cost,
    # both stay refused exactly as before.
    contenders={}
    for b,row in enumerate(costs):
        ranked=sorted((c,g) for g,c in enumerate(row) if c is not None)
        if ranked:contenders.setdefault(ranked[0][1],[]).append((ranked[0][0],b))
    for claims in contenders.values():
        if len(claims)<2:continue
        if max(cost for cost,_ in claims)-min(cost for cost,_ in claims)>=AMBIGUITY_TOLERANCE:continue
        for _,b in claims:
            out[b].pop('bbox',None)
            out[b].pop('crop_candidates',None)
            out[b]['unresolved']='same artwork claimed by multiple quantities'
    for record in out:record.pop('group',None)
    return out


def artwork_pixels(rgb,words,background,scale=1.6):
    """Remove PDF text from the matcher input as well as segmentation.

    A long beam's bounding rectangle can enclose an unconnected length label.
    Masking only during component finding leaves that text in the final crop.
    """
    clean=rgb.copy()
    for word in words:
        x0,y0,x1,y1=[int(round(v*scale)) for v in word[:4]]
        clean[max(0,y0-1):y1+2,max(0,x0-1):x1+2]=background
    return clean


def run(sets):
    from recon_extract import extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    from recon_v7 import pdfpick
    OUT.mkdir(parents=True,exist_ok=True)
    pdfpick.CACHE=OUT/'pdfpick.json'
    result=[]
    tiles=[]
    for sn in sets:
        pdf,_=pdfpick.pick(sn)
        with pymupdf.open(pdf) as doc:
            for pg in range(len(doc)):
                if is_inventory_page(doc[pg]): continue
                tokens=e4.page_tokens(doc,pg,style=e4.ERA4)
                qty=tokens['qty_small']
                if not qty: continue
                rgb=e4.render_page(doc,pg)
                old=e4.page_pli_items(rgb,e4.find_pli_boxes(rgb,style=e4.ERA4),qty,style=e4.ERA4)
                new=crop_items(rgb,doc[pg].get_text('words'),qty,e4.ERA4.pli_bg)
                result.append({'set':sn,'page':pg,'pdf':str(pdf),'old':old,'new':new,
                               'raw_quantity_tokens':len(qty)})
                # Deterministic samples across pages, including known bad
                # digit-crop pages. Both output crops are shown with context.
                if pg not in (2,7,8,14,24): continue
                for r in new[:3]:
                    if 'bbox' not in r: continue
                    qx,qy,_,_=r['anchor']
                    prev=min(old,key=lambda b:abs(b['bbox'][0]-qx)+abs(b['bbox'][3]-qy)) if old else None
                    tile=np.full((160,320,3),255,np.uint8)
                    for col,box in enumerate([prev['bbox'] if prev else None,r['bbox']]):
                        if box is None: continue
                        x0,y0,x1,y1=map(int,box)
                        crop=rgb[y0:y1,x0:x1]
                        if not crop.size: continue
                        ratio=min(150/crop.shape[1],120/crop.shape[0])
                        crop=cv2.resize(crop,(max(1,int(crop.shape[1]*ratio)),max(1,int(crop.shape[0]*ratio))))
                        tile[:crop.shape[0],col*160:col*160+crop.shape[1]]=crop
                    cv2.putText(tile,f'{sn} p{pg} {r["qty"]}x old | anchored',(4,145),cv2.FONT_HERSHEY_SIMPLEX,.42,(0,0,0),1)
                    tiles.append(tile)
        print(sn,'complete',flush=True)
    report={'rows':result,'old_crops':sum(len(r['old']) for r in result),
            'association_version':'v5-unique-quantity-anchors',
            'raw_quantity_tokens':sum(r['raw_quantity_tokens'] for r in result),
            'anchors':sum(len(r['new']) for r in result),
            'resolved_crops':sum('bbox' in i for r in result for i in r['new']),
            'runtime_vlm_calls':0,'limitations':'Crop counts are not precision/recall; association remains experimental'}
    (OUT/'results.json').write_text(json.dumps(report,indent=2,default=lambda x:x.item() if isinstance(x,np.generic) else list(x)))
    for start in range(0,len(tiles),24):
        batch=tiles[start:start+24]
        canvas=np.full((((len(batch)+2)//3)*160,960,3),255,np.uint8)
        for i,t in enumerate(batch): canvas[(i//3)*160:(i//3+1)*160,(i%3)*320:(i%3+1)*320]=t
        cv2.imwrite(str(OUT/f'comparison-{start//24}.png'),cv2.cvtColor(canvas,cv2.COLOR_RGB2BGR))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('sets',nargs='*',default=['41637','42044','42058'])
    args=parser.parse_args()
    run(args.sets)
