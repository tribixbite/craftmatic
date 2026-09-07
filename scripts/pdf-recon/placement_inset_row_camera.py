"""Infer and save the current PDF inset's camera from its own stud row."""
from pathlib import Path
import json
from placement_camera import infer_camera_row

if __name__=='__main__':
    root=Path('output/pdf-placement-diagnosis/subassembly-image-audit')
    data=json.loads((root/'results.json').read_text());result=infer_camera_row(data['studs'])
    result.update(source_page=4,source_xref=23,truth_used=False)
    (root/'row-camera.json').write_text(json.dumps(result,indent=2));print(root/'row-camera.json')
