import unittest
import numpy as np
from global_pdf_slot_assignment import solve_slots


class InventorySlotTest(unittest.TestCase):
    def test_two_mold_choices_do_not_double_capacity(self):
        items=[dict(qty=1),dict(qty=1)]
        slots=[dict(qty=1,choices=['mold_a','mold_b'])]
        selected,_=solve_slots(items,slots,np.array([[.9],[.8]]))
        self.assertEqual([(i,j) for i,j,s in selected],[(0,0)])

    def test_quantity_group_is_not_split_or_forced(self):
        selected,_=solve_slots([dict(qty=2),dict(qty=1)],
            [dict(qty=1),dict(qty=1)],np.array([[.99,.98],[.8,.2]]))
        self.assertEqual([(i,j) for i,j,s in selected],[(1,0)])


if __name__=='__main__':unittest.main()
