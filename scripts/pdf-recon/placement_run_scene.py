"""Rebuild exactly the target a completed placement run scored against.

A post-hoc diagnostic that rebuilds the page's drawing from the PDF but skips
the run's own mask decision is not measuring the run. 40377 page index 17 is
the case that matters: the driver restricted the target to the body's own image
component (52,177 pixels) because the page also draws a detached plate, while
the diagnostic scored against the whole drawing (65,869 pixels). The same
selected assembly then scores 0.5442 under the run and 0.2865 under the
diagnostic, so comparing a reference-equivalent assembly scored by the
diagnostic against the score the run recorded compares two different questions.

`run_scene` reads the mask decision the run recorded and reproduces it, and
refuses rather than guessing when the run did not record one.
"""
from pathlib import Path

import pymupdf

from placement_arrow_contacts import read_items
from placement_page_mask import part_palette, restrict_to_body_component
from vector_scene import scene_images

MASK_SOURCES = ('whole_scene', 'largest_component')


def scene_pairs(items):
    return list(dict.fromkeys((str(part), int(color)) for part, color, _ in items))


def recorded_mask_source(meta):
    """The run's own mask decision, or the camera record it came from.

    Runs written before the driver recorded `mask_source` in results.json still
    identify their camera file and which of its drawings they used, so the
    decision is recoverable exactly rather than assumed.
    """
    if meta.get('mask_source'):
        return meta['mask_source']
    camera = meta.get('camera_source')
    order = meta.get('scene_order')
    if camera is None or order is None:
        return None
    import json
    scenes = json.loads(Path(camera).read_text())['native_scenes']
    if not 0 <= order < len(scenes):
        return None
    return scenes[order].get('mask_source', 'whole_scene')


def run_scene(meta, model_items=None, mask_source=None):
    """The scene a completed run scored against, from its own results.json.

    `meta` is the parsed results.json of a placement directory. `model_items`
    supplies the (part, colour) pairs whose CAD print palette protects real red
    and green parts from the arrow filter; when omitted the run's own selected
    model is read, which holds exactly the body plus this page's allocation.
    """
    source = mask_source or recorded_mask_source(meta)
    if source is None:
        raise ValueError('Run did not record a mask source; the target cannot be reproduced')
    if source not in MASK_SOURCES:
        raise ValueError(f'Unknown recorded mask source {source!r}')
    with pymupdf.open(meta['pdf']) as doc:
        scenes = [s for s in scene_images(doc, doc[meta['page']]) if s['xref'] == meta['xref']]
    if len(scenes) != 1:
        raise ValueError('Target native scene is not unique in the PDF page')
    scene = scenes[0]
    if source == 'whole_scene':
        return scene, source
    if model_items is None:
        raise ValueError('Component restriction needs the run model to build the CAD palette')
    return restrict_to_body_component(scene, [], part_palette(scene_pairs(model_items))), source


def run_scene_from_directory(directory, mask_source=None):
    directory = Path(directory)
    import json
    meta = json.loads((directory / 'results.json').read_text())
    if meta.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    return run_scene(meta, read_items(directory / 'model.ldr'), mask_source), meta
