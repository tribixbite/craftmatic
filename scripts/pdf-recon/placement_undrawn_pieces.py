"""Allocated pieces a construction's own drawing does not contain.

A page's parts strip lists everything the *step* consumes, and a numbered
subassembly step spends some of that on the subassembly and some on the
attachment that follows. `placement_construct_body` is handed the whole strip
and must build all of it as one rigid body, which on 40377 page index 20 is
impossible: its seven allocated pieces are, in the independent model, a
connected five-piece beak plus two black round tiles that mate with none of them
and sit 31 LDU away on a piece page 19 placed. Measured with the exact predicate
`Assembly._consume_coincident` uses, the two tiles engage **zero** connectors
with any of the other six or with each other. So no legal complete assembly of
those seven exists, and 84 retained candidates over three roots duly top out at
2 of 7 - one beyond the nailed root.

The PDF says the same thing without the model, in two independent ways.

**The substep drawings do not all show one object.** Page 20's three drawings
align 162 to 164 at scale 1.00 and IoU 0.9334 - cumulative substeps of one
assembly - while 168 fits either of them only at scale 0.80 and IoU 0.34, well
under the 0.60 floor `placement_drawing_registration` already refuses at. 168 is
the exploded first substep and the other two are the built states.

**The final substep contains no ink of the withheld colour.** Classified with
`placement_palette_classes` against the page's own allocated colours, xref 164's
8,136 foreground pixels are 6,523 bright-light-orange, 509 white and **57
black** - 0.7%, which is outline. One 1x1 round tile covers about 700 pixels at
that camera, so two of them are not in that drawing. The control is page index
21, the attachment page, whose drawing is 31% black because it shows those
tiles installed on the head along with a black 4x4 round plate.

This module turns the second measurement into a rule: a colour whose drawn ink
is less than a stated share of what **one** allocated piece of that colour must
cover cannot have any such piece in the drawing, so those pieces are withheld
from the construction and stay outstanding for a later page. It is deliberately
a whole-colour test with a conservative threshold, because a per-piece test on a
drawing this small would be guessing.

Its limitation is occlusion and it is real: a piece can be drawn and completely
hidden behind the rest of the assembly, and this rule would withhold it. That is
why the threshold is a fraction of a *single* piece's minimum silhouette rather
than of the total, why it never withholds every piece or leaves fewer than two,
and why it is opt-in and recorded.

No reference model, set inventory, pose or VLM participates.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

# A colour is judged absent when its drawn ink is below this share of what one
# piece of that colour must cover. Page 20 measures 57 pixels against a 700-pixel
# tile, i.e. 0.08; the pages that keep every colour measure 1.4 and above.
MIN_SHARE = 0.25


def drawn_class_pixels(scene, colors):
    """Foreground pixels of the drawing per LDraw colour, plus the unclassified."""
    sys.path.insert(0, 'C:/git/clego')
    from recon_v7.render import color_rgb
    from placement_palette_classes import palette_labels
    colors = list(dict.fromkeys(int(c) for c in colors))
    palette = np.asarray([color_rgb(c) for c in colors], np.uint8)
    rgb = np.asarray(scene['rgb'] if 'rgb' in scene else scene['image'])[:, :, :3]
    mask = np.asarray(scene['mask'], bool)
    labels, _ = palette_labels(rgb, mask, palette)
    counts = {color: int(((labels == index + 1) & mask).sum())
              for index, color in enumerate(colors)}
    return counts, int(mask.sum()), int(((labels == 0) & mask).sum())


def undrawn(scene, pieces, projection, min_share=MIN_SHARE, resolver=None):
    """Which allocated pieces this drawing has too little of their colour for.

    Returns a record with `withheld_keys` (part, colour) pairs, the per-colour
    measurement behind each decision, and the reason nothing was withheld.
    """
    if not 0.0 < min_share < 1.0:
        raise ValueError('Minimum drawn share must be a fraction between zero and one')
    from placement_exploded_page import silhouette_area_range
    pieces = [(str(part), int(color)) for part, color in pieces]
    colors = sorted({color for _, color in pieces})
    counts, foreground, unclassified = drawn_class_pixels(scene, colors)
    rows, withheld = [], []
    for color in colors:
        needed = min(silhouette_area_range(part, color, projection, resolver)[0]
                     for part, other in pieces if other == color)
        share = counts[color] / needed if needed > 0 else float('inf')
        absent = share < min_share
        rows.append(dict(color=color, drawn_pixels=counts[color],
                         single_piece_min_pixels=needed, drawn_share=share, absent=absent,
                         pieces=[list(p) for p in pieces if p[1] == color]))
        if absent:
            withheld.extend(p for p in pieces if p[1] == color)
    reason = None
    if not withheld:
        reason = 'Every allocated colour has enough drawn ink for at least one of its pieces'
    elif len(pieces) - len(withheld) < 2:
        # A construction needs at least two pieces; withholding down to one is
        # not evidence about the drawing, it is a failure of this test.
        reason = ('Withholding every absent colour would leave fewer than two pieces, so the '
                  'drawing is not evidence about which piece is missing')
        withheld = []
    return dict(withheld_keys=sorted({tuple(p) for p in withheld}),
                withheld=[list(p) for p in withheld], kept=[list(p) for p in pieces
                                                            if p not in withheld],
                colors=rows, foreground_pixels=foreground, unclassified_pixels=unclassified,
                min_share=min_share, reason=reason,
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='Per-colour drawn ink from the palette classifier against the smallest '
                         'silhouette one allocated piece of that colour can cover at this camera',
                limitations='A piece drawn but wholly occluded by the rest of the assembly is '
                            'indistinguishable from one that is not drawn, so this withholds a '
                            'whole colour only when its ink falls below a fraction of a single '
                            "piece's silhouette, never withholds every piece, and refuses when it "
                            'would leave fewer than two. It says a colour is not visible in one '
                            'drawing, never that the allocation is wrong.')


def split_pieces(pieces, record):
    """(kept, withheld) in the caller's own order, preserving multiplicity."""
    keys = {tuple(k) for k in record['withheld_keys']}
    kept = [p for p in pieces if (str(p[0]), int(p[1])) not in keys]
    held = [p for p in pieces if (str(p[0]), int(p[1])) in keys]
    return kept, held
