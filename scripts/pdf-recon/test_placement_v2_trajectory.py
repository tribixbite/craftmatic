import json
import pytest
from placement_v2_trajectory import verify_run, digest


def test_modified_opening_rejected_before_evaluation(tmp_path):
    pdf = tmp_path/'input.pdf'
    pdf.write_bytes(b'fixture')
    opening = tmp_path/'opening'
    opening.mkdir()
    model = opening/'model.ldr'
    model.write_text('0 first')
    (opening/'results.json').write_text(json.dumps(dict(selection_v2=dict(
        selected_candidate_sha256=digest(model),tie_count=1))))
    (tmp_path/'continue.json').write_text(json.dumps(dict(truth_used=False,runtime_vlm_calls=0,
        sources_unchanged=True,sources_start={'a':'same'},sources_end={'a':'same'},
        autodrive={'steps':[]},pdf=str(pdf),pdf_sha256=digest(pdf),
        opening_publication=str(opening),opening_page=2)))
    assert len(verify_run(tmp_path)[1]) == 1
    model.write_text('0 modified')
    with pytest.raises(ValueError,match='Opening model changed'):
        verify_run(tmp_path)
