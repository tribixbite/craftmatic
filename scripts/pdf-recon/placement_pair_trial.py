"""Standalone PDF-native exploded-pair experiment; no reference poses read."""
import argparse
import hashlib
import json
from pathlib import Path
import pymupdf
from placement_beam import rotations,assembly
from placement_exploded_pair import propose


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('pdf',type=Path)
    parser.add_argument('--page',type=int,required=True)
    parser.add_argument('--parts',nargs=2,required=True,help='Two part:color entries from instruction extraction')
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--edges',action='store_true')
    parser.add_argument('--pdf-camera',action='store_true')
    args=parser.parse_args()
    if args.out.exists():raise ValueError('Choose a new output directory')
    args.out.mkdir(parents=True)
    parts=[(p.split(':')[0],int(p.split(':')[1])) for p in args.parts]
    with pymupdf.open(args.pdf) as doc:
        camera=None
        if args.pdf_camera:
            from placement_pdf_camera import camera_for
            camera=camera_for(doc,args.page)
            if camera['matrix'] is None:raise ValueError('PDF camera unresolved')
        proposals=propose(doc,args.page,*parts,rotations(),limit=96,
                          edge_cache=args.out/'render-cache' if args.edges else None,
                          projection=camera['matrix'] if camera else None)
    for i,p in enumerate(proposals):
        (args.out/f'pair_{i:03d}.ldr').write_text(assembly(p['items']).to_ldr(),encoding='utf-8')
    report={'pdf':str(args.pdf),'pdf_sha256':hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
            'parts_list':parts,'runtime_vlm_calls':0,'poses_from_pdf_only':True,'edges':args.edges,'camera':camera,'proposals':[
                {'rank':i,'score':p['score'],'evidence':p['evidence']} for i,p in enumerate(proposals)]}
    (args.out/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report['proposals'][:4],indent=2))
