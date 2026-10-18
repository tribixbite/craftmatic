"""Fixed-native-pixel color and depth-visible feature evidence for placement."""
import numpy as np
from placement_feature_edges import FeatureEdgeScorer
from placement_part_edges import features,compare


class PdfFeatureSceneScorer(FeatureEdgeScorer):
    def __init__(self,*args,edge_weight=.5,**kwargs):
        if not 0<=edge_weight<=1:raise ValueError('edge_weight must be between zero and one')
        super().__init__(*args,**kwargs);self.edge_weight=float(edge_weight)
        target=self.rgb.copy();target[~self.mask]=245
        self.target_features=features(target,self.mask.astype(np.uint8))

    def score(self,items,projection,renderpath=None):
        evidence=super().score(items,projection,renderpath)
        if evidence.get('bbox_rejected'):return evidence
        outline=self.last_outline.copy();outline[~self.last_mask]=245
        edge,details=compare(features(outline,self.last_mask.astype(np.uint8)),self.target_features)
        color=evidence['score'];evidence.update(color_score=color,edge_score=float(edge),edge_details=details,
            edge_weight=self.edge_weight,score=(1-self.edge_weight)*color+self.edge_weight*edge,
            scoring_protocol='Weighted base-color regions and visible feature edges at fixed native image coordinates',
            edge_rescaled=False)
        return evidence
