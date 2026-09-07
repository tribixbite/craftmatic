"""PDF-only per-page orchestration inventory; no hand-entered runtime IDs."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from vector_scene import scene_images
from vector_scene_components import component_graph
from placement_multirow_camera import row_camera_hypotheses
from placement_camera import infer_camera_robust
from placement_studs import detect_studs
from placement_colored_cad import _rgb


def run(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    source=Path('output/pdf-placement-beam/40377-contacts-six-v1/global-assignment.json')
    assignment=json.loads(source.read_text());assert assignment['pdf_only'] and assignment['runtime_vlm_calls']==0
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');doc=pymupdf.open(pdf)
    records=[];cumulative=[];sheet=Image.new('RGB',(1600,2100),'white');draw=ImageDraw.Draw(sheet)
    for page_index in range(2,33):
        additions=[e for e in assignment['evidence'] if e['page']==page_index]
        cumulative+=additions
        colors=set(int(e['color']) for e in cumulative)
        red_conflict=[]
        for code in colors:
            r,g,b=_rgb(code)
            if r>120 and r>g+45 and r>b+45:red_conflict.append(code)
        page=doc[page_index];scenes=scene_images(doc,page);scene_records=[]
        for index,scene in enumerate(scenes):
            # Inspect original masks for camera evidence; do not assume arrows
            # are removable when printed or base colors could overlap them.
            row=row_camera_hypotheses(scene)
            robust=infer_camera_robust(detect_studs(scene['rgb'],scene['mask']))
            graph=component_graph(scene) if not red_conflict else None
            scene_records.append(dict(rank=index,xref=scene['xref'],bbox=scene['bbox'],
                native_size=[scene['rgb'].shape[1],scene['rgb'].shape[0]],inside_panel=scene['inside_panel'],
                pdf_transform=list(scene['transform']),red_fraction=scene['red_arrow_fraction'],
                row_cameras=row['hypotheses'],robust_camera=robust,
                component_count=len(graph['components']) if graph else None,
                component_areas=[c['area'] for c in graph['components']] if graph else None,
                arrows=graph['arrows'] if graph else None,
                arrow_graph_status='conditional: base colors safe; printed-color conflict not excluded' if graph else 'abstain: red base-color conflict'))
        hints=[];qty=sum(e['qty'] for e in additions)
        if qty>2:hints.append('more_than_two_additions_requires_batch_or_group_search')
        if len({e['part'] for e in additions})>1:hints.append('mixed_part_additions')
        if any(e['qty']>1 for e in additions):hints.append('quantity_may_span_panels_or_repeated_subassemblies')
        inset_count=sum(s['inside_panel'] for s in scene_records)
        if inset_count:hints.append('inset_main_rigid_group_correspondence_required')
        if len(scene_records)>1:hints.append('scene_order_must_follow_pdf_layout_not_area_rank')
        if not additions:hints.append('no_assigned_callout_page_may_rotate_or_attach_existing_group')
        if scene_records and not (scene_records[0]['row_cameras'] or scene_records[0]['robust_camera'].get('ok')):
            hints.append('top_scene_camera_unresolved')
        text=page.get_text()
        records.append(dict(page_index=page_index,printed_page=page_index+1,
            additions=additions,assigned_addition_count=qty,cumulative_assigned_count=sum(e['qty'] for e in cumulative),
            scene_candidates=scene_records,main_candidate_xrefs=[s['xref'] for s in scene_records if not s['inside_panel']],
            inset_candidate_xrefs=[s['xref'] for s in scene_records if s['inside_panel']],
            red_base_color_conflicts=red_conflict,deterministic_hints=hints,page_text=text))
        pix=page.get_pixmap(matrix=pymupdf.Matrix(.6,.6),alpha=False)
        im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples);im.thumbnail((315,255))
        x=((page_index-2)%5)*320;y=((page_index-2)//5)*300
        sheet.paste(im,(x,y+35));draw.text((x+4,y+2),f'PDF {page_index+1}: +{qty}; scenes {len(scenes)} / insets {inset_count}',fill='black')
        draw.text((x+4,y+17),f'camera row/robust: '+','.join(f'{len(s["row_cameras"])}/{int(s["robust_camera"].get("ok",False))}' for s in scene_records[:4]),fill='black')
        print(f'page={page_index} additions={qty} scenes={len(scenes)}',flush=True)
    sheet.save(out/'pages-contact.png')
    remaining=[r for r in records if r['page_index']>=7]
    result=dict(pdf=str(pdf),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),
        assignment_source=str(source),assignment_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        truth_used=False,runtime_vlm_calls=0,hand_entered_runtime_ids=False,
        assignment_totals={k:assignment[k] for k in ['callouts','assigned','assigned_pieces','unresolved']},
        remaining_summary=dict(pages=len(remaining),assigned_pieces=sum(r['assigned_addition_count'] for r in remaining),
            pages_with_more_than_two_additions=sum(r['assigned_addition_count']>2 for r in remaining),
            pages_with_insets=sum(bool(r['inset_candidate_xrefs']) for r in remaining),
            top_scene_camera_supported=sum(bool(r['scene_candidates'] and (r['scene_candidates'][0]['row_cameras'] or r['scene_candidates'][0]['robust_camera'].get('ok'))) for r in remaining)),
        pages=records,manual_observations=[],limitations=[
            'Historical global identity assignment is a hypothesis, not verified per-page ground truth.',
            'Area-ranked main image is not guaranteed final or complete assembly.',
            'Camera proposals and arrow components are not certified semantic correspondences.',
            'Printed colors can conflict with arrow hue even where base part palette is safe.',
            'No placement is generated or certified by this roadmap.'])
    (out/'roadmap.json').write_text(json.dumps(result,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);run(p.parse_args().out)
