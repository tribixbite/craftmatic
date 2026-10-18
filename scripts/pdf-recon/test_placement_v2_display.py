import numpy as np
import pytest
from placement_v2_display import partition_display


def test_exploded_piece_keeps_final_pose_but_is_absent_from_drawn_state():
    transform = np.eye(4)
    transform[:3,3] = [20.,-8.,0.]
    items = [('3031',4,np.eye(4)),('3023b',4,transform)]
    row = dict(attached_pieces=1, arrow_attachment=dict(status='placed',steps=[
        dict(part='3023b',color=4,status='placed',translation=[20.,-8.,0.])]))
    drawn, detached, record = partition_display(items,row)
    assert len(drawn) == len(detached) == 1
    assert np.array_equal(detached[0][2],transform)
    row['arrow_attachment']['steps'][0]['translation'] = [0.,0.,0.]
    with pytest.raises(ValueError):
        partition_display(items,row)


def test_missing_attachment_provenance_is_not_guessed():
    items = [('3031',4,np.eye(4)),('3023b',4,np.eye(4))]
    with pytest.raises(ValueError):
        partition_display(items,dict(attached_pieces=1))
    assert len(partition_display(items,{})[0]) == 2
