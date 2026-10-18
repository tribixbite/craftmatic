"""Stage the faces round (2026-09-24) into clego's corpus, safely.

For every file in the manifest (`PUBLISH2.md` table: file, new, previous):
  - refuse if the corpus file's CURRENT sha256/12 is not the manifest's
    `previous` (someone republished it since the patch was made — publishing
    would silently undo their change);
  - refuse if the staged file's sha256/12 is not the manifest's `new`;
  - back up the corpus file to <backup>/<rel> and record SHA256SUMS;
  - copy the staged file over it.
Writes a regrade job listing (indexed files only) and the index/sync lists.

usage: python -u scripts/_publish_faces_round.py <faces-0924 dir> <backup dir> [--apply]
Without --apply it only checks and reports.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

CLEGO = Path('C:/git/clego')
LS = CLEGO / 'lego_sets'


def sha12(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:12]


def main() -> int:
    src, backup = Path(sys.argv[1]), Path(sys.argv[2])
    apply = '--apply' in sys.argv
    rows = []
    for line in (src / 'PUBLISH2.md').read_text(encoding='utf-8').splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) > 3 and cells[0].startswith('DbixConvV3/') and cells[0].endswith('.ldr'):
            rows.append((cells[0], cells[1], cells[2]))
    index = json.loads((CLEGO / 'lego-models-index.json').read_text(encoding='utf-8'))
    owner: dict[str, tuple[str, dict]] = {}
    for setnum, s in index['sets'].items():
        for m in s['models']:
            owner[m['path']] = (setnum, m)
    stale, badnew = [], []
    for rel, new, prev in rows:
        cur = LS / rel
        staged = src / 'publish2' / rel
        if not cur.exists() or sha12(cur) != prev:
            stale.append((rel, prev, sha12(cur) if cur.exists() else 'missing'))
        if sha12(staged) != new:
            badnew.append(rel)
    print(f'{len(rows)} rows; {len(stale)} stale (corpus changed since the patch); {len(badnew)} staged-hash mismatches')
    for r in stale[:20]:
        print('  STALE', *r)
    if stale or badnew or not apply:
        return 1 if (stale or badnew) else 0
    backup.mkdir(parents=True, exist_ok=False)
    sums, jobs, pairs, sync = [], [], [], []
    for rel, new, prev in rows:
        cur = LS / rel
        dst = backup / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cur, dst)
        sums.append(f'{hashlib.sha256(dst.read_bytes()).hexdigest()}  {rel}')
        shutil.copy2(src / 'publish2' / rel, cur)
        if rel in owner:
            setnum, entry = owner[rel]
            jobs.append({'set': setnum, 'path': rel, 'entry': entry})
            pairs.append(f'{setnum}:{rel}')
            sync.append(rel)
    (backup / 'SHA256SUMS').write_bytes(('\n'.join(sums) + '\n').encode())
    (backup / 'regrade-jobs.json').write_bytes(json.dumps(jobs).encode())
    (backup / 'index-pairs.txt').write_bytes(('\n'.join(pairs) + '\n').encode())
    (backup / 'sync-list.txt').write_bytes(('\n'.join(sync) + '\n').encode())
    print(f'applied {len(rows)}; indexed {len(jobs)}; backup + lists in {backup}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
