"""Batched deterministic surface rendering for assembly hypothesis scoring.

No learned weights or set-specific external assets. Rasterization uses sampled
universal part surfaces; this is a coarse research score, not certification.
"""
import sys
from pathlib import Path
import cv2
import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, 'C:/git/clego')
from dbix_settle import part_points
from recon_v8.partrender import part_tris


class SurfaceScorer:
    def __init__(self, size=80, device='cuda', projection=None, stud_weight=0.):
        self.device=torch.device(device)
        if self.device.type=='cuda':
            torch.cuda.set_per_process_memory_fraction(.12)
        self.size=size
        self.cache={}
        self.stud_cache={}
        self.stud_weight=stud_weight
        self.target_studs=None
        self.registration=None
        self.valid=torch.ones((size,size),dtype=torch.float32,device=self.device)
        # Same dimetric family as the source engine, but all 24 root frames
        # can be retained by the beam rather than freezing a first-piece gauge.
        self.matrix=torch.tensor(projection if projection is not None else [[1.,0.,-1.],[.5,1.,.5]],
                                 dtype=torch.float32,device=self.device)
        self.calls=0
        self.hypotheses=0

    def points(self, part):
        if part not in self.cache:
            points=np.asarray(part_points(part),np.float32)
            # Fixed evenly spaced sample indices are reproducible.
            if len(points)>3000:
                points=points[np.linspace(0,len(points)-1,3000,dtype=int)]
            # Surface subsampling may omit a real apex (15571 loses 3.33 LDU
            # at its minimum Y). Preserve actual mesh extrema for camera fit.
            vertices=part_tris(part).reshape(-1,3)
            if len(vertices):
                indices=np.concatenate((vertices.argmin(0),vertices.argmax(0)))
                points=np.concatenate((points,vertices[np.unique(indices)]))
            self.cache[part]=torch.tensor(points,device=self.device)
        return self.cache[part]

    def scene(self, mask, studs=None, unknown=None):
        ys,xs=np.where(mask)
        if len(xs)<10: raise ValueError('Scene mask has insufficient foreground')
        crop=mask[ys.min():ys.max()+1,xs.min():xs.max()+1].astype(np.uint8)
        h,w=crop.shape
        scale=(self.size-8)/max(h,w)
        resized=cv2.resize(crop,(max(1,round(w*scale)),max(1,round(h*scale))),interpolation=cv2.INTER_NEAREST)
        target=np.zeros((self.size,self.size),np.float32)
        y=(self.size-resized.shape[0])//2;x=(self.size-resized.shape[1])//2
        target[y:y+resized.shape[0],x:x+resized.shape[1]]=resized
        self.target=torch.tensor(target,device=self.device)
        # Keep the original native scene coordinate frame. Future additions in
        # lookahead images are unobserved space for the current partial model.
        valid=np.ones_like(target)
        if unknown is not None:
            if unknown.shape!=mask.shape:raise ValueError('Unknown region shape mismatch')
            cropped=unknown[ys.min():ys.max()+1,xs.min():xs.max()+1].astype(np.uint8)
            ignored=cv2.resize(cropped,(resized.shape[1],resized.shape[0]),interpolation=cv2.INTER_NEAREST)
            valid[y:y+resized.shape[0],x:x+resized.shape[1]]=1-ignored
        self.valid=torch.tensor(valid,device=self.device)
        distance=cv2.distanceTransform(((1-target)*valid).astype(np.uint8),cv2.DIST_L2,3)
        self.distance=torch.tensor(distance,device=self.device)
        self.scene_scale=scale
        self.scene_shift=np.array([x,y])-np.array([xs.min(),ys.min()])*scale
        if studs:
            centers=np.asarray([s['center'] for s in studs],float)
            centers=(centers-[xs.min(),ys.min()])*scale+[x,y]
            self.target_studs=torch.tensor(centers,dtype=torch.float32,device=self.device)
        else:self.target_studs=None
        return target

    def studs(self, part):
        if part not in self.stud_cache:
            from recon_v8.assembly import part_conns
            positions=[];axes=[];seen=set()
            for c in part_conns(part):
                if c['kind']!='CYL' or c['gender']!='M' or abs(float(c.get('r_end') or c.get('radius') or 0)-6)>.5:continue
                axis=np.asarray(c['axis'],float)
                pos=np.asarray(c['pos'],float)-4*axis
                key=tuple(np.round(np.r_[pos,axis],3))
                if key in seen:continue
                seen.add(key);positions.append(pos);axes.append(axis)
            self.stud_cache[part]=tuple(torch.tensor(np.asarray(values).reshape(-1,3),dtype=torch.float32,device=self.device)
                                       for values in (positions,axes))
        return self.stud_cache[part]

    def fixed_points(self, placements, anchor):
        result=[]
        for part,color,T in placements:
            relative=np.asarray(T).copy();relative[:3,3]-=anchor
            transform=torch.as_tensor(relative,dtype=torch.float32,device=self.device)
            result.append(self.points(part)@transform[:3,:3].T+transform[:3,3])
        return torch.cat(result) if result else torch.empty((0,3),device=self.device)

    @torch.no_grad()
    def score(self, placements, part, transforms, batch_size=32):
        """Score entire candidate assemblies, fitting scale/translation each time."""
        anchor=np.asarray(placements[0][2])[:3,3] if placements else np.zeros(3)
        fixed=self.fixed_points(placements,anchor)
        local=self.points(part)
        fixed_caps=[];fixed_axes=[]
        if self.stud_weight and self.target_studs is not None:
            for previous,_,T in placements:
                caps,axes=self.studs(previous)
                R=torch.tensor(T[:3,:3],dtype=torch.float32,device=self.device)
                offset=torch.tensor(T[:3,3]-anchor,dtype=torch.float32,device=self.device)
                fixed_caps.append(caps@R.T+offset);fixed_axes.append(axes@R.T)
            fixed_caps=torch.cat(fixed_caps) if fixed_caps else torch.empty((0,3),device=self.device)
            fixed_axes=torch.cat(fixed_axes) if fixed_axes else torch.empty((0,3),device=self.device)
            new_caps,new_axes=self.studs(part)
        scores=[]
        for begin in range(0,len(transforms),batch_size):
            relative=np.stack(transforms[begin:begin+batch_size]).copy()
            relative[:,:3,3]-=anchor
            Ts=torch.as_tensor(relative,dtype=torch.float32,device=self.device)
            moving=local[None]@Ts[:,:3,:3].transpose(1,2)+Ts[:,:3,3,None].transpose(1,2)
            points=torch.cat((fixed[None].expand(len(Ts),-1,-1),moving),dim=1)
            projected=points@self.matrix.T
            lo=projected.amin(1);hi=projected.amax(1)
            scale=(self.size-8)/(hi-lo).amax(1).clamp_min(1e-6)
            offset=(self.size-1)/2-(lo+hi)/2*scale[:,None]
            if self.registration is not None:
                scale=torch.full_like(scale,self.scene_scale)
                origin=torch.tensor(self.registration,dtype=torch.float32,device=self.device)
                anchor_tensor=torch.tensor(anchor,dtype=torch.float32,device=self.device)
                offset=((origin+self.matrix@anchor_tensor)*self.scene_scale+
                        torch.tensor(self.scene_shift,dtype=torch.float32,device=self.device))[None].expand(len(Ts),-1)
            pixels=(projected*scale[:,None,None]+offset[:,None]).round().long()
            visible_pixels=((pixels>=0)&(pixels<self.size)).all(2)
            pixels=pixels.clamp(0,self.size-1)
            index=pixels[:,:,1]*self.size+pixels[:,:,0]
            raster=torch.zeros((len(Ts),self.size*self.size),device=self.device)
            raster.scatter_reduce_(1,index,visible_pixels.float(),reduce='amax')
            raster=raster.reshape(-1,1,self.size,self.size)
            # Close sampling gaps without claiming triangle-exact rendering.
            raster=F.max_pool2d(raster,3,1,1)[:,0]
            observed=raster*self.valid
            overlap=(observed*self.target).sum((1,2))
            union=((raster+self.target-raster*self.target)*self.valid).sum((1,2)).clamp_min(1)
            spill=(observed*self.distance).sum((1,2))/observed.sum((1,2)).clamp_min(1)
            score=overlap/union-.02*spill
            if self.stud_weight and self.target_studs is not None:
                caps=new_caps[None]@Ts[:,:3,:3].transpose(1,2)+Ts[:,:3,3,None].transpose(1,2)
                axes=new_axes[None]@Ts[:,:3,:3].transpose(1,2)
                caps=torch.cat((fixed_caps[None].expand(len(Ts),-1,-1),caps),1)
                axes=torch.cat((fixed_axes[None].expand(len(Ts),-1,-1),axes),1)
                if caps.shape[1]:
                    cap_pixels=(caps@self.matrix.T)*scale[:,None,None]+offset[:,None]
                    camera=torch.linalg.cross(self.matrix[0],self.matrix[1])
                    visible=(-axes@camera)>.01
                    distances=torch.cdist(self.target_studs[None].expand(len(Ts),-1,-1),cap_pixels)
                    distances=distances.masked_fill(~visible[:,None],1e4)
                    matched=torch.exp(-distances.amin(2).square()/(2*1.5**2)).mean(1)
                    # Positive detections only: undetected/occluded studs are
                    # never interpreted as evidence that a model stud is absent.
                    score+=self.stud_weight*matched
            scores.extend(score.cpu().tolist())
        self.calls+=1;self.hypotheses+=len(transforms)
        return np.asarray(scores)
