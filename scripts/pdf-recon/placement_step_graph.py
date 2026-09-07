"""Deterministic PDF layout graph; numeric/image evidence, no model poses."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path


def center(box):return ((box[0]+box[2])/2,(box[1]+box[3])/2)
def contains(box,point):return box[0]<=point[0]<=box[2] and box[1]<=point[1]<=box[3]


def dedup_panels(panels,width,height):
    result=[]
    for row in panels:
        box=row['bbox'];fill=row.get('fill')
        if fill is None or max(fill)<.1:continue
        if box[2]-box[0]<=20 or box[3]-box[1]<=20:continue
        if (box[2]-box[0])*(box[3]-box[1])>.8*width*height:continue
        if any(max(abs(a-b) for a,b in zip(box,r['bbox']))<2 for r in result):continue
        result.append(dict(bbox=box,fill=fill))
    return result


def associate_numerals(numbers,images):
    costs=[]
    for n,number in enumerate(numbers):
        bx=number['bbox']
        for i,image in enumerate(images):
            ib=image['bbox']
            # Step numerals normally sit above/left of their artwork. Penalize
            # backwards association without making area-rank order decisive.
            distance=math.hypot(ib[0]-bx[2],ib[1]-bx[1])
            if ib[2]<bx[0]:distance+=100
            if ib[3]<bx[1]:distance+=100
            costs.append((distance,n,i))
    used_n=set();used_i=set();pairs=[]
    for distance,n,i in sorted(costs):
        if n in used_n or i in used_i:continue
        used_n.add(n);used_i.add(i)
        pairs.append(dict(number=int(numbers[n]['text']),number_bbox=numbers[n]['bbox'],
            xref=images[i]['xref'],image_bbox=images[i]['bbox'],association_cost=distance))
    return sorted(pairs,key=lambda p:p['number'])


def layout_graph(layout):
    """Pure layout API, usable with synthetic tests or extracted PDF evidence."""
    width,height=layout['size'];panels=dedup_panels(layout['panels'],width,height)
    words=layout['words'];images=layout['images']
    for i,panel in enumerate(panels):
        panel['id']=i
        panel['images']=[im for im in images if contains(panel['bbox'],center(im['bbox']))]
        panel['words']=[w for w in words if contains(panel['bbox'],center(w['bbox']))]
        panel['kind']='instruction_inset' if panel['images'] else 'callout_or_other_panel'
    inset_images={im['xref'] for p in panels if p['kind']=='instruction_inset' for im in p['images']}
    outside=[im for im in images if im['xref'] not in inset_images]
    numeric=[w for w in words if w['text'].isdigit() and w['bbox'][1]<height*.85]
    outside_numeric=[w for w in numeric if not any(contains(p['bbox'],center(w['bbox'])) for p in panels)]
    main=max(outside_numeric,key=lambda w:w['bbox'][3]-w['bbox'][1],default=None)
    # Main step header must have at least one callout/quantity region. A lone
    # numeral on an otherwise empty page is not promoted to a new model step.
    if not any(re.fullmatch(r'\d+x',w['text']) for w in words):main=None
    locals_=[w for w in outside_numeric if w is not main]
    groups=[]
    for panel in panels:
        if panel['kind']!='instruction_inset':continue
        numbers=[w for w in panel['words'] if w['text'].isdigit()]
        quantities=[w for w in panel['words'] if re.fullmatch(r'\d+x',w['text'])]
        copies=int(quantities[0]['text'][:-1]) if len(quantities)==1 else (1 if not quantities else None)
        sequence=associate_numerals(numbers,panel['images'])
        groups.append(dict(id=f'p{layout["page"]}-inset{panel["id"]}',kind='inset_group',
            panel_bbox=panel['bbox'],copy_count=copies,copy_count_evidence=quantities,
            copy_count_defaulted=not quantities,sequence=sequence,
            image_xrefs=[im['xref'] for im in panel['images']],
            ordered_xrefs=[s['xref'] for s in sequence] if sequence else [im['xref'] for im in panel['images']],
            multiplicity_consistent=all(e['qty']%copies==0 for e in layout['allocations']) if copies else False,
            allocation_scope='page only; per-substep assignment unresolved'))
    free_sequence=associate_numerals(locals_,outside)
    ordered_numbers=[s['number'] for s in free_sequence]
    free_group=(len(free_sequence)>=2 and ordered_numbers==list(range(1,len(free_sequence)+1)) and len(free_sequence)==len(outside))
    if free_group:groups.append(dict(id=f'p{layout["page"]}-free',kind='unframed_numbered_group',
        copy_count=1,copy_count_defaulted=True,sequence=free_sequence,
        ordered_xrefs=[s['xref'] for s in free_sequence],image_xrefs=[im['xref'] for im in outside],
        allocation_scope='page only; per-substep assignment unresolved'))
    group_xrefs={xref for g in groups for xref in g['image_xrefs']}
    main_images=[im for im in images if im['xref'] not in group_xrefs]
    return dict(page=layout['page'],header=main,panels=panels,groups=groups,
        main_image_candidates=main_images,allocations=layout['allocations'],
        unresolved_allocations=layout.get('unresolved_allocations',[]),
        continuation_lines=layout.get('continuation_lines',[]),certified=False,
        status='unfinished_group_candidate' if free_group else 'main_or_inset_step',
        limitations=['Numeral/image association is a layout hypothesis.',
            'Page allocations are not assigned to individual numbered substeps.',
            'Default copy count is not evidence that no unrecognized multiplier exists.'])


def link_pages(pages):
    edges=[]
    for previous,current in zip(pages,pages[1:]):
        if current['page']!=previous['page']+1:continue
        if (previous['status']=='unfinished_group_candidate' and not current['allocations']
            and not current['header'] and len(current['main_image_candidates'])==1
            and current['continuation_lines']):
            target_box=current['main_image_candidates'][0]['bbox']
            receiving_lines=[line for line in current['continuation_lines'] if contains(target_box,line['end'])]
            if not receiving_lines:continue
            edges.append(dict(type='cross_page_group_attachment_candidate',
                source_group=previous['groups'][-1]['id'],target_page=current['page'],
                target_xref=current['main_image_candidates'][0]['xref'],
                evidence=dict(numbered_group_without_main=True,next_page_no_new_callouts=True,
                    next_page_no_step_header=True,incoming_page_edge_lines=receiving_lines),
                certified=False,requires='geometric registration of final group into receiving model'))
    return edges


def extract_layout(doc,page,assignment):
    import numpy as np
    import pymupdf
    from vector_scene import scene_images
    p=doc[page];drawings=p.get_drawings();lines=[];scenes=scene_images(doc,p)
    # Connector shafts can be separate, rotated thin XObjects, intentionally
    # excluded from scene_images' minimum-size assembly filter.
    for image in p.get_image_info(xrefs=True):
        box=image['bbox'];width=box[2]-box[0];height=box[3]-box[1]
        if not image['xref'] or box[0]>p.rect.width*.03 or width<20 or not 0<height<=5:continue
        pix=pymupdf.Pixmap(doc,image['xref'])
        if pix.colorspace and pix.colorspace!=pymupdf.csRGB:pix=pymupdf.Pixmap(pymupdf.csRGB,pix)
        samples=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)
        darkness=float((samples[:,:,:min(3,pix.n)].max(axis=2)<120).mean())
        if darkness<.02:continue
        y=(box[1]+box[3])/2
        lines.append(dict(start=[box[0],y],end=[box[2],y],source='thin_native_image_edge_shaft',
            xref=image['xref'],bbox=list(box),transform=list(image['transform']),dark_fraction=darkness))
    for drawing in drawings:
        for item in drawing['items']:
            if item[0]!='l':continue
            a,b=item[1],item[2]
            if min(a.x,b.x)<p.rect.width*.03 and abs(a.y-b.y)<2 and abs(a.x-b.x)>20:
                lines.append(dict(start=list(a),end=list(b),drawing_rect=list(drawing['rect'])))
    # Some booklets bake continuation arrows into the assembly XObject rather
    # than vector paths. Record a native-image thin dark shaft entering at the
    # physical page edge; a no-callout page alone is insufficient evidence.
    for scene in scenes:
        box=scene['bbox'];rgb=scene['rgb']
        if box[0]>p.rect.width*.03:continue
        dark=np.max(rgb,axis=2)<120;h,w=dark.shape;hits=[]
        for y in range(h):
            if not dark[y,0]:continue
            stop=np.flatnonzero(~dark[y]);run=int(stop[0]) if len(stop) else w
            if 20<=run<w*.8:hits.append((y,run))
        if not hits:continue
        runs=[]
        for hit in hits:
            if not runs or hit[0]>runs[-1][-1][0]+1:runs.append([])
            runs[-1].append(hit)
        for run in runs:
            if len(run)>5:continue
            y=float(np.mean([a for a,b in run]));length=float(np.median([b for a,b in run]))
            sx=(box[2]-box[0])/w;sy=(box[3]-box[1])/h
            lines.append(dict(start=[box[0],box[1]+y*sy],end=[box[0]+length*sx,box[1]+y*sy],
                source='native_image_edge_shaft',xref=scene['xref'],native_rows=len(run),native_length=length))
    return dict(page=page,size=[p.rect.width,p.rect.height],
        words=[dict(text=w[4],bbox=list(w[:4])) for w in p.get_text('words')],
        panels=[dict(bbox=list(d['rect']),fill=d.get('fill')) for d in drawings],
        images=[dict(xref=s['xref'],bbox=list(s['bbox']),transform=list(s['transform'])) for s in scenes],
        allocations=[e for e in assignment['evidence'] if e['page']==page],
        unresolved_allocations=[e for e in assignment['unresolved'] if e['page']==page],continuation_lines=lines)


def selftest():
    # Footer numeral must not become a step, nested copy marker is not PLI.
    word=lambda text,box:dict(text=text,bbox=box)
    layout=dict(page=0,size=[400,300],panels=[dict(bbox=[200,10,300,150],fill=[1,.96,.8])],
        images=[dict(xref=1,bbox=[220,20,280,65]),dict(xref=2,bbox=[220,90,280,135]),dict(xref=3,bbox=[20,130,170,240])],
        words=[word('8',[20,70,35,102]),word('1',[205,20,215,35]),word('2',[205,90,215,105]),
            word('2x',[280,125,295,140]),word('99',[20,275,35,290])],allocations=[dict(qty=4)])
    graph=layout_graph(layout)
    assert graph['header']['text']=='8' and graph['groups'][0]['copy_count']==2
    assert graph['groups'][0]['ordered_xrefs']==[1,2] and graph['main_image_candidates'][0]['xref']==3
    free=dict(layout,page=1,panels=[],images=layout['images'][:2],
        words=[word('9',[5,60,20,95]),word('1x',[5,10,20,20]),word('1',[205,20,215,35]),word('2',[205,90,215,105])])
    a=layout_graph(free)
    b=layout_graph(dict(page=2,size=[400,300],panels=[],words=[word('3',[10,275,20,290])],
        images=[dict(xref=4,bbox=[100,80,220,230])],allocations=[],continuation_lines=[dict(start=[0,100],end=[120,100])]))
    assert len(link_pages([a,b]))==1
    b['continuation_lines']=[];assert not link_pages([a,b])
    return dict(inset_multiplicity=True,numeral_order=True,footer_excluded=True,
        cross_page_requires_incoming_line=True)


def run(out):
    import pymupdf
    from PIL import Image,ImageDraw
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    source=Path('output/pdf-placement-beam/40377-contacts-six-v1/global-assignment.json')
    assignment=json.loads(source.read_text());assert assignment['pdf_only']
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');doc=pymupdf.open(pdf)
    graphs=[layout_graph(extract_layout(doc,p,assignment)) for p in range(9,15)]
    sheet=Image.new('RGB',(1200,700),'white');draw=ImageDraw.Draw(sheet)
    for i,graph in enumerate(graphs):
        page=doc[graph['page']];pix=page.get_pixmap(alpha=False)
        im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples);d=ImageDraw.Draw(im)
        for group in graph['groups']:
            for item in group.get('sequence',[]):d.rectangle(item['image_bbox'],outline='magenta',width=2)
            if group.get('panel_bbox'):d.rectangle(group['panel_bbox'],outline='red',width=2)
        x=(i%3)*400;y=(i//3)*350;sheet.paste(im,(x,y+30));draw.text((x+3,y+3),f'index{graph["page"]}: '+str([(g['kind'],g['copy_count'],g['ordered_xrefs']) for g in graph['groups']]),fill='black')
    sheet.save(out/'graph-contact.png')
    result=dict(pdf=str(pdf),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),
        assignment_source=str(source),pages=graphs,edges=link_pages(graphs),tests=selftest(),
        runtime_vlm_calls=0,truth_used=False,manual_runtime_pose_or_id_inputs=False)
    (out/'graph.json').write_text(json.dumps(result,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);run(p.parse_args().out)
