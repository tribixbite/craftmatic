"""Deterministic native CUDA triangle depth buffer, with workspace-only cache.

Rasterization uses interpolated depth, not triangle-centroid painter ordering.
Equal-depth fragments resolve by stable triangle index, preserving CAD overlays.
"""
import os
from pathlib import Path
import sys
import numpy as np


CUDA = r'''
extern "C" __global__ void raster(const float* tris, unsigned long long* z,
                                  int batches, int nt, int width, int height) {
    int i=blockIdx.x*blockDim.x+threadIdx.x;
    if(i>=batches*nt) return;
    int batch=i/nt, tri=i%nt;
    const float* p=tris+i*9;
    float ax=p[0],ay=p[1],bx=p[3],by=p[4],cx=p[6],cy=p[7];
    float d=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy);
    if(fabsf(d)<1e-7f) return;
    int x0=max(0,(int)ceilf(fminf(ax,fminf(bx,cx))));
    int x1=min(width-1,(int)floorf(fmaxf(ax,fmaxf(bx,cx))));
    int y0=max(0,(int)ceilf(fminf(ay,fminf(by,cy))));
    int y1=min(height-1,(int)floorf(fmaxf(ay,fmaxf(by,cy))));
    for(int y=y0;y<=y1;++y) for(int x=x0;x<=x1;++x) {
        float a=((by-cy)*(x-cx)+(cx-bx)*(y-cy))/d;
        float b=((cy-ay)*(x-cx)+(ax-cx)*(y-cy))/d;
        float c=1.f-a-b;
        if(a < -1e-5f || b < -1e-5f || c < -1e-5f) continue;
        float depth=a*p[2]+b*p[5]+c*p[8];
        unsigned long long key=((unsigned long long)__float_as_uint(depth)<<32)|(unsigned int)(tri+1);
        atomicMax(z+(batch*height+y)*width+x,key);
    }
}
extern "C" __global__ void resolve(const unsigned long long* z,const unsigned char* colors,
                                    unsigned char* rgb,int batches,int nt,int pixels) {
    int i=blockIdx.x*blockDim.x+threadIdx.x;
    if(i>=batches*pixels) return;
    unsigned int index=(unsigned int)z[i];
    for(int c=0;c<3;++c) rgb[i*3+c]=index?colors[((i/pixels)*nt+index-1)*3+c]:245;
}
'''


class TriangleRasterizer:
    def __init__(self):
        root=Path(__file__).resolve().parents[2]
        sys.path.insert(0,str(root/'output/pdf-gpu-deps13'))
        os.environ.setdefault('CUPY_CACHE_DIR',str(root/'output/pdf-cuda-kernel-cache'))
        import cupy as cp
        self.cp=cp
        cp.get_default_memory_pool().set_limit(size=512*1024*1024)
        self.raster=cp.RawKernel(CUDA,'raster',options=('--std=c++11',))
        self.resolve=cp.RawKernel(CUDA,'resolve',options=('--std=c++11',))

    def render(self,triangles,colors,width,height):
        """triangles[B,T,3,3] are native pixel x/y and toward-camera depth."""
        triangles=np.asarray(triangles,np.float32).copy()
        colors=np.asarray(colors,np.uint8)
        if triangles.ndim!=4 or triangles.shape[2:]!=(3,3):raise ValueError('Expected B,T,3,3 triangles')
        batches,nt=triangles.shape[:2]
        if colors.shape!=(batches,nt,3):raise ValueError('Expected one RGB color per triangle')
        if not batches or not nt or width<1 or height<1 or not np.isfinite(triangles).all():raise ValueError('Invalid raster input')
        # Positive IEEE floats have unsigned-integer depth order. One offset
        # per batch preserves all visibility relations, including negative Z.
        triangles[:,:,:,2]-=triangles[:,:,:,2].min(axis=(1,2))[:,None,None]-1
        cp=self.cp;gpu_tri=cp.asarray(triangles);gpu_colors=cp.asarray(colors)
        z=cp.zeros((batches,height,width),dtype=cp.uint64)
        rgb=cp.empty((batches,height,width,3),dtype=cp.uint8)
        self.raster(((batches*nt+127)//128,),(128,),
                    (gpu_tri,z,np.int32(batches),np.int32(nt),np.int32(width),np.int32(height)))
        self.resolve(((batches*width*height+255)//256,),(256,),
                     (z,gpu_colors,rgb,np.int32(batches),np.int32(nt),np.int32(width*height)))
        return cp.asnumpy(rgb),cp.asnumpy(z!=0)


def selftest(out):
    import json,time
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    raster=TriangleRasterizer()
    # Identical projected triangles whose depths cross: centroid ordering
    # cannot draw both halves correctly. The per-pixel depth buffer can.
    tris=np.array([[[[2,2,3],[28,2,0],[2,28,3]],[[2,2,0],[28,2,3],[2,28,0]]]],np.float32)
    colors=np.array([[[255,0,0],[0,0,255]]],np.uint8)
    rgb,mask=raster.render(tris,colors,32,32)
    assert (rgb[0,5,5]==[255,0,0]).all()
    assert (rgb[0,3,24]==[0,0,255]).all()
    again,again_mask=raster.render(tris,colors,32,32)
    assert np.array_equal(rgb,again) and np.array_equal(mask,again_mask)
    reverse,reverse_mask=raster.render(tris[:,::-1],colors[:,::-1],32,32)
    # Away from the equal-depth seam, triangle input order does not matter.
    assert (reverse[0,5,5]==rgb[0,5,5]).all() and (reverse[0,3,24]==rgb[0,3,24]).all()
    translated=tris.copy();translated[:,:,:,2]-=1000
    shifted,shifted_mask=raster.render(translated,colors,32,32)
    assert np.array_equal(rgb,shifted) and np.array_equal(mask,shifted_mask)
    coplanar=tris.copy();coplanar[:,:,:,2]=7
    overlay,overlay_mask=raster.render(coplanar,colors,32,32)
    assert (overlay[0,5,5]==colors[0,1]).all()
    batch=np.repeat(tris,32,axis=0);palette=np.repeat(colors,32,axis=0)
    start=time.perf_counter()
    for _ in range(100):raster.render(batch,palette,32,32)
    elapsed=time.perf_counter()-start
    result={'crossing_depth_control':True,'repeat_exact':True,'input_order_off_seam':True,
            'depth_translation_invariant':True,'coplanar_overlay_order':True,
            'renders':3200,'seconds':elapsed,'peak_pool_bytes':raster.cp.get_default_memory_pool().total_bytes(),
            'scope':'Synthetic rasterizer correctness and microbenchmark, not reconstruction accuracy',
            'cupy_version':raster.cp.__version__}
    (out/'selftest.json').write_text(json.dumps(result,indent=2))
    import cv2
    cv2.imwrite(str(out/'crossing-depth.png'),cv2.cvtColor(rgb[0],cv2.COLOR_RGB2BGR))


if __name__=='__main__':
    selftest('output/pdf-placement-vector/cuda-triangles')
