import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import placement_v2_evaluate as evaluator


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


class SealedEvaluationValidationTest(unittest.TestCase):
    def fixture(self, root):
        root = Path(root)
        bank = root / 'bank'
        run = root / 'run'
        bank.mkdir()
        run.mkdir()
        bank_payload = b'{"truth_used": false}'
        candidate_payload = b'0 candidate\n'
        (bank / 'results.json').write_bytes(bank_payload)
        (bank / 'beam_00.ldr').write_bytes(candidate_payload)
        report = {
            'truth_used': False,
            'runtime_vlm_calls': 0,
            'sources_unchanged': True,
            'source_hashes_start': {'source.py': 'abc'},
            'source_hashes_end': {'source.py': 'abc'},
            'candidate_bank': str(bank),
            'bank_sha256': sha(bank_payload),
            'candidate_count': 1,
            'records': [{'file': 'beam_00.ldr', 'sha256': sha(candidate_payload)}],
        }
        (run / 'report.json').write_text(json.dumps(report))
        return run, bank, report

    def assert_rejected_before_truth(self, run, pattern):
        with mock.patch.object(evaluator, 'read_parts',
                               side_effect=AssertionError('truth must not be read')) as read:
            with self.assertRaisesRegex(ValueError, pattern):
                evaluator.evaluate(run, Path('reference-must-not-be-opened.mpd'),
                                   Path(run).parent / 'evaluation.json')
        read.assert_not_called()

    def test_missing_truth_free_provenance_is_rejected_before_scoring(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmp:
            run, _, report = self.fixture(tmp)
            del report['truth_used']
            (run / 'report.json').write_text(json.dumps(report))
            self.assert_rejected_before_truth(run, 'truth-free zero-VLM provenance')

    def test_changed_bank_manifest_is_rejected_before_scoring(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmp:
            run, bank, _ = self.fixture(tmp)
            (bank / 'results.json').write_bytes(b'{"truth_used": false, "changed": true}')
            self.assert_rejected_before_truth(run, 'results.json differs')

    def test_changed_candidate_is_rejected_before_scoring(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmp:
            run, bank, _ = self.fixture(tmp)
            (bank / 'beam_00.ldr').write_bytes(b'0 tampered candidate\n')
            self.assert_rejected_before_truth(run, 'Candidate changed after replay')


if __name__ == '__main__':
    unittest.main()
