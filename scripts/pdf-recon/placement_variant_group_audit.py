"""Native group-structure audit preserving ambiguous inventory-slot choices."""
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
from placement_step_graph import layout_graph,extract_layout,link_pages
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_pair_topology import arrow_pair_components
from placement_palette_classes import palette_labels as classify
from placement_colored_cad import _rgb
from placement_multirow_camera import row_camera_hypotheses
from placement_camera import infer_camera_robust
from placement_studs import detect_studs
from vector_scene import scene_images


def run(pdf,slots_file,out):
    out.mkdir(parents=True,exist_ok=True);assignment=json.loads(slots_file.read_text())
    assert assignment['pdf_only'] and assignment['truth_used'] is False and assignment['runtime_vlm_calls']==0
    assert hashlib.sha256(pdf.read_bytes()).hexdigest()==assignment['pdf_sha256']
    with pymupdf.open(pdf) as doc:
        graphs=[layout_graph(extract_layout(doc,page,assignment)) for page in (12,13,14)]
        records=[]
        from PIL import Image,ImageDraw
        images=[]
        for graph in graphs:
            page=graph['page'];allocations=graph['allocations']
            parts=[(choice['part'],int(choice['color'])) for row in allocations for choice in row['part_choices']]
            colors=sorted(set(c for p,c in parts));palette=protected_cad_colors(parts) if parts else None
            scenes=scene_images(doc,doc[page]);scene_records=[]
            for scene in scenes:
                clean=conservative_components(scene,palette['rgb']) if palette and palette['complete'] else None
                mask=clean['clean_mask'] if clean else scene['mask']
                camera=infer_camera_robust(detect_studs(scene['rgb'],mask))
                rows=row_camera_hypotheses(dict(scene,mask=mask))
                counts={};supported=[];eligible=[];pair_candidate=None;topology=None
                if colors:
                    labels,_=classify(scene['rgb'],mask,np.stack([_rgb(c) for c in colors]).astype(np.uint8))
                    counts={str(c):int((labels==i+1).sum()) for i,c in enumerate(colors)}
                    supported=[c for c in colors if counts[str(c)]>=max(10,.02*mask.sum())]
                    eligible=[dict(inventory_slot=a['inventory_slot'],qty=a['qty'],part_choices=a['part_choices'])
                        for a in allocations if any(int(ch['color']) in supported for ch in a['part_choices'])]
                if clean and clean['arrows']:
                    try:
                        components,topology=arrow_pair_components(clean)
                        if len(eligible)==1 and eligible[0]['qty']==2 and len(eligible[0]['part_choices'])==1:
                            choice=eligible[0]['part_choices'][0]
                            pair_candidate=dict(parts=[choice,choice],inventory_slot=eligible[0]['inventory_slot'],
                                reason='Two arrow-linked components; only one supported-color allocated identity with quantity2',
                                certified=False,requires='Each component must independently match one universal CAD part')
                    except ValueError as exc:topology=dict(error=str(exc))
                scene_records.append(dict(xref=scene['xref'],bbox=list(scene['bbox']),
                    supported_base_colors=supported,color_pixel_counts=counts,eligible_allocation_slots=eligible,
                    component_count=len(clean['components']) if clean else None,
                    component_areas=[c['area'] for c in clean['components']] if clean else None,
                    arrows=clean['arrows'] if clean else [],arrow_topology=topology,
                    robust_camera=camera,row_camera_hypotheses=rows['hypotheses'],pair_partition_candidate=pair_candidate))
                image=Image.fromarray(scene['rgb']);image.thumbnail((330,260));images.append((f'index{page} xref{scene["xref"]} colors{supported}',image))
            kind='isolated_ordered_group' if graph['groups'] else 'main_attachment_batch' if allocations else 'continuation_or_display'
            records.append(dict(page=page,kind=kind,allocations=allocations,group_graph=graph,
                scene_evidence=scene_records,protected_palette=palette,
                independent_group_ready=bool(graph['groups']),
                prerequisites=['Prior full assembly required; page has no isolated group artwork'] if kind=='main_attachment_batch' else []))
        sheet=Image.new('RGB',(1050,300*((len(images)+2)//3)),'white');draw=ImageDraw.Draw(sheet)
        for i,(label,im) in enumerate(images):
            x=(i%3)*350;y=(i//3)*300;draw.text((x+3,y+3),label,fill='black');sheet.paste(im,(x,y+25))
        sheet.save(out/'native-contact.png')
    report=dict(pdf=str(pdf),pdf_sha256=assignment['pdf_sha256'],slot_source=str(slots_file),
        slot_source_sha256=hashlib.sha256(slots_file.read_bytes()).hexdigest(),
        assigned_pieces=assignment['assigned_pieces'],ambiguous_identity_pieces=assignment['ambiguous_identity_pieces'],
        pages=records,continuation_edges=link_pages(graphs),truth_used=False,runtime_vlm_calls=0,
        manual_part_or_pose_inputs=False,certified=False,
        classification='Standalone pastel-aware palette labels with relative saturation and brightness floors',
        limitations=['Color support limits plausible allocated identities but cannot count occluded parts.',
            'Ambiguous slot choices remain alternatives sharing one inventory capacity.',
            'Exploded second stage needs stable-component and arrow-contact evidence, not complete assembled silhouette.'])
    (out/'results.json').write_text(json.dumps(report,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path);p.add_argument('--slots',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.pdf,a.slots,a.out)
