"""The invisible-tread RUNS one built pack plans that another lacks, at one size (turn 0), optionally near a point.

Each pack ships its tread plans in the behaviour pack's `craftmatic-treads.json` (one plan per size and turn, every
run with its from/to surfaces, hop and columns `(x, z, floor16, top16)` in the scaled grid). Diffing two builds of
the same set says which runs a planner change added, dropped or re-shaped - the first question when a walk line
(`scripts/_walk_line.ts`) changes. Read-only.

usage: python -I scripts/_tread_run_diff.py <a.mcaddon> <b.mcaddon> <size> [x z radius]
"""
import io
import json
import sys
import zipfile


def treads(path: str) -> dict:
    outer = zipfile.ZipFile(path)
    for n in outer.namelist():
        if n.endswith('.mcpack'):
            inner = zipfile.ZipFile(io.BytesIO(outer.read(n)))
            for m in inner.namelist():
                if m.endswith('craftmatic-treads.json'):
                    return json.loads(inner.read(m))
        elif n.endswith('craftmatic-treads.json'):
            return json.loads(outer.read(n))
    raise SystemExit(f'no treads json in {path}')


def runs_at(doc, size: int) -> list:
    plans = doc.get('plans', doc) if isinstance(doc, dict) else doc
    out = []
    for p in plans if isinstance(plans, list) else plans.values():
        if isinstance(p, dict) and p.get('sizePct') == size and p.get('rotation', 0) == 0:
            out.extend(p.get('runs', []))
    return out


def key(r) -> str:
    return json.dumps([r['from'], r['to'], [(c['x'], c['z'], c['top16']) for c in r['columns']]], sort_keys=True)


a, b, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
near = [float(v) for v in sys.argv[4:7]] if len(sys.argv) >= 7 else None
da, db = treads(a), treads(b)
if not runs_at(da, size):
    print('top-level keys:', list(da)[:20] if isinstance(da, dict) else type(da))
ra, rb = {key(r): r for r in runs_at(da, size)}, {key(r): r for r in runs_at(db, size)}
print(f'runs: A {len(ra)}, B {len(rb)}')


def show(tag, r):
    cs = r['columns']
    if near and not any(abs(c['x'] - near[0]) <= near[2] and abs(c['z'] - near[1]) <= near[2] for c in cs):
        return
    flags = ''.join(f' {k}' for k in ('fine', 'lane') if r.get(k))
    print(f"{tag} from {r['from']} to {r['to']} hop {r['hop16']}/16 treads {r['treads']}{flags} cols {[(c['x'], c['z'], c['floor16'], c['top16']) for c in cs]}")


for k in rb.keys() - ra.keys():
    show('B only', rb[k])
for k in ra.keys() - rb.keys():
    show('A only', ra[k])
