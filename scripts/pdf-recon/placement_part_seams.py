"""Optional visible part-instance seams; never triangle wireframe boundaries."""
import cv2
import numpy as np
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_part_edges import features,compare


def instance_seams(mask,owner,triangle_instances):
    """Map one-based visible triangle owners to instances, then mark transitions.

    Only pixels occupied on both sides contribute. Adjacent triangles within
    one physical part therefore cannot introduce an internal diagonal.
    """
    mask=np.asarray(mask,bool);owner=np.asarray(owner,np.int64)
    mapping=np.asarray(triangle_instances,np.int64)
    if np.any(owner[mask]<1) or np.any(owner[mask]>len(mapping)):
        raise ValueError('Visible triangle owner outside instance mapping')
    instances=np.full(mask.shape,-1,np.int64);instances[mask]=mapping[owner[mask]-1]
    seam=np.zeros(mask.shape,bool)
    for dy,dx in ((1,0),(0,1)):
        a=(slice(dy,None),slice(dx,None));b=(slice(None,-dy or None),slice(None,-dx or None))
        seam[a]|=mask[a]&mask[b]&(instances[a]!=instances[b])
    return seam


class PartSeamSceneScorer(MaterialFeatureSceneScorer):
    """Blend a fixed optional seam-edge term; default zero preserves baseline."""
    def __init__(self,*args,seam_weight=0.,**kwargs):
        if not 0<=seam_weight<=1:raise ValueError('seam_weight must be in [0,1]')
        super().__init__(*args,**kwargs);self.seam_weight=float(seam_weight)
        self.last_seams=None;self.last_seam_outline=None

    def score(self,items,projection,renderpath=None):
        evidence=super().score(items,projection)
        if evidence.get('bbox_rejected'):return evidence
        mapping=np.concatenate([np.full(len(self.geometry[(part,str(color))]['triangles']),i,np.int32)
            for i,(part,color,T) in enumerate(items)])
        layer=self.last_layer
        seam=instance_seams(layer['mask'][0],layer['owner'][0],mapping)
        outline=self.last_outline.copy();outline[seam]=[20,20,20]
        matched=outline.copy();matched[~self.last_mask]=245
        edge,details=compare(features(matched,self.last_mask.astype(np.uint8)),self.target_features)
        old_edge=evidence['edge_score'];mixed=(1-self.seam_weight)*old_edge+self.seam_weight*edge
        baseline=evidence['score'];score=(1-self.edge_weight)*evidence['material_color_score']+self.edge_weight*mixed
        evidence.update(score=float(score),baseline_score=baseline,baseline_edge_score=old_edge,
            seam_edge_score=float(edge),edge_score=float(mixed),seam_weight=self.seam_weight,
            seam_pixels=int(seam.sum()),new_seam_pixels=int((seam&~self.last_edges).sum()),
            seam_edge_details=details,seam_protocol='Visible triangle owner mapped to physical part instance; adjacent occupied instance transitions only')
        self.last_seams=seam;self.last_seam_outline=outline
        if renderpath:cv2.imwrite(str(renderpath),cv2.cvtColor(outline,cv2.COLOR_RGB2BGR))
        return evidence
