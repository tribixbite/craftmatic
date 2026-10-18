"""Complete universal connected-pair enumeration against native PDF inset."""
from pathlib import Path
import hashlib,json
import cv2,numpy as np,pymupdf
from vector_scene import scene_images
from placement_studs import detect_studs
from placement_camera import infer_camera,infer_camera_row,infer_camera_robust

OUT=Path('output/pdf-placement-diagnosis/cylinder-pair');PDF=Path('C:/git/clego/lego_sets/PDF/6314914.pdf')

def audit():
    OUT.mkdir(parents=True,exist_ok=True)
    with pymupdf.open(PDF) as doc:
        scenes=scene_images(doc,doc[5]);text=doc[5].get_text()
        doc[5].get_pixmap(matrix=pymupdf.Matrix(1.5,1.5)).save(str(OUT/'page.png'))
        scene=next(s for s in scenes if s['xref']==41)
    cv2.imwrite(str(OUT/'native.png'),cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2BGR))
    studs=detect_studs(scene['rgb'],scene['mask'])
    cameras={name:fn(studs) for name,fn in [('grid',infer_camera),('row',infer_camera_row),('robust',infer_camera_robust)]}
    report=dict(page_text=text,studs=studs,cameras=cameras,source_page=5,source_xref=41,pdf=str(PDF),pdf_sha256=hashlib.sha256(PDF.read_bytes()).hexdigest(),truth_used=False,runtime_vlm_calls=0)
    (OUT/'audit.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
    return scene,report

def run():
    code_hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')}
    scene,report=audit()
    from placement_beam import rotations,assembly
    from placement_colored_scene_score import ColoredSceneScorer
    from placement_colored_cad import nativecolor_render,_rgb
    from placement_balanced_color_metric import balanced_color_metric
    from placement_part_library import PartLibrary
    from vector_scene_components import component_graph
    from placement_part_edges import canonical,features,compare
    graph=component_graph(scene);components=graph['components']
    if len(components)!=2:raise ValueError('Expected two explicitly separated PDF parts')
    arrows=[a for a in graph['arrows'] if not a['direction_ambiguous']]
    direction=np.mean([np.asarray(a['direction'])/np.linalg.norm(a['direction']) for a in arrows],axis=0)
    direction/=np.linalg.norm(direction);normal=np.array([-direction[1],direction[0]])
    centers=[(np.asarray(c['bbox'][:2])+c['bbox'][2:])/2 for c in components]
    baseindex=int(np.argmax([c@direction for c in centers]));movingindex=1-baseindex
    camera=report['cameras']['robust']
    if not camera['ok']:raise ValueError('Own image camera unresolved')
    M=np.asarray(camera['matrix']);library=PartLibrary();Rlist=rotations();cached={};tested=0;rows=[]
    key=lambda T:tuple(np.round(T[:3,:3].ravel(),5))
    for ci in (baseindex,movingindex):
        current=dict(scene,mask=components[ci]['mask']);scorer=ColoredSceneScorer(current)
        target=features(*canonical(current['rgb'],current['mask']))
        for ri,R in enumerate(Rlist):
            items=[('3941',15,R)];ev=scorer.score(items,M)
            if ev.get('bbox_rejected'):continue
            rendered=nativecolor_render(items,M,OUT/f'component-{ci}-rotation-{ri}.png',origin=ev['image_origin'],size=scene['rgb'].shape[1::-1],resolver=library.resolve)
            edge,_=compare(features(*canonical(rendered['rgb'],rendered['mask'])),target)
            balanced=balanced_color_metric(current['rgb'],current['mask'],rendered['rgb'],rendered['mask'],[15],{15:_rgb(15)})
            cached[(ci,key(R))]=dict(origin=np.asarray(ev['image_origin']),edge=float(edge),balanced=balanced['score'])
    for R in Rlist:
        base=assembly([('3941',15,R)])
        first=cached.get((baseindex,key(R)))
        if first is None:continue
        for mate in base.candidates('3941',kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False):
            tested+=1;T=mate['T'];second=cached.get((movingindex,key(T)))
            if second is None:continue
            # The moving component's apparent origin equals registered root
            # origin + projected mate translation - arrow separation.
            displacement=first['origin']+M@T[:3,3]-second['origin']
            transverse=abs(float(displacement@normal));slide=float(displacement@direction)
            if transverse>3 or slide<0:continue
            edge=(first['edge']+second['edge'])/2;balanced=(first['balanced']+second['balanced'])/2
            score=.5*edge+.5*balanced-.05*transverse
            rows.append(dict(items=[('3941',15,R),('3941',15,T)],score=score,edge=edge,balanced=balanced,transverse_px=transverse,arrow_slide_px=slide))
    rows.sort(key=lambda r:-r['score']);results=[]
    for i,row in enumerate(rows[:20]):
        filename=f'group_{i:03d}.ldr';(OUT/filename).write_text(assembly(row['items']).to_ldr('0 PDF-only exploded cylinder pair; uncertified'))
        results.append({k:v for k,v in row.items() if k!='items'}|dict(file=filename,transforms=[T.tolist() for p,c,T in row['items']]))
    report.update(source_page=5,source_xref=41,parts=[['3941',15],['3941',15]],part_ids_derived_from_pdf=True,
        part_id_evidence='Existing deterministic PDF PLI allocation 2x3941; page quantity2x and native cylinder/4stud/axle-hole silhouette independently inspected; page text contains no design ID.',
        group_anchor_part='3941',group_anchor_index=0,projection=M.tolist(),candidate_count=tested,accepted_count=len(rows),results=results,
        certified=False,code_sha256_start=code_hashes,
        limitations=['Exploded pair requires arrow-only separation; no completed pair image in inset','Both identical parts share anchor ID, anchor_index0 identifies registered recipient','No reference model or truth pose used; yaw symmetry may remain'])
    (OUT/'results.json').write_text(json.dumps(report,indent=2));print('COMPLETE',tested,len(rows),results[:1])

if __name__=='__main__':run()
