"""Opt-in exact cache of immutable PDF material classes; baseline unchanged."""
import numpy as np
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_feature_scene_score import PdfFeatureSceneScorer
from placement_palette_classes import palette_labels,material_render
from placement_colored_cad import _rgb


class CachedMaterialFeatureScorer(MaterialFeatureSceneScorer):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self._material_target_cache={}

    def score(self,items,projection,renderpath=None):
        evidence=PdfFeatureSceneScorer.score(self,items,projection,renderpath)
        if evidence.get('bbox_rejected'):return evidence
        rendered=material_render(self,items,projection);colors=rendered['colors'];key=tuple(colors)
        if key not in self._material_target_cache:
            target,valid=palette_labels(self.rgb,self.mask,np.stack([_rgb(c) for c in colors]).astype(np.uint8))
            masks=[(target==index+1)&valid for index in range(len(colors))]
            self._material_target_cache[key]=(valid,masks,[int(a.sum()) for a in masks])
        valid,masks,counts=self._material_target_cache[key];regions={};supported=[]
        for index,color in enumerate(colors):
            a=masks[index];b=(rendered['labels']==index+1)&valid
            intersection=int((a&b).sum());union=int((a|b).sum());count=counts[index];iou=intersection/max(1,union)
            regions[str(color)]=dict(target=count,render=int(b.sum()),intersection=intersection,union=union,iou=iou)
            if count:supported.append(iou)
        material=float(np.mean(supported)) if supported else 0.
        evidence.update(photometric_color_score=evidence['color_score'],material_color_score=material,
            material_regions=regions,color_score=material,
            score=(1-self.edge_weight)*material+self.edge_weight*evidence['edge_score'],
            scoring_protocol='Visible CAD material IDs versus pastel-aware PDF color classes plus fixed-native visible edges',material_protocol=rendered['protocol'])
        return evidence
