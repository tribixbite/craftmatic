"""Reusable fixed-camera raster layers with explicit depth/order semantics.

No existing renderer API changes. All layers to be composited must use one
shared depth_offset, physical projection, canvas and image origin.
"""
import argparse
import json
import time
from pathlib import Path
import numpy as np
from placement_cuda_planes import PlaneTriangleRasterizer,plane_coefficients


class LayerRasterizer(PlaneTriangleRasterizer):
    def render_depth(self,triangles,colors,width,height,depth_offset=None,device=False):
        """Return rgb[B,H,W,3], mask/depth/owner[B,H,W], unoccupied depth=-inf.

        depth_offset defaults to one scalar across this entire batch. Reuse
        that scalar explicitly for subsequent cached-layer raster calls.
        device=True retains CuPy arrays; existing render() remains unchanged.
        """
        tri=np.asarray(triangles,np.float64);colors=np.asarray(colors,np.uint8)
        if tri.ndim!=4 or tri.shape[2:]!=(3,3):raise ValueError('Expected B,T,3,3 triangles')
        batches,nt=tri.shape[:2]
        if colors.shape!=(batches,nt,3):raise ValueError('Expected RGB per triangle')
        if not batches or not nt or min(width,height)<1 or not np.isfinite(tri).all():raise ValueError('Invalid raster input')
        offset=float(1.-tri[:,:,:,2].min()) if depth_offset is None else float(depth_offset)
        if not np.isfinite(offset) or np.min(tri[:,:,:,2])+offset<=0:raise ValueError('Depth offset must keep all geometry positive')
        planes,_=plane_coefficients(tri);planes[:,:,2]+=offset
        cp=self.cp;gt=cp.asarray(tri,dtype=cp.float32);gp=cp.asarray(planes,dtype=cp.float32);gc=cp.asarray(colors)
        packed=cp.zeros((batches,height,width),cp.uint64);rgb=cp.empty((batches,height,width,3),cp.uint8)
        self.plane_raster(((batches*nt+127)//128,),(128,),
            (gt,gp,packed,np.int32(batches),np.int32(nt),np.int32(width),np.int32(height)))
        self.resolve(((batches*width*height+255)//256,),(256,),
            (packed,gc,rgb,np.int32(batches),np.int32(nt),np.int32(width*height)))
        owner=(packed&cp.uint64(0xffffffff)).astype(cp.uint32);mask=owner!=0
        depth_bits=(packed>>cp.uint64(32)).astype(cp.uint32)
        depth=cp.where(mask,depth_bits.view(cp.float32)-offset,-cp.inf)
        result=dict(rgb=rgb,mask=mask,depth=depth,depth_bits=depth_bits,owner=owner,
            depth_offset=offset,triangle_count=nt,layer_order='Later layer wins exact depth ties; triangles retain input order')
        if not device:
            result={k:cp.asnumpy(v) if isinstance(v,cp.ndarray) else v for k,v in result.items()}
        return result

    def composite(self,layers,device=False):
        """Composite layer records in supplied order, matching joint geometry.

        Each record can hold one or several consecutive layers in its batch.
        Offset mismatch is rejected, not silently approximately corrected.
        """
        if not layers:raise ValueError('No layers')
        cp=self.cp;offset=layers[0]['depth_offset']
        if any(row['depth_offset']!=offset for row in layers):raise ValueError('Layer depth offsets differ')
        rgb=cp.concatenate([cp.asarray(row['rgb']) for row in layers])
        bits=cp.concatenate([cp.asarray(row['depth_bits']) for row in layers])
        masks=cp.concatenate([cp.asarray(row['mask']) for row in layers])
        priority=cp.arange(1,len(rgb)+1,dtype=cp.uint64)[:,None,None]
        keys=cp.where(masks,(bits.astype(cp.uint64)<<cp.uint64(32))|priority,cp.uint64(0))
        selected=cp.argmax(keys,axis=0);mask=cp.any(masks,axis=0)
        y,x=cp.indices(mask.shape);image=rgb[selected,y,x]
        image=cp.where(mask[:,:,None],image,cp.uint8(245))
        selected_bits=bits[selected,y,x]
        depth=cp.where(mask,selected_bits.view(cp.float32)-offset,-cp.inf)
        result=dict(rgb=image,mask=mask,depth=depth,selected_layer=cp.where(mask,selected,-1),depth_offset=offset)
        if not device:result={k:cp.asnumpy(v) if isinstance(v,cp.ndarray) else v for k,v in result.items()}
        return result

    def composite_pairs(self,base,groups,pairs,device=True):
        """Compose a bounded batch of base + group[i] + group[j] on the GPU.

        Caller chunks pair indices (e.g.128 at96px), then immediately scores
        and releases output. Group bank entries share one cached canvas.
        """
        if base['depth_offset']!=groups['depth_offset']:raise ValueError('Layer depth offsets differ')
        cp=self.cp;pairs=cp.asarray(pairs,dtype=cp.int32)
        if pairs.ndim!=2 or pairs.shape[1]!=2:raise ValueError('Expected N,2 indices')
        base_bits=cp.asarray(base['depth_bits']);group_bits=cp.asarray(groups['depth_bits'])
        if base_bits.shape[0]!=1:raise ValueError('Expected one base layer')
        a=group_bits[pairs[:,0]];b=group_bits[pairs[:,1]]
        take_a=(a>0)&(a>=base_bits[0]);first=cp.where(take_a,a,base_bits[0])
        take_b=(b>0)&(b>=first);best=cp.where(take_b,b,first);mask=best>0
        group_rgb=cp.asarray(groups['rgb']);base_rgb=cp.asarray(base['rgb'])
        rgb=cp.where(take_a[:,:,:,None],group_rgb[pairs[:,0]],base_rgb[0])
        rgb=cp.where(take_b[:,:,:,None],group_rgb[pairs[:,1]],rgb)
        rgb=cp.where(mask[:,:,:,None],rgb,cp.uint8(245))
        result=dict(rgb=rgb,mask=mask,depth=cp.where(mask,best.view(cp.float32)-base['depth_offset'],-cp.inf),
            depth_offset=base['depth_offset'])
        if not device:result={k:cp.asnumpy(v) if isinstance(v,cp.ndarray) else v for k,v in result.items()}
        return result


def diagnostic(out):
    from placement_colored_cad import colored_triangles,_rgb
    from placement_part_library import PartLibrary
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    raster=LayerRasterizer();resolver=PartLibrary().resolve
    M=np.array([[1.,0.,-1.],[.5,1.,.5]])*.8;camera=np.cross(M[0],M[1]);camera/=np.linalg.norm(camera)
    def geometry(part,color,translation):
        g=colored_triangles(part,color,resolver=resolver);t=g['triangles']+np.asarray(translation)
        xy=t@M.T+np.array([64.,48.]);z=t@camera
        return np.concatenate((xy,z[:,:,None]),axis=2),np.stack([_rgb(c) for c in g['colors']]).astype(np.uint8)
    fixtures=[('overlapping_real_parts',[geometry('3001',4,[0,0,0]),geometry('3020',1,[10,-8,0])]),
        ('coplanar_real_parts',[geometry('3001',4,[0,0,0]),geometry('3001',1,[0,0,0])])]
    results=[]
    for name,parts in fixtures:
        offset=1.-min(t[:,:,2].min() for t,c in parts)
        layers=[raster.render_depth(t[None],c[None],128,96,depth_offset=offset,device=True) for t,c in parts]
        composed=raster.composite(layers)
        joint_tri=np.concatenate([t for t,c in parts]);joint_colors=np.concatenate([c for t,c in parts])
        joint=raster.render_depth(joint_tri[None],joint_colors[None],128,96,depth_offset=offset)
        equal=np.array_equal(composed['rgb'],joint['rgb'][0]) and np.array_equal(composed['mask'],joint['mask'][0])
        depth_equal=np.array_equal(composed['depth'],joint['depth'][0])
        reversed_layers=raster.composite(layers[::-1])
        rt=np.concatenate([t for t,c in parts[::-1]]);rc=np.concatenate([c for t,c in parts[::-1]])
        reverse_joint=raster.render_depth(rt[None],rc[None],128,96,depth_offset=offset)
        reverse_equal=np.array_equal(reversed_layers['rgb'],reverse_joint['rgb'][0])
        assert equal and depth_equal and reverse_equal
        assert np.isneginf(composed['depth'][~composed['mask']]).all()
        import cv2
        cv2.imwrite(str(out/f'{name}.png'),cv2.cvtColor(composed['rgb'],cv2.COLOR_RGB2BGR))
        raster.cp.cuda.Stream.null.synchronize();start=time.perf_counter()
        for _ in range(100):raster.composite(layers,device=True)
        raster.cp.cuda.Stream.null.synchronize();seconds=time.perf_counter()-start
        results.append(dict(name=name,joint_rgb_mask_exact=equal,joint_depth_exact=depth_equal,
            reversed_layer_order_exact=reverse_equal,compositions=100,seconds=seconds,
            foreground_pixels=int(composed['mask'].sum()),shared_depth_offset=offset))
    rejection=False
    try:raster.composite([dict(layers[0],depth_offset=1.),dict(layers[1],depth_offset=2.)])
    except ValueError:rejection=True
    assert rejection
    # Batch API must preserve duplicate and reversed indices and later-copy
    # ties exactly, rather than sorting an unordered input pair internally.
    bank={k:raster.cp.concatenate([row[k] for row in layers]) if k in ('rgb','mask','depth','depth_bits','owner') else layers[0][k] for k in layers[0]}
    indices=np.array([[0,1],[1,0],[0,0],[1,1]])
    batch=raster.composite_pairs(layers[0],bank,indices,device=False)
    for n,(i,j) in enumerate(indices):
        reference=raster.composite([layers[0],layers[i],layers[j]])
        assert np.array_equal(batch['rgb'][n],reference['rgb']) and np.array_equal(batch['depth'][n],reference['depth'])
    many=np.tile(indices,(32,1));raster.composite_pairs(layers[0],bank,many)
    raster.cp.cuda.Stream.null.synchronize();start=time.perf_counter()
    for _ in range(100):raster.composite_pairs(layers[0],bank,many)
    raster.cp.cuda.Stream.null.synchronize();batch_seconds=time.perf_counter()-start
    (out/'results.json').write_text(json.dumps(dict(fixtures=results,offset_mismatch_rejected=rejection,
        batch_pair_rgb_depth_exact=True,batched_compositions=12800,batch_seconds=batch_seconds,
        truth_used=False,scope='Universal CAD renderer composition controls; no reconstruction accuracy claim'),indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);diagnostic(p.parse_args().out)
