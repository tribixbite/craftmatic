import unittest
import numpy as np
from placement_diagnose_alias_poses import yaw_equivalent_score


class StructuralScoreTests(unittest.TestCase):
    def test_unprinted_yaw_allowed_but_printed_yaw_not_allowed(self):
        I=np.eye(3);Y=np.diag([-1.,1.,-1.]);origin=np.zeros(3);offset=np.array([40.,0.,0.])
        anchor=('99780',15,origin,I)
        for part,expected in [('3010',2),('3020',2),('3023b',2),('3005',2),('3069b',2),('3003',2),('4032a',2),('4032b',1),('11476',1),('3010py3',1),('22885',1)]:
            result=yaw_equivalent_score([anchor,(part,1,offset,Y)],[anchor,(part,1,offset,I)])
            self.assertEqual(result['matched'],expected)

    def test_truth_instance_cannot_be_reused(self):
        I=np.eye(3);anchor=('99780',15,np.zeros(3),I);brick=('3010',1,np.array([40.,0.,0.]),I)
        self.assertEqual(yaw_equivalent_score([anchor,brick,brick],[anchor,brick])['matched'],2)

    def test_cylinder_quarter_turns_only_for_verified_geometry(self):
        I=np.eye(3);Q=np.array([[0.,0.,1.],[0.,1.,0.],[-1.,0.,0.]])
        anchor=('99780',15,np.zeros(3),I);position=np.array([40.,0.,0.])
        for part,expected in [('3941',2),('3010',1),('3020',1),('3023b',1),('3005',1),('3069b',1),('3003',1),('4032a',1),('4032b',1),('11476',1),('3010py3',1),('22885',1)]:
            for R in (Q,Q.T):
                recon=[anchor,(part,15,position,R)]
                truth=[anchor,(part,15,position,I)]
                self.assertEqual(yaw_equivalent_score(recon,truth)['matched'],expected)
        cylinder=('3941',15,position,Q)
        self.assertEqual(yaw_equivalent_score([anchor,cylinder,cylinder],[anchor,('3941',15,position,I)])['matched'],2)


if __name__=='__main__':unittest.main()
