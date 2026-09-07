"""Strict recursive LDraw color-preserving CAD parser and native renderer.

Type1 color16 inherits parent color; explicit child/face colors override it.
Type3/4 geometry retains per-triangle colors. Missing dependencies raise; no
cuboid fallback. Set geometry/poses are never supplied by this module.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import cv2
import numpy as np
sys.path.insert(0,'C:/git/clego')
from recon_v7.render import color_rgb

LDRAW=Path('C:/git/clego/extracted/studio_release/app/ldraw')


def _code(text):
    return int(text,16) if str(text).lower().startswith('0x') else int(text)


def colored_triangles(part,basecolor,overridepath=None,resolver=None):
    """Return {triangles:(N,3,3), colors:(N,), files:{path:sha256}}.

    overridepath may be one replacement .dat file or a local library directory.
    It affects only universal part geometry lookup, not runtime model poses.
    """
    override=Path(overridepath) if overridepath is not None else None
    roots=[LDRAW/'parts',LDRAW/'p',LDRAW/'UnOfficial/parts',LDRAW/'UnOfficial/p']
    if override:
        root=override.parent if override.is_file() else override
        roots=[root,root/'parts',root/'p']+roots
    cache={};files={}
    def resolve(name,parent=None):
        name=str(name).replace('\\','/')
        if not name.lower().endswith('.dat'):name+='.dat'
        if override and override.is_file() and override.name.lower()==Path(name).name.lower():return override.resolve()
        if resolver is not None:
            try:return Path(resolver(name)).resolve()
            except FileNotFoundError:pass
        choices=([parent/name] if parent else [])+[root/name for root in roots]
        for path in choices:
            if path.is_file():return path.resolve()
        raise FileNotFoundError(f'Unresolved universal CAD dependency {name}')
    def parse(path,current,stack):
        if path in stack:raise ValueError(f'Cyclic LDraw reference: {path}')
        if len(stack)>64:raise ValueError('LDraw nesting exceeds64')
        key=(path,current)
        if key in cache:return cache[key]
        data=path.read_bytes();files[str(path)]=hashlib.sha256(data).hexdigest();triangles=[];colors=[]
        for line in data.decode('utf-8',errors='replace').splitlines():
            f=line.split()
            if not f or f[0] not in ('1','3','4'):continue
            color=_code(f[1]);color=current if color==16 else color
            if f[0]=='1':
                if len(f)<15:raise ValueError(f'Malformed type1 in {path}')
                offset=np.asarray(list(map(float,f[2:5])));rotation=np.asarray(list(map(float,f[5:14]))).reshape(3,3)
                child=resolve(' '.join(f[14:]),path.parent)
                tris,codes=parse(child,color,stack+(path,))
                if len(tris):triangles.extend((tris.reshape(-1,3)@rotation.T+offset).reshape(-1,3,3));colors.extend(codes)
            else:
                count=3 if f[0]=='3' else 4
                if len(f)!=2+3*count:raise ValueError(f'Malformed type{f[0]} in {path}')
                vertices=np.asarray(list(map(float,f[2:]))).reshape(count,3)
                triangles.append(vertices[[0,1,2]]);colors.append(color)
                if count==4:triangles.append(vertices[[0,2,3]]);colors.append(color)
        result=(np.asarray(triangles,dtype=float).reshape(-1,3,3),np.asarray(colors,dtype=np.int64))
        cache[key]=result;return result
    root_path=override.resolve() if override is not None and override.is_file() else resolve(part)
    triangles,colors=parse(root_path,_code(basecolor),())
    if not len(triangles):raise ValueError(f'No triangle geometry for {part}')
    return dict(triangles=triangles,colors=colors,files=files)


def _rgb(code):
    if code>=0x2000000:return np.array([(code>>16)&255,(code>>8)&255,code&255],float)
    return np.asarray(color_rgb(int(code)),float)


def nativecolor_render(items,projection,out,overridepath=None,origin=None,size=None,resolver=None):
    """Render (part,color,T) items at projection's native scale.

    Returns RGB, geometric mask, image_origin, and full dependency provenance.
    image_xy = projection @ world_xyz + image_origin.
    """
    projection=np.asarray(projection,float);tris=[];codes=[];files={}
    for part,color,T in items:
        # A single-file override applies only to a one-part render. Multi-part
        # callers should supply an authoritative name-aware resolver instead.
        if overridepath is not None and Path(overridepath).is_file() and len(items)!=1:
            raise ValueError('Single-file override requires one item; use resolver for assemblies')
        parsed=colored_triangles(part,color,overridepath,resolver);T=np.asarray(T,float)
        tris.append((parsed['triangles'].reshape(-1,3)@T[:3,:3].T+T[:3,3]).reshape(-1,3,3))
        codes.append(parsed['colors']);files.update(parsed['files'])
    triangles=np.concatenate(tris);colors=np.concatenate(codes)
    projected=(triangles.reshape(-1,3)@projection.T).reshape(-1,3,2)
    lo=projected.reshape(-1,2).min(0);hi=projected.reshape(-1,2).max(0)
    origin=np.array([4.,4.])-lo if origin is None else np.asarray(origin,float)
    size=np.ceil(hi-lo+9).astype(int) if size is None else np.asarray(size,int)
    rgb=np.full((size[1],size[0],3),245,np.uint8);mask=np.zeros(rgb.shape[:2],np.uint8)
    camera=np.cross(projection[0],projection[1]);camera/=np.linalg.norm(camera)
    light=np.array([.75,-1,.15]);light/=np.linalg.norm(light)
    normal=np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0])
    normal/=np.maximum(1e-8,np.linalg.norm(normal,axis=1,keepdims=True))
    normal*=np.where((normal@camera)>=0,1.,-1.)[:,None]
    illumination=np.maximum(0,normal@light)
    base=np.stack([_rgb(c) for c in colors]);shaded=np.clip(base*(.42+.58*illumination[:,None])+40*illumination[:,None],0,255).astype(np.uint8)
    order=np.argsort(triangles.mean(axis=1)@camera,kind='stable')
    pixels=np.round(projected+origin).astype(np.int32)
    for i in order:
        cv2.fillConvexPoly(rgb,pixels[i],tuple(map(int,shaded[i])));cv2.fillConvexPoly(mask,pixels[i],1)
    out=Path(out);out.parent.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(out),cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR))
    metadata=dict(triangle_count=len(triangles),color_counts={str(int(c)):int((colors==c).sum()) for c in np.unique(colors)},
        files=files,image_origin=origin.tolist(),projection=projection.tolist())
    out.with_suffix('.json').write_text(json.dumps(metadata,indent=2),encoding='utf-8')
    return dict(rgb=rgb,mask=mask>0,image_origin=origin,metadata=metadata)


def selftest(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    fixture=out/'fixtures';fixture.mkdir(exist_ok=True)
    (fixture/'leaf.dat').write_text('3 16 0 0 0 1 0 0 0 1 0\n3 14 0 0 1 1 0 1 0 1 1\n')
    (fixture/'parent.dat').write_text('1 4 10 0 0 1 0 0 0 1 0 0 0 1 leaf.dat\n4 16 0 0 0 1 0 0 1 1 0 0 1 0\n')
    parsed=colored_triangles('parent',1,fixture)
    assert parsed['colors'].tolist()==[4,14,1,1]
    assert np.allclose(parsed['triangles'][0,0],[10,0,0])
    missing_rejected=False
    try:colored_triangles('missing-should-not-exist',1,fixture)
    except FileNotFoundError:missing_rejected=True
    assert missing_rejected
    override=Path('output/pdf-universal-parts/3010py3.dat')
    actual=colored_triangles('3010py3',1,override)
    matrix=np.array([[1.,0,-1.],[.5,1,.5]])*2
    front=np.eye(4);front[:3,:3]=np.diag([-1.,1.,-1.])
    result=nativecolor_render([('3010py3',1,front)],matrix,out/'3010-pattern.png',override)
    record=dict(inheritance_colors=parsed['colors'].tolist(),translation_preserved=True,missing_rejected=missing_rejected,
        actual_triangles=len(actual['triangles']),actual_colors=sorted(map(int,np.unique(actual['colors']))),
        actual_dependency_files=len(actual['files']),protocol='Universal part data only; no model truth')
    (out/'selftest.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
    assert {0,1,14}.issubset(set(actual['colors']))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);selftest(parser.parse_args().out)
