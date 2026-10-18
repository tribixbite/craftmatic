"""PDF-only feature reranking of an existing truth-free candidate beam."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from placement_arrow_contacts import read_items
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_attach_group import make_assembly
from placement_feature_scene_score import PdfFeatureSceneScorer
from vector_scene import scene_images


def run(pdf,source,out,edge_weight=.5,material_colors=False):
    if out.exists():raise ValueError('Choose a new output directory')
    metadata=json.loads((source/'results.json').read_text());digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    if metadata.get('pdf_sha256')!=digest or metadata.get('truth_used') is not False or metadata.get('runtime_vlm_calls')!=0:
        raise ValueError('Candidate provenance must be this PDF, truth-free and runtime VLM-free')
    out.mkdir(parents=True);snapshot=out/'source';snapshot.mkdir();hashes={}
    for path in Path(__file__).parent.glob('*.py'):
        payload=path.read_bytes();(snapshot/path.name).write_bytes(payload);hashes[path.name]=hashlib.sha256(payload).hexdigest()
    candidates=[];part_colors=set()
    for row in metadata['results']:
        path=source/row['file'];items=read_items(path)
        part_colors.update((p,c) for p,c,T in items)
        candidates.append(dict(source=row['file'],items=items,projection=np.asarray(row['projection']),
                               source_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    palette=protected_cad_colors(sorted(part_colors))
    if not palette['complete']:raise ValueError('Incomplete CAD palette')
    with pymupdf.open(pdf) as doc:
        scenes=[s for s in scene_images(doc,doc[metadata['page']]) if s['xref']==metadata['xref']]
        if len(scenes)!=1:raise ValueError('Target native scene not unique')
        scene=scenes[0];clean=conservative_components(scene,palette['rgb'])
        scene=dict(scene,mask=clean['clean_mask'])
    if material_colors:
        from placement_material_scene_score import MaterialFeatureSceneScorer
        scorer=MaterialFeatureSceneScorer(scene,plane_depth=True,edge_weight=edge_weight)
    else:scorer=PdfFeatureSceneScorer(scene,plane_depth=True,edge_weight=edge_weight)
    for row in candidates:row['evidence']=scorer.score(row['items'],row['projection'])
    candidates.sort(key=lambda row:-row['evidence']['score']);records=[]
    for index,row in enumerate(candidates):
        filename=f'beam_{index:02d}.ldr';model=make_assembly(row['items']).to_ldr('0 PDF visible-feature reranking; uncertified')
        (out/filename).write_text(model,encoding='utf-8')
        if index==0:
            (out/'model.ldr').write_text(model,encoding='utf-8')
            scorer.score(row['items'],row['projection'],out/'selected.png')
        records.append({k:v for k,v in row.items() if k not in ('items','projection')}|
                       dict(file=filename,projection=row['projection'].tolist()))
    report=dict(pdf=str(pdf.resolve()),pdf_sha256=digest,pdf_only=True,truth_used=False,runtime_vlm_calls=0,
        certified=False,page=metadata['page'],xref=metadata['xref'],source_run=str(source),
        source_results_sha256=hashlib.sha256((source/'results.json').read_bytes()).hexdigest(),
        selected_parts=len(candidates[0]['items']),edge_weight=edge_weight,material_colors=material_colors,results=records,
        code_sha256_start=hashes,limitations=['Reranks retained candidates only; no new pose hypotheses',
            'Image evidence is approximate and is not a placement accuracy certificate'])
    (out/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(dict(selected_source=records[0]['source'],evidence=records[0]['evidence'])))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path);p.add_argument('--source',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True);p.add_argument('--edge-weight',type=float,default=.5)
    p.add_argument('--material-colors',action='store_true')
    a=p.parse_args();run(a.pdf,a.source,a.out,a.edge_weight,a.material_colors)
