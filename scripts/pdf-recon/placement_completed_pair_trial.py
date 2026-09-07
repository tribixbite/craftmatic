"""All legal connected pairs, scored only as complete native PDF subassemblies."""
import hashlib,json,time
from pathlib import Path
import numpy as np,pymupdf,cv2
from placement_beam import assembly,rotations
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_camera import infer_camera_robust,infer_camera_row,infer_camera
from placement_studs import detect_studs
from vector_scene import scene_images


def run():
    source=Path(__file__).parent;hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.glob('*.py')}
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');out=Path('output/pdf-placement-diagnosis/plate-pair');out.mkdir(exist_ok=True)
    with pymupdf.open(pdf) as doc:scene=next(s for s in scene_images(doc,doc[6]) if s['xref']==54)
    cv2.imwrite(str(out/'native.png'),cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2BGR))
    studs=detect_studs(scene['rgb'],scene['mask']);attempts={n:f(studs) for n,f in [('robust',infer_camera_robust),('grid',infer_camera),('row',infer_camera_row)]}
    camera=next((attempts[n] for n in ('robust','grid','row') if attempts[n]['ok']),None)
    (out/'camera.json').write_text(json.dumps(dict(studs=studs,attempts=attempts),indent=2))
    if camera is None:raise ValueError('Own native inset camera unresolved')
    M=np.asarray(camera['matrix']);scorer=GpuColoredSceneScorer(scene);base=assembly([('3710',15,np.eye(4))])
    mates=base.candidates('3020',kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False)
    rows=[];tested=0;start=time.time()
    for ri,R in enumerate(rotations()):
        for mate in mates:
            items=[('3710',15,R),('3020',15,R@mate['T'])];ev=scorer.score(items,M);tested+=1
            if ev.get('bbox_rejected'):continue
            rows.append(dict(items=items,evidence=ev))
        print('rotation',ri,'tested',tested,'retained',len(rows),flush=True)
    rows.sort(key=lambda r:-r['evidence']['score']);results=[]
    for i,row in enumerate(rows[:20]):
        name=f'group_{i:03d}.ldr';(out/name).write_text(assembly(row['items']).to_ldr('0 PDF-only completed plate pair; uncertified'))
        if i<4:scorer.score(row['items'],M,out/f'group_{i:03d}.png')
        results.append(dict(file=name,evidence=row['evidence'],transforms=[T.tolist() for p,c,T in row['items']]))
    report=dict(pdf=str(pdf),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),source_page=6,source_xref=54,truth_used=False,runtime_vlm_calls=0,
        parts=[['3710',15],['3020',15]],part_ids_derived_from_pdf=True,part_id_evidence='Native PDF PLI quantity1x each; explicit numbered inset shows 1x4 plate then 2x4 plate; universal silhouette ID interpretation, no numeric design IDs in page text.',
        group_anchor_part='3710',group_anchor_index=0,attachment_members=[0,1],projection=M.tolist(),camera=camera,candidate_count=tested,legal_pair_count=len(mates),retained_count=len(rows),results=results,
        seconds=time.time()-start,code_sha256_start=hashes,certified=False,limitations=['Candidate frame yaw may be physically symmetric','Final attachment must consider both members; inset does not mandate attachment through its first part'])
    (out/'results.json').write_text(json.dumps(report,indent=2));print('COMPLETE',results[:1])


if __name__=='__main__':run()
