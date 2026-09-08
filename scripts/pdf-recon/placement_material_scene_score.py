"""Optional material-ID and visible-edge scoring with pastel-aware PDF colors."""
import numpy as np
from placement_colored_cad import _rgb
from placement_feature_scene_score import PdfFeatureSceneScorer
from placement_palette_classes import palette_labels,material_render


class MaterialFeatureSceneScorer(PdfFeatureSceneScorer):
    material_colors=True
    def score(self,items,projection,renderpath=None):
        evidence=super().score(items,projection,renderpath)
        if evidence.get('bbox_rejected'):return evidence
        rendered=material_render(self,items,projection)
        colors=rendered['colors'];palette=np.stack([_rgb(c) for c in colors]).astype(np.uint8)
        target,valid=palette_labels(self.rgb,self.mask,palette)
        regions={};supported=[]
        for index,color in enumerate(colors):
            a=(target==index+1)&valid;b=(rendered['labels']==index+1)&valid
            intersection=int((a&b).sum());union=int((a|b).sum());count=int(a.sum())
            iou=intersection/max(1,union)
            regions[str(color)]=dict(target=count,render=int(b.sum()),intersection=intersection,union=union,iou=iou)
            if count:supported.append(iou)
        material=float(np.mean(supported)) if supported else 0.
        evidence.update(photometric_color_score=evidence['color_score'],material_color_score=material,
            material_regions=regions,color_score=material,
            score=(1-self.edge_weight)*material+self.edge_weight*evidence['edge_score'],
            scoring_protocol='Visible CAD material IDs versus pastel-aware PDF color classes plus fixed-native visible edges',
            material_protocol=rendered['protocol'])
        return evidence
