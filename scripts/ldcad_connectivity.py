#!/usr/bin/env python3
"""
LDCad-snap-based connectivity certifier (offline).

Uses the real LDCad shadow library (snap metadata) + the local LDraw part
library to compute true joint-level connectivity for a model, instead of the
geometry-contact approximation.

CONCLUSION (after completing all snap kinds): snaps alone CANNOT certify
connectivity. Measured with the full kind set (CYL M/F, CLP, FGR, GEN+group):
  21063 (traditional) 69%  |  42043 (Technic) 9%  |  71043 (microscale) 0.8%.
Even 21063 — which geometry-contact proves is 100% connected — reaches only
69% via snaps, and clip/finger/generic add mere tens of matches. The reason is
structural: LEGO connections are dominated by tube + CLUTCH/tile/flush/friction
contacts that designed snap points don't represent. => The certifier MUST be a
HYBRID: geometry-surface-contact (which already gives 21063=100% and shows
71043 has no floaters) as the primary, with snaps supplementing only thin
clip/bar/hinge joints geometry's voxel test misses. This engine is the complete,
validated snap half of that hybrid.

EARLIER NOTES: this is a working FOUNDATION, not a standalone certifier.
  • Shadow library acquisition + SNAP parsing + the stud↔anti-stud (SNAP_CYL
    M/F) matcher are correct: the coordinate convention validates (studs y=0,
    anti-studs y=24, a brick stacked at y=-24 makes them coincide).
  • Name-normalization lets printed/variant parts (bl_3004pb342, 3023b) inherit
    their base part's snaps.
  • Measured: 21063 (traditional stud-stacking) -> ~72% one component; the
    remainder is (a) shadow-lib coverage gaps for snapless/specialty parts and
    (b) non-cylinder joints. 71043 (microscale) -> ~1%, because it's built
    almost entirely with SNOT / clips / jumpers / cheese-slopes, which need
    SNAP_CLP / SNAP_FGR / SNAP_GEN (+ [group] id matching) handling not yet
    implemented here.
  • CONCLUSION: a complete LDCad-faithful engine must implement every snap kind
    + group-id semantics AND fall back to geometry for snapless parts. The best
    practical certifier is the HYBRID: geometry-surface-contact OR snap-match.
    Geometry-contact alone already certifies 21063 at 100% and (via the
    viewer's highlightDetached) showed 71043 has no floaters.

Pipeline:
  1. Load the LDCad shadow library (offLibShadow.csl — a zip of *.dat files
     carrying `0 !LDCAD SNAP_*` metas).
  2. For each unique part, walk its REAL .dat subfile tree (local LDraw lib),
     accumulating the transform. Wherever a shadow file exists for the file
     being visited, harvest its SNAP_CYL/GEN/CLP/FGR connectors (expanding
     [grid=...] arrays, applying [pos]/[ori]) transformed into part space.
     -> per-part list of connectors {pos, axis, radius, gender, kind}.
  3. Load the model (.io AES / .ldr) -> bricks (part, world rot+pos in LDU).
  4. Place every connector into world space; two pieces connect when a MALE
     and FEMALE connector (compatible radius, coincident position, parallel
     axis) meet -> union-find -> connected components.

Validation: a traditionally-built model (21063) must come out ~1 component.
"""
import sys, os, re, zipfile, struct, hashlib, zlib, math
from collections import defaultdict, Counter

SHADOW_CSL = r'C:\git\clego\ldcad\unpacked\offLib\offLibShadow.csl'
LDLIB      = r'C:\git\clego\extracted\studio_release\app\ldraw'

# ─── shadow library ──────────────────────────────────────────────────────────
_shadow = {}
def load_shadow():
    z = zipfile.ZipFile(SHADOW_CSL)
    for n in z.namelist():
        if n.endswith('.dat'):
            # key by bare lowercase stem (matches how we look parts up)
            stem = n.split('/')[-1].lower()
            _shadow[stem] = z.read(n).decode('utf-8', 'replace')
load_shadow()

# ─── local LDraw .dat lookup ─────────────────────────────────────────────────
_datcache = {}
def get_dat(name):
    key = name.lower().replace('\\', '/').split('/')[-1]
    if key in _datcache: return _datcache[key]
    stem = key[:-4] if key.endswith('.dat') else key
    cands = [f'parts/{stem}.dat', f'p/{stem}.dat', f'p/48/{stem}.dat',
             f'parts/s/{stem}.dat']
    # subpart refs like "s\3001s01.dat" -> parts/s/...
    if name.lower().replace('\\','/').startswith('s/'):
        cands = [f'parts/s/{stem}.dat'] + cands
    txt = None
    for c in cands:
        p = os.path.join(LDLIB, c)
        if os.path.exists(p):
            txt = open(p, encoding='utf-8', errors='replace').read(); break
    _datcache[key] = txt
    return txt

def shadow_for(name):
    return _shadow.get(name.lower().replace('\\','/').split('/')[-1])

# ─── matrix helpers (row-major 3x3 + translation) ────────────────────────────
I3 = (1,0,0, 0,1,0, 0,0,1)
def mmul(A, B):
    return tuple(sum(A[r*3+k]*B[k*3+c] for k in range(3)) for r in range(3) for c in range(3))
def mvec(A, v):
    return (A[0]*v[0]+A[1]*v[1]+A[2]*v[2], A[3]*v[0]+A[4]*v[1]+A[5]*v[2], A[6]*v[0]+A[7]*v[1]+A[8]*v[2])
def vadd(a,b): return (a[0]+b[0],a[1]+b[1],a[2]+b[2])

# ─── snap meta parsing ───────────────────────────────────────────────────────
def parse_kv(line):
    return dict(re.findall(r'\[(\w+)=([^\]]*)\]', line))

def expand_grid(g):
    """[grid=<X> <countX> <Z> <countZ> <spaceX> <spaceZ>] -> list of (x,z) offsets.
    X/Z entries: 'C'=centered or an integer count token; LDCad uses tokens like
    'C 4 C 2 20 20' (centered 4, centered 2, spacing 20 20) or '2 3 20 20'."""
    t = g.split()
    # normalise: collect counts + centered flags + spacings
    # common forms: 'C n C m sx sz'  |  'n m sx sz'  |  'C n m sx sz'
    nums=[]; cent=[]
    i=0
    while i < len(t):
        if t[i] in ('C','c'):
            cent.append(True); i+=1
            nums.append(int(float(t[i]))); i+=1
        else:
            cent.append(False); nums.append(int(float(t[i]))); i+=1
        if len(nums)==2: break
    rest=[float(x) for x in t[i:]]
    sx = rest[0] if len(rest)>0 else 20.0
    sz = rest[1] if len(rest)>1 else 20.0
    nx,nz = nums[0], nums[1]
    cx = cent[0] if len(cent)>0 else True
    cz = cent[1] if len(cent)>1 else True
    xs = [ (k-(nx-1)/2)*sx if cx else k*sx for k in range(nx) ]
    zs = [ (k-(nz-1)/2)*sz if cz else k*sz for k in range(nz) ]
    return [(x,z) for x in xs for z in zs]

def radius_of(secs):
    # secs like 'R 6 20' or 'R 8 2 R 6 16 R 8 2' -> representative radius (max)
    t = secs.split(); rs=[]
    i=0
    while i+2 < len(t)+1:
        if i < len(t) and t[i] in ('R','A','S'):
            try: rs.append(float(t[i+1]))
            except: pass
            i+=3
        else: i+=1
    return max(rs) if rs else 0.0

def harvest_snaps(text, connectors, mat, pos):
    """Parse SNAP metas from a shadow file body, emit world-in-part connectors."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith('0 !LDCAD SNAP_'): continue
        kind = line.split()[2]
        if kind not in ('SNAP_CYL','SNAP_GEN','SNAP_CLP','SNAP_FGR'): continue
        kv = parse_kv(line)
        gender = kv.get('gender','?')
        secs = kv.get('secs',''); rad = radius_of(secs)
        lp = [float(x) for x in kv.get('pos','0 0 0').split()]
        lori = [float(x) for x in kv.get('ori','1 0 0 0 1 0 0 0 1').split()] if 'ori' in kv else list(I3)
        lori = tuple(lori)
        axis_local = mvec(lori, (0,1,0))  # cylinder axis = local Y
        group = kv.get('group') or kv.get('ID') or kv.get('id')
        offsets = expand_grid(kv['grid']) if 'grid' in kv else [(0,0)]
        for (gx,gz) in offsets:
            p_local = (lp[0]+gx, lp[1], lp[2]+gz)
            wp = vadd(mvec(mat, p_local), pos)
            wax = mvec(mat, axis_local)
            connectors.append({'pos':wp,'axis':wax,'r':rad,'g':gender,'k':kind,'grp':group})

# ─── per-part connector resolution (walk real tree + shadow overlay) ─────────
def base_candidates(name):
    """Map a (possibly Studio-printed / variant) part name to base-part
    candidates so printed/decorated parts inherit their base part's snaps.
    e.g. bl_3004pb342 -> [bl_3004pb342, 3004pb342, 3004]; 3023b -> [3023b, 3023]."""
    s = name.lower().replace('\\', '/').split('/')[-1]
    s = s[:-4] if s.endswith('.dat') else s
    cands = [s]
    if s.startswith('bl_'):
        s2 = s[3:]; cands.append(s2)
    else:
        s2 = s
    m = re.match(r'^(\d+)([a-z])?', s2)
    if m:
        if m.group(2): cands.append(m.group(1) + m.group(2))  # digits + letter
        cands.append(m.group(1))                               # digits only
    # de-dup preserving order, re-add .dat
    seen=set(); out=[]
    for c in cands:
        if c not in seen: seen.add(c); out.append(c + '.dat')
    return out

_concache = {}
def resolve_connectors(name, mat=I3, pos=(0,0,0), depth=0, out=None, top=True):
    if top:
        key = name.lower().split('/')[-1]
        if key in _concache: return _concache[key]
        out = []
        # Try the name and progressively-normalized base names; use the first
        # that yields connectors (printed/variant parts inherit base snaps).
        for cand in base_candidates(name):
            tmp = []
            resolve_connectors(cand, mat, pos, depth, tmp, top=False)
            if tmp:
                _concache[key] = tmp
                return tmp
        _concache[key] = out
        return out
    if depth > 30:
        if top: _concache[name.lower().split('/')[-1]] = out
        return out
    # 1) shadow snaps for THIS file (if any)
    sh = shadow_for(name)
    if sh:
        harvest_snaps(sh, out, mat, pos)
    # 2) recurse into the REAL .dat subfile refs (to reach studs / subparts)
    real = get_dat(name)
    if real:
        for line in real.splitlines():
            t = line.split()
            if len(t) >= 15 and t[0] == '1':
                try:
                    x,y,z = float(t[2]),float(t[3]),float(t[4])
                    R = tuple(float(v) for v in t[5:14])
                except: continue
                sub = ' '.join(t[14:]).strip()
                cm = mmul(mat, R)
                cp = vadd(mvec(mat,(x,y,z)), pos)
                resolve_connectors(sub, cm, cp, depth+1, out, top=False)
    if top:
        _concache[name.lower().split('/')[-1]] = out
    return out

# ─── model loading (.io AES / .ldr) ──────────────────────────────────────────
def aes_ctr(key, ct):
    from Crypto.Cipher import AES
    ecb=AES.new(key,AES.MODE_ECB); out=bytearray()
    for b in range((len(ct)+15)//16):
        ks=ecb.encrypt((b+1).to_bytes(16,'little')); out+=bytes(a^c for a,c in zip(ct[b*16:b*16+16],ks))
    return bytes(out)

def read_io(path):
    z=zipfile.ZipFile(path)
    for name in ('model.ldr','model2.ldr','modelv2.ldr'):
        if name not in z.namelist(): continue
        zi=[i for i in z.infolist() if i.filename==name][0]
        with open(path,'rb') as f:
            f.seek(zi.header_offset); lh=f.read(30)
            _,_,flag,method,_,_,_,csize,_,fnl,efl=struct.unpack('<IHHHHHIIIHH',lh)
            f.read(fnl); f.read(efl); data=f.read(csize)
        if method==99:
            salt=data[:16]; ct=data[16+2:-10]
            dk=hashlib.pbkdf2_hmac('sha1',b'soho0909',salt,1000,66)
            raw=zlib.decompress(aes_ctr(dk[:32],ct),-15)
        elif method==8:
            raw=zlib.decompress(data,-15)
        else:
            raw=data
        txt=raw.decode('utf-8','replace')
        if re.search(r'^\s*1\s',txt,re.M): return txt
    raise SystemExit('no model in io')

def parse_ldr(txt):
    bricks=[]
    for line in txt.splitlines():
        t=line.split()
        if len(t)>=15 and t[0]=='1':
            try:
                x,y,z=float(t[2]),float(t[3]),float(t[4]); R=tuple(float(v) for v in t[5:14])
            except: continue
            part=' '.join(t[14:]).strip()
            bricks.append((part,R,(x,y,z)))
    return bricks

# ─── connectivity ────────────────────────────────────────────────────────────
def audit(path):
    txt = read_io(path) if path.lower().endswith('.io') else open(path,encoding='utf-8',errors='replace').read()
    bricks = parse_ldr(txt)
    N=len(bricks)
    # place connectors -> dicts in world space
    conns=[]
    for i,(part,R,T) in enumerate(bricks):
        for c in resolve_connectors(part):
            conns.append({'p':i,'w':vadd(mvec(R,c['pos']),T),'a':mvec(R,c['axis']),
                          'r':c['r'],'g':c['g'],'k':c['k'],'grp':c.get('grp')})
    CELL=20.0; TOL=8.0
    grid=defaultdict(list)
    for idx,c in enumerate(conns):
        w=c['w']; grid[(round(w[0]/CELL),round(w[1]/CELL),round(w[2]/CELL))].append(idx)
    par=list(range(N))
    def find(a):
        while par[a]!=a: par[a]=par[par[a]]; a=par[a]
        return a
    def uni(a,b):
        ra,rb=find(a),find(b)
        if ra!=rb: par[ra]=rb
    def parallel(a,b,thr=0.95):
        d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
        la=math.sqrt(a[0]**2+a[1]**2+a[2]**2) or 1; lb=math.sqrt(b[0]**2+b[1]**2+b[2]**2) or 1
        return abs(d/(la*lb))>thr
    def compatible(a,b):
        ka,kb=a['k'],b['k']
        # normalize so CLP/CYL pair order doesn't matter
        kinds={ka,kb}
        if ka=='SNAP_CYL' and kb=='SNAP_CYL':
            return a['g']!=b['g'] and a['g'] in ('M','F') and b['g'] in ('M','F') \
                   and abs(a['r']-b['r'])<=1.5 and parallel(a['a'],b['a'])
        if kinds=={'SNAP_CLP','SNAP_CYL'}:
            # clip grips a bar (cyl): coincident + parallel; radius lenient
            return parallel(a['a'],b['a'])
        if ka=='SNAP_CLP' and kb=='SNAP_CLP':
            return parallel(a['a'],b['a'])         # two clips on same bar region
        if ka=='SNAP_FGR' and kb=='SNAP_FGR':
            return parallel(a['a'],b['a'])         # hinge fingers share the pin axis
        if ka=='SNAP_GEN' and kb=='SNAP_GEN':
            return a['g']!=b['g'] and (a['grp']==b['grp']) and parallel(a['a'],b['a'])
        return False
    matches=Counter()
    for (cx,cy,cz),lst in list(grid.items()):
        near=[]
        for dx in(-1,0,1):
            for dy in(-1,0,1):
                for dz in(-1,0,1):
                    near+=grid.get((cx+dx,cy+dy,cz+dz),[])
        for a in lst:
            ca=conns[a]
            for b in near:
                if b<=a: continue
                cb=conns[b]
                if ca['p']==cb['p']: continue
                if find(ca['p'])==find(cb['p']): continue
                if math.dist(ca['w'],cb['w'])>TOL: continue
                if compatible(ca,cb):
                    uni(ca['p'],cb['p']); matches[tuple(sorted((ca['k'],cb['k'])))]+=1
    comp=defaultdict(int)
    for i in range(N): comp[find(i)]+=1
    sizes=sorted(comp.values(),reverse=True)
    return {
        'file':os.path.basename(path),'pieces':N,'connectors':len(conns),
        'matches':sum(matches.values()),'matchKinds':{'+'.join(k):v for k,v in matches.most_common()},
        'components':len(sizes),
        'largest':sizes[0] if sizes else 0,
        'largestPct':round(100*sizes[0]/N,2) if N else 0,
        'detached':N-(sizes[0] if sizes else 0),
    }

if __name__=='__main__':
    for p in sys.argv[1:]:
        print(audit(p))
