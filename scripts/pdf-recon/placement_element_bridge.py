"""Confirm a bridged element identity against the PDF's own inventory icon.

`placement_catalog_factor_bridge` already learns the two namespace relations -
Rebrickable part number to LDraw part, Rebrickable colour id to LDraw colour -
from element IDs that both universal catalogs resolve unambiguously, and it
deliberately keeps every observed conflict. That conservatism is why it does
not finish the job: on 41624 it maps the two elements no catalog resolves,
`4121715` (page index 3) and `6046979` (page index 15), to parts `2780` and
`99206`, but to *eight* and *sixteen* colour candidates respectively, because
Rebrickable colour 0 was co-observed against LDraw 0 in 3,443 elements and
against seven other codes in 11. Three pieces stay unidentified and the second
fixture cannot be driven contiguously.

The evidence that settles it is set-specific and already in hand: the element's
own inventory icon is drawn in the part's colour. This module compares each
candidate colour's LDraw RGB against the icon's *modal* foreground colour and
requires an explicit separation margin over the runner-up.

The mode matters. Instruction icons are a flat base colour with darker shading
and a dark outline, so the foreground *mean* of a white part lands on grey -
the first attempt resolved white `99206` to Light Bluish Grey on exactly that
error. The largest flat region is the part's own colour.

Measured on 41624: `6046979` to LDraw 15 at distance 11.5 against 108.3 for the
nearest rival, `4121715` to LDraw 0 at 17.4 against 158.7. Both are corroborated
by the universal CAD headers - `2780.dat` is "Technic Pin with Friction and
Slots" and `99206.dat` is "Plate 2 x 2 x 0.667 with Two Studs On Side and Two
Raised", which is what the two icons draw.

Universal catalogs and universal CAD are permitted inputs and the PDF is the
only set-specific one. No reference model, set inventory or VLM participates,
and an unseparated candidate is reported unresolved rather than guessed.
"""
import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
import numpy as np

CLEGO = Path('C:/git/clego')
STUDIO_DATA = CLEGO / 'extracted/studio_release/app/data'
REBRICKABLE_ELEMENTS = CLEGO / 'elements.csv'


def dominant_color(rgb, background_tolerance=12, bin_size=16):
    """Modal colour of an icon's foreground, not its mean.

    The border's most common colour is the page background; everything far
    enough from it is artwork. The modal quantised bin is taken and refined to
    the mean of the unquantised pixels inside it, and the runner-up clusters
    are returned as evidence rather than discarded.
    """
    image = np.asarray(rgb, float)
    border = np.concatenate((image[0], image[-1], image[:, 0], image[:, -1]))
    background = Counter(map(tuple, np.round(border).astype(int).tolist())).most_common(1)[0][0]
    distance = np.linalg.norm(image - np.asarray(background, float), axis=2)
    foreground = distance > background_tolerance
    if not foreground.any():
        return None, dict(background=list(background), foreground_pixels=0)
    values = image[foreground]
    binned = (values // bin_size).astype(int)
    counts = Counter(map(tuple, binned.tolist()))
    ranked = counts.most_common(5)
    modal = np.asarray(ranked[0][0])
    inside = (binned == modal).all(1)
    return values[inside].mean(0), dict(
        background=list(background), foreground_pixels=int(foreground.sum()),
        bin_size=bin_size, modal_share=float(ranked[0][1] / len(values)),
        clusters=[dict(bin=[int(v) * bin_size for v in colour], pixels=int(count),
                       share=float(count / len(values))) for colour, count in ranked])


def confirm(choices, icon_rgb, margin=24.0):
    """Rank candidate identities by LDraw RGB distance to the icon's modal colour.

    Every candidate is returned with its measured distance. One is marked
    confirmed only when the candidates share a single part - a disputed part
    number is not something colour can settle - and it is nearest by at least
    `margin`.
    """
    from placement_colored_cad import _rgb
    observed, evidence = dominant_color(icon_rgb)
    if observed is None:
        return [], dict(evidence, reason='Inventory icon has no foreground pixel')
    rows = []
    for choice in choices:
        cad = np.asarray(_rgb(int(choice['color'])), float)
        rows.append(dict(part=choice['part'], color=choice['color'], cad_rgb=cad.tolist(),
                         distance=float(np.linalg.norm(cad - observed))))
    rows.sort(key=lambda row: (row['distance'], str(row['color'])))
    single_part = len({row['part'] for row in rows}) == 1
    separated = len(rows) == 1 or rows[1]['distance'] - rows[0]['distance'] >= margin
    for row in rows:
        row['confirmed'] = bool(single_part and separated and row is rows[0])
    return rows, dict(evidence, observed_rgb=observed.tolist(), margin=margin,
                      single_part=bool(single_part), separated=bool(separated))


def run(pdf, source, out, margin=24.0, studio_data=STUDIO_DATA, elements=REBRICKABLE_ELEMENTS):
    """Emit an allocation directory whose inventory carries confirmed identities."""
    import pymupdf
    sys.path.insert(0, str(CLEGO))
    from placement_catalog_factor_bridge import propose
    from recon_extract.pdf_icon_matcher import icon_box
    from recon_extract.pdf_inventory import load_catalog, load_studio_catalog
    out = Path(out)
    if out.exists():
        raise ValueError('Choose a new output directory')
    source = Path(source)
    inventory = json.loads((source / 'inventory.json').read_text())
    if inventory.get('vlm_calls', 0):
        raise ValueError('Inventory provenance is not VLM-free')
    wanted = [record['element_id'] for record in inventory['records']
              if 'part' not in record and not record.get('candidates')]
    proposals = propose(load_studio_catalog(studio_data), load_catalog(elements), wanted)
    by_element = {proposal['element_id']: proposal for proposal in proposals}
    confirmations, changed = [], []
    with pymupdf.open(pdf) as doc:
        for index, record in enumerate(inventory['records']):
            proposal = by_element.get(record.get('element_id'))
            if proposal is None or not proposal['choices']:
                continue
            box = icon_box(doc[record['page']], record, inventory['records'])
            if box is None:
                confirmations.append(dict(element_id=record['element_id'], inventory_record=index,
                                          confirmed=False,
                                          reason='Inventory icon box unavailable'))
                continue
            pix = doc[record['page']].get_pixmap(matrix=pymupdf.Matrix(4, 4),
                                                 clip=pymupdf.Rect(box), alpha=False)
            rgb = np.frombuffer(pix.samples, np.uint8).reshape(
                pix.height, pix.width, pix.n)[:, :, :3]
            rows, evidence = confirm(proposal['choices'], rgb, margin)
            chosen = next((row for row in rows if row['confirmed']), None)
            confirmations.append(dict(
                element_id=record['element_id'], inventory_record=index, qty=int(record['qty']),
                page=record['page'], icon_bbox=list(box), candidates=rows, icon_evidence=evidence,
                part_evidence=proposal.get('part_evidence'),
                color_evidence=proposal.get('color_evidence'),
                confirmed=chosen is not None, part=chosen['part'] if chosen else None,
                color=chosen['color'] if chosen else None,
                reason=None if chosen else 'No candidate separated from the runner-up'))
            record['candidates'] = [[row['part'], row['color']] for row in rows]
            record['namespace_provenance'] = 'factorized_universal_element_overlap'
            if chosen is not None:
                record.update(part=chosen['part'], color=chosen['color'], namespace='ldraw',
                              candidates=[[chosen['part'], chosen['color']]],
                              identity_confirmation=dict(
                                  source='pdf_inventory_icon_modal_colour',
                                  distance=chosen['distance'], margin=margin,
                                  runner_up=rows[1]['distance'] if len(rows) > 1 else None))
                changed.append(record['element_id'])

    def digest(path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    inventory['resolved_pieces'] = sum(record['qty'] for record in inventory['records']
                                       if 'part' in record)
    inventory['unresolved'] = [row for row in inventory.get('unresolved', ())
                               if row.get('element_id') not in set(changed)]
    inventory['complete'] = not inventory['unresolved']
    inventory['identity_confirmation_proof'] = 'element-icon-confirmation.json'
    proof = dict(pdf=str(pdf), pdf_sha256=digest(pdf), source=str(source),
                 source_inventory_sha256=digest(source / 'inventory.json'),
                 universal_inputs={str(path): digest(path) for path in
                                   (elements, Path(studio_data) / 'elementInfoList.json',
                                    Path(studio_data) / 'StudioPartDefinition2.txt',
                                    Path(studio_data) / 'StudioColorDefinition.txt')},
                 proposals=proposals, confirmations=confirmations, changed_elements=changed,
                 confirmed_pieces=sum(row.get('qty', 0) for row in confirmations
                                      if row['confirmed']),
                 margin=margin, truth_used=False, runtime_vlm_calls=0, certified=False,
                 pdf_only=True,
                 protocol='Factorized universal-catalog namespace evidence proposes the part and '
                          "the colour candidates; the element's own PDF inventory icon confirms "
                          'the colour by modal-foreground LDraw RGB distance with an explicit '
                          'separation margin over the runner-up',
                 limitations=['A part mapping can rest on a single co-observed element; its witness '
                              'count is recorded per record and a disputed part is never confirmed '
                              'by colour.',
                              'Modal foreground colour can fail to separate two nearby LDraw '
                              'colours; that is reported unresolved rather than guessed.',
                              'Catalog and pixel identity evidence is not CAD geometry, placement '
                              'or model certification.'])
    out.mkdir(parents=True)
    for name in ('manifest.json', 'global-assignment.json'):
        if (source / name).is_file():
            (out / name).write_bytes((source / name).read_bytes())
    (out / 'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
    (out / 'element-icon-confirmation.json').write_text(json.dumps(proof, indent=2),
                                                        encoding='utf-8')
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True,
                        help='Allocation directory holding inventory.json')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--margin', type=float, default=24.0)
    parser.add_argument('--data', type=Path, default=STUDIO_DATA)
    parser.add_argument('--elements', type=Path, default=REBRICKABLE_ELEMENTS)
    args = parser.parse_args()
    proof = run(args.pdf, args.source, args.out, args.margin, args.data, args.elements)
    print(json.dumps(dict(confirmed_pieces=proof['confirmed_pieces'],
                          changed=proof['changed_elements'],
                          rows=[dict(element=row['element_id'], part=row.get('part'),
                                     color=row.get('color'), qty=row.get('qty'),
                                     page=row.get('page'), confirmed=row['confirmed'],
                                     distance=row['candidates'][0]['distance']
                                     if row.get('candidates') else None,
                                     runner_up=row['candidates'][1]['distance']
                                     if len(row.get('candidates') or ()) > 1 else None)
                                for row in proof['confirmations']])))
