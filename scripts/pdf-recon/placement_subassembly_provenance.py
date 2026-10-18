"""Attach explicit provenance to this completed PDF-only inset experiment."""
from pathlib import Path
import hashlib,json
from placement_part_library import PartLibrary

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis/subassembly-complete');path=out/'results.json'
    result=json.loads(path.read_text())
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf')
    assignment=Path('output/pdf-crop-trial-v5/40377-joint-cnn/global-assignment.json')
    library=PartLibrary()
    names=['placement_complete_inset_trial.py','placement_colored_cad.py','placement_part_library.py','placement_gpu_render.py','placement_part_edges.py','vector_scene.py']
    result.update(pdf=str(pdf.resolve()),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),source_page=4,source_xref=23,
                  runtime_vlm_calls=0,truth_used=False,certified=False,
                  part_ids_derived_from_pdf=True,part_identity_evidence={'file':str(assignment.resolve()),'sha256':hashlib.sha256(assignment.read_bytes()).hexdigest(),'interpretation':'PDF page4 PLI matched against PDF printed element inventory; nativeinset giveswhite/plainblue/printedblue layer order'},
                  code_sha256={name:hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest() for name in names},
                  code_hash_capture='After run; entry script unchanged during execution, imported source not archived at startup',
                  universal_aliases=library.provenance,
                  connector_collision_proxy={'3010pb291':'3010','reason':'Universal catalog describes printed1x4brick; authoritative3010py3alias uses3010s01 body with coplanarpatternfaces','render_uses_proxy':False,'render_uses_actual_colored_cad':True})
    path.write_text(json.dumps(result,indent=2));print(path)
