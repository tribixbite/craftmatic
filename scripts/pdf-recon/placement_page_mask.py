"""Target-mask selection for one page drawing.

A page can draw a piece detached above the assembly. Those pixels cannot be
explained by any incomplete body, so leaving them in the target both drags the
registration off the body and depresses every score. Restricting the target to
the body's own image component scores the assembly against the assembly.

Shared by `placement_autodrive` and the closure-evidence diagnostic so the two
cannot silently disagree about which pixels the page is asking to explain.
No reference model, set inventory or VLM participates.
"""
from placement_arrow_mask import conservative_components, protected_cad_colors


def part_palette(pairs):
    """Protected CAD print colours for every (part, colour) that may appear.

    Raised rather than approximated when a part's print colours are unknown, so
    an arrow filter never silently deletes a real red or green part.
    """
    palette = protected_cad_colors(list(dict.fromkeys((str(part), int(color))
                                                      for part, color in pairs)))
    if not palette['complete']:
        raise ValueError('Cannot classify arrows without every known part CAD print colour')
    return palette


def restrict_to_body_component(scene, pairs, palette=None):
    """Return `scene` with its mask narrowed to the largest image component.

    The scene is returned unchanged when the conservative component graph finds
    a single component, so this can never remove the only body on the page.
    """
    palette = palette or part_palette(pairs)
    graph = conservative_components(scene, protected_colors=palette['rgb'])
    components = sorted((c for c in graph['components'] if c.get('mask') is not None),
                        key=lambda c: -int(c['area']))
    if len(components) <= 1:
        return scene
    return dict(scene, mask=components[0]['mask'])
