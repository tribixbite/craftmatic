"""Native scene calibration survey; original masks, no arrow-color removal."""
import json
from pathlib import Path
import pymupdf
from vector_scene import scene_images
from placement_studs import detect_studs
from placement_camera import infer_camera_robust

if __name__=='__main__':
    import sys
    pdf=Path(sys.argv[1]);out=Path('output/pdf-placement-diagnosis/camera-survey')
    out.mkdir(parents=True,exist_ok=True);rows=[]
    with pymupdf.open(pdf) as doc:
        for page in range(min(12,len(doc))):
            scenes=scene_images(doc,doc[page])
            if not scenes:continue
            scene=scenes[0]
            detections=detect_studs(scene['rgb'],scene['mask'])
            rows.append({'page':page,'xref':scene['xref'],'detections':detections,'calibration':infer_camera_robust(detections)})
            if len(rows)>=10:break
    (out/(pdf.stem+'.json')).write_text(json.dumps({'scope':'Native PDF scene masks unchanged; no arrow hue/color removal. Calibration acceptance is not pose accuracy.','pdf':str(pdf),'scenes':rows,'accepted':sum(r['calibration']['ok'] for r in rows)},indent=2))
