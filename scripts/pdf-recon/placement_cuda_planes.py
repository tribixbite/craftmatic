"""Optional plane-coefficient depth rasterizer; existing CUDA mode unchanged.

Pass original float64 projected triangles: prior float32 coordinate rounding
can destroy exact coplanarity and cannot be undone by this adapter.
"""
import numpy as np
from placement_cuda_triangles import TriangleRasterizer,CUDA


PLANE_CUDA=CUDA.replace('const float* tris, unsigned long long* z,',
    'const float* tris, const float* planes, unsigned long long* z,').replace(
    'float depth=a*p[2]+b*p[5]+c*p[8];',
    'const float* plane=planes+i*3; float depth=plane[0]*x+plane[1]*y+plane[2];')


def plane_coefficients(triangles):
    """Solve z=ax+by+c in float64, canonicalize coefficients to 1e-8."""
    tri=np.asarray(triangles,np.float64)
    e1=tri[...,1,:]-tri[...,0,:];e2=tri[...,2,:]-tri[...,0,:]
    denominator=e1[...,0]*e2[...,1]-e1[...,1]*e2[...,0]
    good=np.abs(denominator)>=1e-7;safe=np.where(good,denominator,1.)
    a=(e1[...,2]*e2[...,1]-e1[...,1]*e2[...,2])/safe
    b=(e1[...,0]*e2[...,2]-e1[...,2]*e2[...,0])/safe
    c=tri[...,0,2]-a*tri[...,0,0]-b*tri[...,0,1]
    return np.round(np.stack((a,b,c),axis=-1),8),good


class PlaneTriangleRasterizer(TriangleRasterizer):
    def __init__(self):
        super().__init__()
        self.plane_raster=self.cp.RawKernel(PLANE_CUDA,'raster',options=('--std=c++11',))

    def render(self,triangles,colors,width,height):
        tri=np.asarray(triangles,np.float64);colors=np.asarray(colors,np.uint8)
        if tri.ndim!=4 or tri.shape[2:]!=(3,3):raise ValueError('Expected B,T,3,3 triangles')
        batches,nt=tri.shape[:2]
        if colors.shape!=(batches,nt,3):raise ValueError('Expected RGB per triangle')
        if not batches or not nt or width<1 or height<1 or not np.isfinite(tri).all():raise ValueError('Invalid raster input')
        planes,good=plane_coefficients(tri)
        # Apply one common positive-depth offset after canonicalizing planes.
        planes[:,:,2]-=tri[:,:,:,2].min(axis=(1,2))[:,None]-1.
        cp=self.cp;gpu_tri=cp.asarray(tri,dtype=cp.float32);gpu_planes=cp.asarray(planes,dtype=cp.float32)
        gpu_colors=cp.asarray(colors);z=cp.zeros((batches,height,width),dtype=cp.uint64)
        rgb=cp.empty((batches,height,width,3),dtype=cp.uint8)
        self.plane_raster(((batches*nt+127)//128,),(128,),
            (gpu_tri,gpu_planes,z,np.int32(batches),np.int32(nt),np.int32(width),np.int32(height)))
        self.resolve(((batches*width*height+255)//256,),(256,),
            (z,gpu_colors,rgb,np.int32(batches),np.int32(nt),np.int32(width*height)))
        return cp.asnumpy(rgb),cp.asnumpy(z!=0)
