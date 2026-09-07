"""Regression checks for independent PDF assignment evidence validation."""
import copy
import unittest
from validate_joint_trial import validate


class JointEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.inventory = {'records': [{'part': '3001', 'color': '4', 'qty': 2}]}
        self.assignment = {'assigned': 1, 'assigned_pieces': 2, 'evidence': [
            {'page': 2, 'anchor': [1, 2, 3, 4], 'part': '3001', 'color': '4', 'qty': 2}]}
        self.journal = [{'page': 2, 'placements': [{'part': '3001', 'color': 4}]}]

    def test_missing_placement_is_reported(self):
        self.assertEqual(validate(self.inventory, self.assignment, self.journal)['assigned_but_unplaced'], 1)

    def test_over_capacity_rejected(self):
        self.inventory['records'][0]['qty'] = 1
        with self.assertRaisesRegex(ValueError, 'capacity'):
            validate(self.inventory, self.assignment, self.journal)

    def test_duplicate_callout_rejected(self):
        self.assignment['evidence'].append(copy.deepcopy(self.assignment['evidence'][0]))
        with self.assertRaisesRegex(ValueError, 'more than once'):
            validate(self.inventory, self.assignment, self.journal)

    def test_wrong_page_placement_rejected(self):
        self.journal[0]['page'] = 3
        with self.assertRaisesRegex(ValueError, 'no matching page'):
            validate(self.inventory, self.assignment, self.journal)


if __name__ == '__main__':
    unittest.main()
