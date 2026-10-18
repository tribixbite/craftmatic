import unittest
import numpy as np
from placement_attach_group import group_transforms


def translation(x):
    T=np.eye(4);T[0,3]=x;return T


class CandidateFixture:
    def __init__(self,first_supported):self.first_supported=first_supported
    def candidates(self,part,**kwargs):
        if part=='first':return [{'T':translation(40)}] if self.first_supported else []
        if part=='second':return [{'T':translation(60)}]
        raise ValueError(part)


class GroupAnchorTests(unittest.TestCase):
    def setUp(self):
        self.group=[('first',15,translation(0)),('second',15,translation(20))]

    def test_second_member_can_be_the_only_attachment(self):
        first=list(group_transforms(CandidateFixture(False),self.group,{},{}))
        all_members=list(group_transforms(CandidateFixture(False),self.group,{},{},True))
        self.assertEqual(first,[])
        self.assertEqual(len(all_members),1)
        np.testing.assert_array_equal(all_members[0][0],translation(40))
        self.assertEqual(all_members[0][1],1)

    def test_two_attachment_members_do_not_duplicate_one_rigid_pose(self):
        actual=list(group_transforms(CandidateFixture(True),self.group,{},{},True))
        self.assertEqual(len(actual),1)
        np.testing.assert_array_equal(actual[0][0],translation(40))


if __name__=='__main__':unittest.main()
