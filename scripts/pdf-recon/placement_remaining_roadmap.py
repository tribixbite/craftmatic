"""Read-only remaining PDF graph and slot-allocation roadmap; no reference poses."""
import hashlib,json
from pathlib import Path
import pymupdf
from placement_step_graph import extract_layout,layout_graph,link_pages


if __name__=='__main__':
    source=Path('output/pdf-placement-diagnosis/40377-color-slot-assignment-v1/slot-assignment.json');assignment=json.loads(source.read_text());pdf=Path(assignment['pdf'])
    assert assignment['runtime_vlm_calls']==0 and assignment['truth_used'] is False
    assert hashlib.sha256(pdf.read_bytes()).hexdigest()==assignment['pdf_sha256']
    with pymupdf.open(pdf) as doc:graphs=[layout_graph(extract_layout(doc,page,assignment)) for page in range(13,33)]
    result=dict(pdf=str(pdf),pdf_sha256=assignment['pdf_sha256'],assignment_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),pages=graphs,edges=link_pages(graphs),truth_used=False,runtime_vlm_calls=0)
    out=Path('output/pdf-placement-diagnosis/remaining-roadmap');out.mkdir(exist_ok=True);(out/'graph.json').write_text(json.dumps(result,indent=2))
    from PIL import Image,ImageDraw
    sheet=Image.new('RGB',(1600,1500),'white');draw=ImageDraw.Draw(sheet)
    with pymupdf.open(pdf) as doc:
        for index,page in enumerate(range(13,33)):
            pix=doc[page].get_pixmap(matrix=pymupdf.Matrix(.9,.9),alpha=False);im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples);im.thumbnail((390,275));x=(index%4)*400;y=(index//4)*300;sheet.paste(im,(x,y+20));draw.text((x+3,y+2),f'PDF index {page}',fill='black')
    sheet.save(out/'pages.png')
    for page in graphs:
        print(json.dumps(dict(page=page['page'],parts=[dict(qty=r['qty'],choices=r.get('part_choices',[dict(part=r.get('part'),color=r.get('color'))])) for r in page['allocations']],groups=[dict(kind=g['kind'],copies=g['copy_count'],xrefs=g['ordered_xrefs']) for g in page['groups']],main=[s['xref'] for s in page['main_image_candidates']])))

