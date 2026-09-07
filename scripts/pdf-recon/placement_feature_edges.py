"""Isolated depth-visible CAD outlines; existing photo scorer unchanged."""
import cv2
import numpy as np
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_cuda_layers import LayerRasterizer


def visible_edges(mask,depth,owner,normals,normal_angle=35.,depth_jump=2.):
    mask=np.asarray(mask,bool);normal=np.zeros((*mask.shape,3),float)
    normal[mask]=normals[np.asarray(owner[mask],int)-1]
    edge=mask&~(cv2.erode(mask.astype(np.uint8),np.ones((3,3),np.uint8))>0)
    for dy,dx in ((1,0),(0,1)):
        a=(slice(dy,None),slice(dx,None));b=(slice(None,-dy or None),slice(None,-dx or None))
        valid=mask[a]&mask[b];dot=np.abs(np.sum(normal[a]*normal[b],axis=2))
        delta=np.zeros(valid.shape,float);np.subtract(depth[a],depth[b],out=delta,where=valid)
        change=valid&((dot<np.cos(np.radians(normal_angle)))|(np.abs(delta)>depth_jump))
        edge[a]|=change
    return edge


class FeatureEdgeScorer(GpuColoredSceneScorer):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.layer_rasterizer=LayerRasterizer();self.last_outline=None;self.last_edges=None
    def score(self,items,projection,renderpath=None):
        ev=super().score(items,projection)
        if ev.get('bbox_rejected'):return ev
        M=np.asarray(projection,float);camera=np.cross(M[0],M[1]);camera/=np.linalg.norm(camera)
        triangles=[];colors=[];normals=[]
        for part,color,T in items:
            T=np.asarray(T,float);p=self._project_part(part,color,T,M)
            xy=p['xy']+M@T[:3,3]+np.asarray(ev['image_origin']);z=p['vertex_depth']+camera@T[:3,3]
            triangles.append(np.concatenate((xy,z[:,:,None]),axis=2));colors.append(p['shaded'])
            world=self.geometry[(part,str(color))]['triangles']@T[:3,:3].T
            n=np.cross(world[:,1]-world[:,0],world[:,2]-world[:,0]);n/=np.maximum(1e-9,np.linalg.norm(n,axis=1,keepdims=True));normals.append(n)
        layer=self.layer_rasterizer.render_depth(np.concatenate(triangles)[None],np.concatenate(colors)[None],self.rgb.shape[1],self.rgb.shape[0])
        mask=layer['mask'][0];depth=layer['depth'][0];owner=layer['owner'][0];normals=np.concatenate(normals)
        edges=visible_edges(mask,depth,owner,normals,depth_jump=max(2.,2/np.linalg.norm(M[0])))
        outline=layer['rgb'][0].copy();outline[edges]=[20,20,20]
        self.last_outline=outline;self.last_edges=edges
        ev['visible_edge_pixels']=int(edges.sum());ev['outline_protocol']='Visible normal discontinuity35degrees, depthjump>=2LDU, silhouette; no hidden wireframe'
        if renderpath:cv2.imwrite(str(renderpath),cv2.cvtColor(outline,cv2.COLOR_RGB2BGR))
        return ev
