"""Read-only native inset mask and ellipse scale audit."""
from pathlib import Path
import json
import numpy as np,cv2,pymupdf
from vector_scene import scene_images
from placement_studs import detect_studs
from placement_part_edges import canonical

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis/subassembly-image-audit');out.mkdir(parents=True,exist_ok=True)
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:scene=next(s for s in scene_images(doc,doc[4]) if s['xref']==23)
    studs=detect_studs(scene['rgb'],scene['mask']);points=np.array([s['center'] for s in studs]);rgb,mask=canonical(scene['rgb'],scene['mask'])
    cv2.imwrite(str(out/'native-mask.png'),scene['mask'].astype(np.uint8)*255)
    cv2.imwrite(str(out/'canonical-rgb.png'),cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(out/'canonical-mask.png'),mask*255)
    result={k:v for k,v in scene.items() if k not in ('rgb','mask')}
    result.update(shape=list(scene['rgb'].shape),mask_fraction=float(scene['mask'].mean()),studs=studs,consecutive_stud_distances=np.linalg.norm(np.diff(points,axis=0),axis=1).tolist() if len(points)>1 else [])
    (out/'results.json').write_text(json.dumps(result,indent=2));print(out/'results.json')
