"""Color-first completed centered-stack grammar from native PDF inset.

PDF white bottom/plain blue middle/striped blue top; all24 global frames,
both long-axis yaws for each brick. No incomplete-state or silhouette pruning.
"""
import argparse,hashlib,json
from pathlib import Path
import cv2,numpy as np,pymupdf
from placement_beam import assembly,rotations
from placement_colored_cad import nativecolor_render
from placement_part_library import PartLibrary
from placement_part_edges import canonical,features,compare
from vector_scene import scene_images

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--camera-file',type=Path);parser.add_argument('--out',type=Path,default=Path('output/pdf-placement-diagnosis/subassembly-colored-stack'))
    args=parser.parse_args();out=args.out;out.mkdir(parents=True,exist_ok=True)
    names=['placement_colored_stack_trial.py','placement_colored_cad.py','placement_part_library.py','placement_part_edges.py','vector_scene.py']
    hashes={n:hashlib.sha256((Path(__file__).parent/n).read_bytes()).hexdigest() for n in names}
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf')
    with pymupdf.open(pdf) as doc:scene=next(s for s in scene_images(doc,doc[4]) if s['xref']==23)
    if args.camera_file:
        camera=json.loads(args.camera_file.read_text())
        if not camera['ok']:raise ValueError('PDF image camera unresolved')
        M=np.asarray(camera['matrix'])
    else:M=np.asarray(json.loads(Path('output/pdf-placement-diagnosis/studs/cameras.json').read_text())[-1]['camera']['matrix'])
    library=PartLibrary();rgb,mask=canonical(scene['rgb'],scene['mask']);target=features(rgb,mask)
    def labels(rgb,mask):
        hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
        yellow=(hsv[:,:,0]>15)&(hsv[:,:,0]<40)&(hsv[:,:,1]>90)
        # Dark shaded blue is chromatic blue, not a black outline.
        black=(rgb.mean(2)<70)&(hsv[:,:,1]<65)
        return np.where(mask==0,0,np.where(yellow,3,np.where(black,4,np.where(hsv[:,:,1]<65,1,2))))
    targetlabels=labels(rgb,mask);records=[]
    for R in rotations():
        for plainyaw in [False,True]:
            for printyaw in [False,True]:
                middle=np.eye(4);middle[1,3]=-24
                top=np.eye(4);top[1,3]=-48
                if plainyaw:middle[:3,:3]=np.diag([-1,1,-1])
                if printyaw:top[:3,:3]=np.diag([-1,1,-1])
                items=[('3710',15,R),('3010',1,R@middle),('3010pb291',1,R@top)]
                index=len(records);image=nativecolor_render(items,M,out/f'color-{index:03d}.png',resolver=library.resolve)
                candidate,candmask=canonical(image['rgb'],image['mask']);edge,_=compare(features(candidate,candmask),target)
                colors=labels(candidate,candmask);union=(mask>0)|(candmask>0)
                agreement=float((colors[union]==targetlabels[union]).mean())
                pattern=float(((colors==3)&(targetlabels==3)).sum()/max(1,((colors==3)|(targetlabels==3)).sum()))
                records.append({'items':items,'score':.4*edge+.35*agreement+.25*pattern,'edge':edge,'color_agreement':agreement,'pattern_iou':pattern,'render':str(out/f'color-{index:03d}.png'),'geometry_files':image['metadata']})
    records.sort(key=lambda r:-r['score']);results=[]
    for i,record in enumerate(records[:20]):
        surrogate=[('3010' if p=='3010pb291' else p,c,T) for p,c,T in record['items']]
        text=assembly(surrogate).to_ldr('0 PDF-only complete centered-stack hypothesis; actual printedCAD; uncertified')
        lines=text.splitlines();lines[-1]=lines[-1].removesuffix('3010.dat')+'3010pb291.dat'
        (out/f'group_{i:03d}.ldr').write_text('\n'.join(lines)+'\n')
        results.append({k:v for k,v in record.items() if k!='items'}|{'transforms':[T.tolist() for p,c,T in record['items']]})
    report={'pdf':str(pdf.resolve()),'pdf_sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'source_page':4,'source_xref':23,'runtime_vlm_calls':0,'truth_used':False,'certified':False,'part_ids_derived_from_pdf':True,'parts':[['3710',15],['3010',1],['3010pb291',1]],'candidate_count':len(records),'code_sha256_start':hashes,'universal_aliases':library.provenance,'connector_collision_proxy':{'3010pb291':'3010','render_uses_actual_colored_cad':True},'results':results,'limitations':['Centeredthree-layer grammar inferred from isolatednativeinset; notgeneral-purposeassembly','Allcompletedcandidates scored withrealpattern; no externalposeinputs','Plainbrick180degreeorientation physicallysymmetric andnotvisuallydisambiguated']}
    report.update(projection=M.tolist(),camera_file=str(args.camera_file) if args.camera_file else None)
    (out/'results.json').write_text(json.dumps(report,indent=2));print(out/'results.json')
