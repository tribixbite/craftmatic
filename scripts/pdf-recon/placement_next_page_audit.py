"""Native next-page scene evidence only; no reference assembly input."""
import json,hashlib
from pathlib import Path
import pymupdf,cv2
from vector_scene import scene_images
from vector_scene_components import component_graph

if __name__=='__main__':
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');out=Path('output/pdf-placement-diagnosis/next-page6');out.mkdir(exist_ok=True)
    with pymupdf.open(pdf) as doc:
        page=doc[6];page.get_pixmap(matrix=pymupdf.Matrix(1.5,1.5)).save(str(out/'page.png'));text=page.get_text();records=[]
        for scene in scene_images(doc,page):
            cv2.imwrite(str(out/f"xref-{scene['xref']}.png"),cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2BGR))
            graph=component_graph(scene)
            records.append({k:v for k,v in scene.items() if k not in ('rgb','mask')}|dict(components=[{k:v for k,v in c.items() if k!='mask'} for c in graph['components']],arrows=graph['arrows']))
    (out/'results.json').write_text(json.dumps(dict(pdf=str(pdf),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),source_page=6,page_text=text,scenes=records,truth_used=False,runtime_vlm_calls=0),indent=2))
