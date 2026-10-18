"""Stage an A/B-accepted source round into clego's corpus, safely.

Generalises `_publish_faces_round.py` (which reads one round's PUBLISH2.md) to a
JSON manifest any round can write:

    [{"rel": "<path under lego_sets>", "trial": "<abs path of the accepted file>",
      "before_sha256": "<corpus bytes the A/B graded>", "after_sha256": "<trial bytes>"}, ...]

For every row:
  - refuse if the corpus file's CURRENT sha256 is not `before_sha256` (someone
    changed it since the A/B — publishing would silently undo their change);
  - refuse if the trial file's sha256 is not `after_sha256`;
  - back up the corpus bytes to <backup>/<rel> and record SHA256SUMS;
  - copy the trial file over the corpus path.
Nothing is written unless EVERY row passes both checks. Writes, beside the
backup: regrade-jobs.json (indexed files only, for
`discovery/misc_regrade_touched.py --jobs`), index-pairs.txt (`<set>:<rel>` for
the index patch) and sync-list.txt (for `sync_models_r2.py --only-file`).

usage: python -u scripts/_publish_sources_round.py <manifest.json> <backup dir> [--apply]
Without --apply it only checks and reports.  — Opus 5.5
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

CLEGO = Path('C:/git/clego')
LS = CLEGO / 'lego_sets'


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    manifest, backup = Path(sys.argv[1]), Path(sys.argv[2])
    apply = '--apply' in sys.argv
    rows = json.loads(manifest.read_text(encoding='utf-8'))
    index = json.loads((CLEGO / 'lego-models-index.json').read_text(encoding='utf-8'))
    # A path can be indexed under more than one set number; each row is patched.
    owner: dict[str, list[tuple[str, dict]]] = {}
    for setnum, s in index['sets'].items():
        for m in s['models']:
            owner.setdefault(m['path'], []).append((setnum, m))
    stale, badnew = [], []
    for r in rows:
        cur, trial = LS / r['rel'], Path(r['trial'])
        now = sha256(cur) if cur.exists() else 'missing'
        if now != r['before_sha256']:
            stale.append((r['rel'], r['before_sha256'][:12], now[:12]))
        if sha256(trial) != r['after_sha256']:
            badnew.append(r['rel'])
    indexed = sum(1 for r in rows if r['rel'] in owner)
    print(f'{len(rows)} rows ({indexed} indexed); {len(stale)} stale; {len(badnew)} trial-hash mismatches')
    for s in stale[:20]:
        print('  STALE', *s)
    for b in badnew[:20]:
        print('  BADNEW', b)
    if stale or badnew or not apply:
        return 1 if (stale or badnew) else 0
    backup.mkdir(parents=True, exist_ok=False)
    sums, jobs, pairs, sync = [], [], [], []
    for r in rows:
        cur = LS / r['rel']
        dst = backup / r['rel']
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cur, dst)
        sums.append(f'{sha256(dst)}  {r["rel"]}')
        shutil.copyfile(r['trial'], cur)
        if r['rel'] in owner:
            setnum, entry = owner[r['rel']][0]
            jobs.append({'set': setnum, 'path': r['rel'], 'entry': entry})
            pairs += [f'{sn}:{r["rel"]}' for sn, _e in owner[r['rel']]]
            sync.append(r['rel'])
    (backup / 'SHA256SUMS').write_bytes(('\n'.join(sums) + '\n').encode())
    (backup / 'regrade-jobs.json').write_bytes(json.dumps(jobs).encode())
    (backup / 'index-pairs.txt').write_bytes(('\n'.join(pairs) + '\n').encode())
    (backup / 'sync-list.txt').write_bytes(('\n'.join(sync) + '\n').encode())
    print(f'applied {len(rows)}; indexed {len(jobs)}; backup + lists in {backup}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
