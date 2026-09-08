"""Generic page/group extraction from frozen deterministic PDF allocations.

No hardcoded set, page, part IDs, quantities or poses. More than two additions
are explicit unresolved grouping, not silently interpreted as one pair.
"""
import argparse,hashlib,json,re
from pathlib import Path
import cv2,pymupdf
from vector_scene import scene_images
from vector_scene_components import component_graph
from placement_camera import infer_camera_robust,infer_camera_row
from placement_studs import detect_studs
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_pair_topology import arrow_pair_components
from placement_scene_overlap import contained_fragments


def inset_multiplier(page,scene):
    box=pymupdf.Rect(scene['bbox']);center=(box.tl+box.br)/2
    panels=[]
    for drawing in page.get_drawings():
        rect=drawing['rect']
        if drawing.get('fill') is not None and rect.contains(center) and rect.get_area()>1500 and rect.width<.92*page.rect.width and rect.height<.85*page.rect.height:
            panels.append(rect)
    if not panels:return dict(multiplier=None,reason='No containing inset panel')
    panel=min(panels,key=lambda r:r.get_area())
    words=[w for w in page.get_text('words') if re.fullmatch(r'[1-9]\d*x',w[4]) and panel.contains((pymupdf.Rect(w[:4]).tl+pymupdf.Rect(w[:4]).br)/2)]
    if len(words)!=1:return dict(multiplier=None,reason='Inset quantity missing or ambiguous',quantity_words=[list(w[:5]) for w in words])
    return dict(multiplier=int(words[0][4][:-1]),panel_bbox=list(panel),quantity_word=list(words[0][:5]),method='Unique native PDF quantity text within smallest containing inset panel')


def load_allocations(pdf,page,allocation_run):
    manifest=json.loads((allocation_run/'manifest.json').read_text())
    if 'allocation_pages' in manifest and page not in manifest['allocation_pages']:
        raise ValueError('Page outside explicitly validated slot-adapter allocation scope')
    path=allocation_run/'global-assignment.json';assignment=json.loads(path.read_text())
    if manifest.get('allocation_pages')!=assignment.get('allocation_pages'):
        raise ValueError('Allocation manifest/assignment page scopes disagree')
    digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    claimed=manifest.get('pdf_sha256') or manifest.get('inputs_sha256',{}).get(manifest.get('pdf'))
    if claimed!=digest:raise ValueError('PDF allocation cache hash mismatch')
    if not manifest.get('pdf_only') or assignment.get('pdf_only') is not True:raise ValueError('Allocation provenance is not PDF-only')
    if manifest.get('runtime_vlm_calls')!=0 or assignment.get('runtime_vlm_calls')!=0:raise ValueError('Runtime VLM-free provenance missing')
    rows=[r for r in assignment['evidence'] if r['page']==page]
    pieces=[(str(r['part']),int(r['color'])) for r in rows for _ in range(int(r['qty']))]
    return pieces,dict(pdf_sha256=digest,allocation_file=str(path.resolve()),allocation_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),allocation_evidence=rows)


def extract(pdf,page,allocation_run,out,prior_parts=None,refine_halo=False):
    out.mkdir(parents=True,exist_ok=True);pieces,provenance=load_allocations(pdf,page,allocation_run);records=[]
    palette=protected_cad_colors(pieces+list(prior_parts or []))
    if not palette['complete']:raise ValueError('Cannot safely infer arrows with missing allocated-part CAD print colors')
    with pymupdf.open(pdf) as doc:
        doc[page].get_pixmap(matrix=pymupdf.Matrix(1.5,1.5)).save(str(out/'page.png'))
        text=doc[page].get_text()
        native_scenes=scene_images(doc,doc[page])
        for scene in native_scenes:
            graph=conservative_components(scene,protected_colors=palette['rgb'])
            if refine_halo:
                from placement_arrow_halo import refine_arrow_halo
                graph=refine_arrow_halo(scene,graph,palette['rgb'])
            if not scene['inside_panel'] and prior_parts is None:
                # Prior assembly print colors are unknown here. Preserve main
                # artwork intact; this extractor need not segment that scene.
                graph={'components':[{'mask':scene['mask'],'bbox':(0,0,scene['mask'].shape[1],scene['mask'].shape[0]),'area':int(scene['mask'].sum())}],'arrows':[]}
            studs=detect_studs(scene['rgb'],scene['mask']);camera=infer_camera_robust(studs)
            if not camera.get('ok'):camera=infer_camera_row(studs)
            unique_parts=list(dict.fromkeys(pieces))
            if not camera.get('ok') and scene['inside_panel'] and graph['arrows'] and len(unique_parts)==2:
                from placement_two_stud_camera import infer_component_pair_camera
                camera=infer_component_pair_camera(scene,graph,unique_parts)
            arrows=graph['arrows']
            topology=None
            if arrows:
                try:_,topology=arrow_pair_components(graph)
                except ValueError as exc:topology={'error':str(exc)}
            kind='exploded_pair' if topology and 'error' not in topology else 'completed_component' if len(graph['components'])==1 else 'unresolved_components'
            if not scene['inside_panel']:kind='main_scene'
            cv2.imwrite(str(out/f"xref-{scene['xref']}.png"),cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2BGR))
            repetition=inset_multiplier(doc[page],scene) if scene['inside_panel'] else dict(multiplier=None)
            records.append({k:v for k,v in scene.items() if k not in ('rgb','mask')}|dict(kind=kind,components=[{k:v for k,v in c.items() if k!='mask'} for c in graph['components']],arrows=graph['arrows'],camera=camera,repetition=repetition,arrow_topology=topology))
    overlaps=contained_fragments(native_scenes)
    for overlap in overlaps:
        if overlap['redundant']:
            record=records[overlap['fragment_index']]
            record['original_kind']=record['kind'];record['kind']='overlapping_fragment';record['overlap_evidence']=overlap
    status='pair_evidence_ready' if len(pieces)==2 else 'unresolved_multi_part_grouping' if len(pieces)>2 else 'not_a_pair'
    groups=[]
    for scene in records:
        multiplier=scene['repetition'].get('multiplier')
        if multiplier and multiplier>1 and all(int(r['qty'])%multiplier==0 for r in provenance['allocation_evidence']):
            per_group=[(str(r['part']),int(r['color'])) for r in provenance['allocation_evidence'] for _ in range(int(r['qty'])//multiplier)]
            if len(per_group)==2 and scene['kind'] in ('exploded_pair','completed_component'):
                groups.append(dict(source_xref=scene['xref'],parts=per_group,multiplier=multiplier,repetition_evidence=scene['repetition'],kind=scene['kind']))
    if len(groups)==1:status='repeated_pair_evidence_ready'
    result=dict(pdf=str(pdf.resolve()),source_page=page,truth_used=False,runtime_vlm_calls=0,part_ids_derived_from_pdf=True,parts=pieces,
        page_text=text,scenes=records,status=status,pair_groups=groups,protected_cad_palette=palette,prior_palette_provided=prior_parts is not None,overlap_diagnostics=overlaps,**provenance,
        limitations=['Frozen allocation identity errors remain possible','Unique same-panel quantity repetition supported; arbitrary numbered or cross-page subassembly segmentation remains unresolved','Only newly allocated part palettes known unless prior_parts supplied; main scene remains unsegmented when prior print colors unknown','This extracts evidence only; does not invent poses or certify an assembly'])
    (out/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(dict(status=status,parts=pieces,scenes=[(r['xref'],r['kind']) for r in records])))
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path);p.add_argument('--page',type=int,required=True);p.add_argument('--allocation-run',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();extract(a.pdf,a.page,a.allocation_run,a.out)
