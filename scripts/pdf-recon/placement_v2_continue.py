"""Bounded continuation using the legacy generator and the v2 visual selector.

This is a diagnostic bridge, not the complete placement-v2 architecture.  The
existing ``placement_autodrive`` generates each page's finite candidate bank;
``placement_v2_replay`` then exclusively rescores that bank and publishes a new
immutable checkpoint.  Candidate recall is therefore bounded by the legacy
generator.  Runtime inputs are the PDF, its autonomous allocation, and a sealed
truth-free opening replay.  No reference model, VLM, or manually selected page
is accepted.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import shutil
import sys
from typing import Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _fresh(directory):
    directory = Path(directory)
    if directory.exists():
        raise ValueError(f"fresh output directory required: {directory}")
    directory.mkdir(parents=True)
    return directory


def _truth_free(record, label):
    if record.get("truth_used") is not False or record.get("runtime_vlm_calls") != 0:
        raise ValueError(f"{label} lacks truth-free zero-VLM provenance")


def _read_json(path):
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"missing required input: {path}")
    return json.loads(path.read_text())


def _verify_report_seal(path, report):
    if (report.get("sources_unchanged") is not True
            or report.get("source_hashes_start") != report.get("source_hashes_end")):
        raise ValueError("v2 replay source hashes are absent, changed, or inconsistent")
    sidecar = Path(str(path) + ".sha256")
    if sidecar.is_file():
        expected = sidecar.read_text().strip().split()[0]
        if expected != digest(path):
            raise ValueError(f"replay report SHA-256 sidecar does not match: {path}")


def allocation_pages(allocation_run, pdf, opening_page, max_pages=3):
    """Derive the bounded continuation scope after the replay's opening page."""
    maximum = int(max_pages)
    if maximum < 0 or maximum != max_pages:
        raise ValueError("max_pages must be a non-negative integer")
    allocation = _read_json(Path(allocation_run) / "global-assignment.json")
    _truth_free(allocation, "allocation")
    pdf_hash = digest(pdf)
    if allocation.get("pdf_sha256") != pdf_hash:
        raise ValueError("allocation PDF hash does not match --pdf")
    pages = allocation.get("allocation_pages")
    if (not isinstance(pages, list) or not all(isinstance(page, int) for page in pages)
            or len(set(pages)) != len(pages)):
        raise ValueError("allocation_pages must be a unique integer list")
    if opening_page not in pages:
        raise ValueError("opening replay page is absent from allocation_pages")
    return pages[pages.index(opening_page) + 1:][:maximum], allocation


def _camera_matrices(results):
    matrices = []
    for row in results:
        matrix = row.get("projection")
        if matrix is None:
            raise ValueError(f"candidate {row.get('file')} has no projection")
        # Match placement_v2_replay's stable exact-ish matrix-union policy.
        import numpy as np
        value = np.asarray(matrix, dtype=float)
        if value.shape != (2, 3) or not np.isfinite(value).all():
            raise ValueError("candidate projection must be finite 2x3")
        if not any(np.allclose(value, old, atol=1e-8, rtol=0) for old in matrices):
            matrices.append(value)
    return matrices


@dataclass(frozen=True)
class PublishedSelection:
    directory: Path
    model: Path
    selected_file: str
    projection: tuple
    origin: tuple
    v2_normalized_cost: float
    v2_score: float
    tie_count: int


def publish_selection(candidate_bank, replay_directory, output):
    """Publish a replay winner as a fresh legacy-compatible checkpoint."""
    candidate_bank, replay_directory = Path(candidate_bank), Path(replay_directory)
    output = _fresh(output)
    bank_path = candidate_bank / "results.json"
    bank = _read_json(bank_path)
    replay_path = replay_directory / "report.json"
    replay = _read_json(replay_path)
    _truth_free(bank, "candidate bank")
    _truth_free(replay, "v2 replay")
    _verify_report_seal(replay_path, replay)
    if Path(replay.get("candidate_bank", "")).resolve() != candidate_bank.resolve():
        raise ValueError("v2 replay names a different candidate bank")
    if replay.get("bank_sha256") != digest(bank_path):
        raise ValueError("candidate bank changed after v2 replay")

    winner = (replay.get("winners") or {}).get("True")
    if not winner or not isinstance(winner.get("file"), str):
        raise ValueError("v2 replay has no seam-enabled winner")
    records = replay.get("records") or []
    replay_by_file = {record.get("file"): record for record in records}
    if len(replay_by_file) != len(records) or winner["file"] not in replay_by_file:
        raise ValueError("v2 replay candidate records are missing or duplicated")
    results = list(bank.get("results") or [])
    bank_by_file = {row.get("file"): row for row in results}
    if len(bank_by_file) != len(results) or set(bank_by_file) != set(replay_by_file):
        raise ValueError("replay records do not cover the candidate bank exactly")
    for filename, record in replay_by_file.items():
        if Path(filename).name != filename:
            raise ValueError("candidate filenames must be local")
        source = candidate_bank / filename
        if not source.is_file() or record.get("sha256") != digest(source):
            raise ValueError(f"candidate changed after replay: {filename}")

    matrices = _camera_matrices(results)
    import math
    reranked = {}
    selected_cameras = {}
    for filename, original_row in bank_by_file.items():
        record = replay_by_file[filename]
        selected = (record.get("selected") or {}).get("True")
        if not selected:
            raise ValueError(f"candidate lacks seam-enabled selected evidence: {filename}")
        camera_index = selected.get("camera_index")
        if not isinstance(camera_index, int) or not 0 <= camera_index < len(matrices):
            raise ValueError(f"candidate camera index is invalid: {filename}")
        origin = selected.get("origin")
        if (not isinstance(origin, (list, tuple)) or len(origin) != 2
                or not all(isinstance(value, (int, float))
                           and math.isfinite(float(value)) for value in origin)):
            raise ValueError(f"candidate origin is invalid: {filename}")
        cost = float(selected["normalized_cost"])
        if not math.isfinite(cost):
            raise ValueError(f"candidate v2 cost is not finite: {filename}")
        v2_score = -cost  # higher remains better for legacy diagnostics
        row = dict(original_row)
        evidence = dict(row.get("evidence") or {})
        original_score = evidence.get("score", record.get("original_score"))
        if "combined_score" in evidence:
            evidence["original_combined_score"] = evidence["combined_score"]
            evidence["combined_score"] = v2_score
        evidence.update(score=v2_score, original_score=original_score,
                        v2_normalized_cost=cost, v2_score=v2_score,
                        score_namespace="v2_exclusive_correspondence",
                        v2_score_protocol="negative exclusive normalized correspondence cost")
        projection_for_row = matrices[camera_index]
        row.update(view=0, projection=projection_for_row.tolist(),
                   origin=[float(value) for value in origin], evidence=evidence)
        reranked[filename] = row
        selected_cameras[filename] = (camera_index, projection_for_row, origin, cost, v2_score)
    ranking = winner.get("ranking")
    if (not isinstance(ranking, list) or len(ranking) != len(results)
            or set(ranking) != set(bank_by_file) or ranking[0] != winner["file"]):
        raise ValueError("v2 winner ranking does not cover the candidate bank")
    ordered = [reranked[filename] for filename in ranking]
    camera_index, projection, origin, cost, v2_score = selected_cameras[winner["file"]]

    for filename in bank_by_file:
        shutil.copyfile(candidate_bank / filename, output / filename)
    shutil.copyfile(candidate_bank / winner["file"], output / "model.ldr")
    selected_record = replay_by_file[winner["file"]]
    rendered = replay_directory / (
        f"{selected_record['original_rank']:03d}-v{camera_index}-s1.png")
    if not rendered.is_file():
        raise ValueError(f"replay winner image is missing: {rendered}")
    shutil.copyfile(rendered, output / "selected.png")

    registration = dict(
        hypotheses=[dict(projection=projection.tolist(), origin=list(map(float, origin)),
                         rotation_index=None, registration_source="v2_replay")],
        truth_used=False, runtime_vlm_calls=0, source_report=str(replay_path),
        source_report_sha256=digest(replay_path))
    registration_path = output / "v2-registration.json"
    registration_path.write_text(json.dumps(registration, indent=2))
    publication = dict(
        protocol="legacy-generator-v2-selector-v1", source_bank=str(candidate_bank),
        source_bank_sha256=digest(bank_path), replay_report=str(replay_path),
        replay_report_sha256=digest(replay_path), selected_file=winner["file"],
        selected_candidate_sha256=digest(candidate_bank / winner["file"]),
        v2_normalized_cost=cost, v2_score=v2_score,
        tie_count=int(winner.get("tie_count", 0)), truth_used=False,
        runtime_vlm_calls=0,
        limitation="Legacy candidate generator may omit the correct pose")
    derived = dict(bank, results=ordered, registration_source=str(registration_path),
                   selection_v2=publication, truth_used=False, runtime_vlm_calls=0,
                   certified=False)
    (output / "results.json").write_text(json.dumps(derived, indent=2))
    return PublishedSelection(output, output / "model.ldr", winner["file"],
                              tuple(tuple(float(x) for x in row) for row in projection),
                              tuple(float(x) for x in origin), cost, v2_score,
                              int(winner.get("tie_count", 0)))


def _validate_opening(pdf, opening_replay):
    report_path = Path(opening_replay) / "report.json"
    report = _read_json(report_path)
    _truth_free(report, "opening replay")
    _verify_report_seal(report_path, report)
    if report.get("pdf_sha256") != digest(pdf):
        raise ValueError("opening replay PDF hash does not match --pdf")
    return report


def source_hashes(extra_names=()):
    names = ("placement_v2_continue.py", "placement_v2_replay.py",
             "placement_v2_correspondence.py", "placement_v2_observations.py",
             "placement_autodrive.py")
    names = tuple(dict.fromkeys(names + tuple(extra_names)))
    missing = [name for name in names if not (HERE / name).is_file()]
    if missing:
        raise ValueError(f"replay source files are missing: {missing}")
    return {name: digest(HERE / name) for name in names}


def run(pdf, allocation_run, opening_replay, out, max_pages=3, options=None,
        _autodrive=None, _replay_run=None):
    """Run a fresh bounded legacy-generation/v2-selection continuation."""
    pdf, allocation_run = Path(pdf), Path(allocation_run)
    opening_replay, out = Path(opening_replay), Path(out)
    opening_report = _validate_opening(pdf, opening_replay)
    pages, allocation = allocation_pages(allocation_run, pdf, opening_report["page"], max_pages)
    out = _fresh(out)
    replay_sources = tuple((opening_report.get("source_hashes_start") or {}).keys())
    sources_start = source_hashes(replay_sources)
    source_dir = out / "sources"
    source_dir.mkdir()
    for name in sources_start:
        shutil.copyfile(HERE / name, source_dir / name)
    opening = publish_selection(Path(opening_report["candidate_bank"]), opening_replay,
                                out / "opening")

    if _autodrive is None:
        import placement_autodrive as _autodrive
    if _replay_run is None:
        from placement_v2_replay import run as _replay_run
    if options is None:
        raise ValueError("page options are required (use CLI parsing or build_options)")
    options = dict(options)
    options["chromatic_metric"] = "lab"
    _autodrive.apply_palette_options(options)
    original_place_page = _autodrive.place_page
    selections = []

    def selected_place_page(*args, **kwargs):
        status, detail, placement, matrices, scale, registration = original_place_page(
            *args, **kwargs)
        if status != "placed" or placement is None:
            return status, detail, placement, matrices, scale, registration
        step_dir = Path(args[4])
        replay_dir = step_dir / "v2-replay"
        selected_dir = step_dir / "v2-selected"
        replay_record = _replay_run(placement, replay_dir, curves=True, arrows=True)
        published = publish_selection(placement, replay_dir, selected_dir)
        detail = dict(detail or {})
        detail.update(original_score=detail.get("score"), score=published.v2_score,
                      score_protocol="v2_score=-v2_normalized_cost",
                      v2_score=published.v2_score,
                      v2_normalized_cost=published.v2_normalized_cost,
                      v2_tie_count=published.tie_count,
                      v2_selected_file=published.selected_file,
                      v2_replay_report=str(replay_dir / "report.json"))
        selected_projection = [list(row) for row in published.projection]
        selected_origin = list(published.origin)
        import numpy as np
        selected_matrices = (selected_projection,) + tuple(
            matrix for matrix in matrices
            if not np.allclose(np.asarray(matrix, float),
                               np.asarray(selected_projection, float), atol=1e-8, rtol=0))
        selected_scale = _autodrive.projection_scale(selected_projection)
        carry = dict(registration or {})
        carry.update(projection=selected_projection, origin=selected_origin,
                     source=str(selected_dir))
        selections.append(dict(page=kwargs.get("page", args[1]),
                               generator_placement=str(placement),
                               replay=str(replay_dir), published=str(selected_dir),
                               selected_file=published.selected_file,
                               v2_normalized_cost=published.v2_normalized_cost,
                               tie_count=published.tie_count,
                               replay_sources_unchanged=replay_record.get("sources_unchanged")))
        return status, detail, selected_dir, selected_matrices, selected_scale, carry

    _autodrive.place_page = selected_place_page
    drive = None
    drive_error = None
    try:
        drive = _autodrive.run(pdf, allocation_run, opening.directory, pages,
                               out / "drive", options, resume=False,
                               stop_on_unsupported=False)
    except Exception as exc:
        drive_error = f"{type(exc).__name__}: {exc}"
    finally:
        _autodrive.place_page = original_place_page
    sources_end = source_hashes(replay_sources)
    trace = dict(
        protocol="bounded-legacy-generator-v2-selector-continuation-v1",
        pdf=str(pdf.resolve()), pdf_sha256=digest(pdf),
        allocation_run=str(allocation_run),
        allocation_sha256=digest(allocation_run / "global-assignment.json"),
        opening_replay=str(opening_replay),
        opening_replay_sha256=digest(opening_replay / "report.json"),
        opening_page=opening_report["page"], pages=pages, max_pages=int(max_pages),
        options=options, opening_publication=str(opening.directory), selections=selections,
        autodrive=drive, autodrive_error=drive_error,
        sources_start=sources_start, sources_end=sources_end,
        sources_unchanged=sources_start == sources_end,
        truth_used=False, runtime_vlm_calls=0, certified=False,
        limitations=["Legacy generator plus v2 selector; this is not the complete v2 architecture",
                     "The legacy candidate bank may omit correct poses",
                     "Bounded page count and no global reopening"])
    (out / "continue.json").write_text(json.dumps(trace, indent=2, default=str))
    if not trace["sources_unchanged"]:
        raise RuntimeError("continuation sources changed during the run")
    if drive_error is not None:
        raise RuntimeError(f"legacy generator/v2 selector continuation failed: {drive_error}")
    return trace


def main():
    import placement_autodrive
    from placement_autonomous_run import PAGE_OPTIONS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--allocation-run", type=Path, required=True)
    parser.add_argument("--opening-replay", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-pages", type=int, default=3)
    placement_autodrive.add_page_options(parser)
    # A legacy option documents a measured percentage with a literal ``%``;
    # argparse treats help strings as %-templates and otherwise crashes here.
    for action in parser._actions:
        if isinstance(action.help, str):
            action.help = action.help.replace("%", "%%")
    parser.set_defaults(chromatic_metric="lab")
    baseline = list(PAGE_OPTIONS)
    for index, value in enumerate(baseline[:-1]):
        if value == "--chromatic-metric":
            baseline[index + 1] = "lab"
    # Preserve the measured autonomous generator configuration. Explicit CLI
    # values occur later and therefore override its ordinary scalar options.
    args = parser.parse_args(baseline + sys.argv[1:])
    options = placement_autodrive.build_options(args)
    trace = run(args.pdf, args.allocation_run, args.opening_replay, args.out,
                args.max_pages, options)
    print(json.dumps(dict(status=trace["autodrive"]["status"], pages=trace["pages"],
                          output=str(Path(args.out) / "continue.json"))))


if __name__ == "__main__":
    main()
