"""Settle whether the PDF BOM's `98138pb072` and the model's `98138pz0` are one part.

Round four's memo left this parked, and it is worth two of page index 20's seven
pieces: the PDF inventory names the BrickLink id and the independent model names
the LDraw one, so those two pieces could not be scored at all however well the
construction was built.

Three independent sources are checked here, none of which is a reference pose:

1. **The universal part's own header.** The current official
   `98138pz0.dat` declares `!KEYWORDS Brickheadz, BrickLink 98138pb072, Eye,
   Rebrickable 98138pr0060`. That is exactly the evidence `PartLibrary` already
   consumes, and exactly the mechanism that settled `3010pb291`/`3010py3` in an
   earlier round. The reason it was not available before is dateable: the
   locally installed library is the Studio-bundled LDraw release 207, whose copy
   of the file is `UPDATE 2017-01`, and the keywords were added by the
   `2023-04-21 [Cheenzo] Subfiled pattern for reuse, added keywords` revision
   that shipped in `UPDATE 2023-03`.
2. **Studio's own part table.** `StudioPartDefinition2.txt` carries two rows for
   BL item key 153546, both with BL ItemNo `98138pb072` and the identical
   description: one mapping to `98138pb072.dat` and one to `98138pz0.dat`. So
   the vendor catalog states the same identity independently of LDraw's header.
3. **The CAD itself.** Both files are parsed recursively and compared as
   surfaces: bounding box, area, and the set of triangle vertices quantised to
   a stated tolerance. The two are authored differently - the official part
   subfiles its pattern and uses a ring primitive where the Studio one is flat
   triangles - so triangle *counts* are not expected to match and are reported
   rather than asserted.

Universal CAD, public catalogs and public part headers only. No reference model,
set inventory, pose or VLM participates.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

LDRAW = Path('C:/git/clego/extracted/studio_release/app/ldraw')
STUDIO_TABLE = LDRAW.parent / 'data' / 'StudioPartDefinition2.txt'
BRICKLINK = '98138pb072'
LDRAW_NAME = '98138pz0'


def studio_rows(bricklink=BRICKLINK, table=STUDIO_TABLE):
    """Every Studio part-table row naming this BrickLink item number."""
    header = None
    rows = []
    with open(table, encoding='utf-8', errors='replace') as handle:
        for line in handle:
            fields = line.rstrip('\n').split('\t')
            if header is None:
                header = fields
                continue
            if len(fields) < 7 or fields[2] != bricklink:
                continue
            rows.append({name: value for name, value in zip(header, fields)})
    return rows


def surface(part, resolver=None):
    """Triangles, bounding box and quantised vertex set of one universal part."""
    from placement_colored_cad import colored_triangles
    geometry = colored_triangles(part, 16, resolver=resolver)
    triangles = np.asarray(geometry['triangles'], float)
    vertices = triangles.reshape(-1, 3)
    edges = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    area = float(0.5 * np.linalg.norm(np.cross(*edges), axis=1).sum())
    return dict(part=part, triangles=int(len(triangles)), area=area,
                bbox_min=vertices.min(0).tolist(), bbox_max=vertices.max(0).tolist(),
                vertices=vertices, files=geometry['files'])


def compare(tolerance=0.001):
    """Both files' surfaces, and how far each is from the other's vertex set."""
    from placement_part_library import PartLibrary
    library = PartLibrary()
    studio = surface(str(LDRAW / 'UnOfficial' / 'parts' / f'{BRICKLINK}.dat'))
    official = surface(str(library.resolve(LDRAW_NAME)))
    result = {}
    for name, left, right in (('studio_to_official', studio, official),
                              ('official_to_studio', official, studio)):
        a = np.unique(np.round(left['vertices'] / tolerance).astype(np.int64), axis=0)
        b = np.unique(np.round(right['vertices'] / tolerance).astype(np.int64), axis=0)
        shared = len({tuple(v) for v in a} & {tuple(v) for v in b})
        result[name] = dict(distinct_vertices=int(len(a)), shared_with_other=shared,
                            share=shared / max(1, len(a)))
    box = max(abs(np.asarray(studio['bbox_min']) - np.asarray(official['bbox_min'])).max(),
              abs(np.asarray(studio['bbox_max']) - np.asarray(official['bbox_max'])).max())
    result.update(bbox_max_difference_ldu=float(box),
                  area_ratio=official['area'] / studio['area'],
                  studio={k: v for k, v in studio.items() if k != 'vertices'},
                  official={k: v for k, v in official.items() if k != 'vertices'},
                  vertex_tolerance_ldu=tolerance)
    return result


def evidence():
    from placement_part_library import PartLibrary
    library = PartLibrary()
    resolved = library.resolve(BRICKLINK)
    payload = Path(resolved).read_bytes()
    keywords = [line for line in payload.decode('utf-8', 'replace').splitlines()
                if line.startswith('0 !KEYWORDS') or line.startswith('0 !HISTORY')
                or line.startswith('0 !LDRAW_ORG')]
    local = LDRAW / 'parts' / f'{LDRAW_NAME}.dat'
    local_header = ([line for line in local.read_text(errors='replace').splitlines()[:12]
                     if line.startswith('0 !')] if local.is_file() else [])
    rows = studio_rows()
    return dict(
        bricklink_id=BRICKLINK, ldraw_id=LDRAW_NAME,
        header_evidence=dict(
            resolved_file=str(resolved),
            sha256=hashlib.sha256(payload).hexdigest(),
            lines=keywords,
            declares_bricklink_alias=any(BRICKLINK in line for line in keywords
                                         if line.startswith('0 !KEYWORDS')),
            upstream_url='https://library.ldraw.org/library/official/parts/'
                         f'{LDRAW_NAME}.dat'),
        locally_installed_copy=dict(
            file=str(local), header=local_header,
            note='The Studio-bundled library is LDraw release 207; its copy predates the '
                 '2023-03 update that added the BrickLink keyword, which is why the alias '
                 'was unavailable offline'),
        studio_table_evidence=dict(
            file=str(STUDIO_TABLE), rows=rows,
            ldraw_names=sorted({row['LDraw ItemNo'] for row in rows}),
            item_keys=sorted({row['BL ItemKey'] for row in rows}),
            descriptions=sorted({row['Description'] for row in rows})),
        cad_evidence=compare(),
        library_provenance=PartLibrary().provenance,
        truth_used=False, runtime_vlm_calls=0, certified=False,
        protocol='Universal LDraw part header keywords, the Studio part table and a recursive '
                 'CAD surface comparison, checked independently of each other',
        limitations='An authoritative identity between two catalog namespaces, not a claim that '
                    'either file is the mould a set actually contains, and not a placement '
                    'result. The two files are authored differently, so triangle counts differ '
                    'by construction and only the surface is compared.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path,
                        default=Path('output/pdf-placement-diagnosis/98138-alias-evidence.json'))
    args = parser.parse_args()
    record = evidence()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(json.dumps(dict(declares_alias=record['header_evidence']['declares_bricklink_alias'],
                          studio_ldraw_names=record['studio_table_evidence']['ldraw_names'],
                          bbox_difference=record['cad_evidence']['bbox_max_difference_ldu'],
                          area_ratio=record['cad_evidence']['area_ratio'],
                          shared=(record['cad_evidence']['studio_to_official']['share'],
                                  record['cad_evidence']['official_to_studio']['share'])),
                     indent=2))
    print(args.out)
