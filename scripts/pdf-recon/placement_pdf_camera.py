"""Choose an explicit PDF-derived stud-camera hypothesis with provenance."""
from placement_camera import infer_camera
from placement_studs import detect_studs
from vector_scene import scene_images
from vector_scene_components import component_graph


def camera_for(doc,page,lookahead=3):
    attempts=[]
    for index in range(page,min(len(doc),page+lookahead+1)):
        for scene in scene_images(doc,doc[index]):
            if scene['inside_panel']:continue
            graph=component_graph(scene)
            if not graph['components']:continue
            detections=detect_studs(scene['rgb'],graph['components'][0]['mask'])
            result=infer_camera(detections)
            evidence={'page':index,'xref':scene['xref'],'detections':detections,'inference':result}
            attempts.append(evidence)
            if result['ok']:
                return {'matrix':result['matrix'],'evidence':evidence,
                        'limitations':['Axes chosen up to signed permutation',
                                       'Later pages may rotate the assembly; calibration is not registration']}
    return {'matrix':None,'attempts':attempts,'unresolved':'No supported planar stud grid'}
