import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from placement_v2_continue import allocation_pages, publish_selection


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Fixture:
    def __init__(self, root):
        self.root = Path(root)
        self.pdf = self.root / "book.pdf"
        self.pdf.write_bytes(b"pdf")
        self.allocation = self.root / "allocation"
        self.allocation.mkdir()
        (self.allocation / "global-assignment.json").write_text(json.dumps(dict(
            pdf_sha256=sha(self.pdf), allocation_pages=[2, 4, 7, 9],
            truth_used=False, runtime_vlm_calls=0)))
        self.bank = self.root / "bank"
        self.bank.mkdir()
        (self.bank / "beam_a.ldr").write_text("a")
        (self.bank / "beam_b.ldr").write_text("b")
        results = [
            dict(file="beam_a.ldr", view=0, projection=[[1, 0, 0], [0, 1, 0]],
                 origin=[1, 2], evidence=dict(score=.8)),
            dict(file="beam_b.ldr", view=0, projection=[[0, 1, 0], [0, 0, 1]],
                 origin=[3, 4], evidence=dict(score=.6)),
        ]
        (self.bank / "results.json").write_text(json.dumps(dict(
            results=results, pdf=str(self.pdf), pdf_sha256=sha(self.pdf), page=2, xref=10,
            mask_source="whole_scene", truth_used=False, runtime_vlm_calls=0)))
        self.replay = self.root / "replay"
        self.replay.mkdir()
        records = []
        for index, row in enumerate(results):
            records.append(dict(file=row["file"], original_rank=index,
                                original_score=row["evidence"]["score"],
                                sha256=sha(self.bank / row["file"]), selected={
                                    "True": dict(camera_index=1, origin=[30, 40],
                                                 normalized_cost=.4 if index else .7)}))
            (self.replay / f"{index:03d}-v1-s1.png").write_bytes(
                ("image" + str(index)).encode())
        (self.replay / "report.json").write_text(json.dumps(dict(
            candidate_bank=str(self.bank), bank_sha256=sha(self.bank / "results.json"),
            records=records, winners={"True": dict(file="beam_b.ldr",
                                                     normalized_cost=.4, tie_count=1,
                                                     ranking=["beam_b.ldr", "beam_a.ldr"])},
            source_hashes_start={"x.py": "abc"}, source_hashes_end={"x.py": "abc"},
            sources_unchanged=True, truth_used=False, runtime_vlm_calls=0)))


class PageDerivationTest(unittest.TestCase):
    def test_pages_follow_opening_in_allocation_order_and_are_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary)
            pages, _ = allocation_pages(fixture.allocation, fixture.pdf, 4, 2)
            self.assertEqual(pages, [7, 9])

    def test_hash_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary)
            fixture.pdf.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash"):
                allocation_pages(fixture.allocation, fixture.pdf, 2)


class PublishSelectionTest(unittest.TestCase):
    def test_publish_reorders_winner_and_preserves_original_score(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary)
            output = fixture.root / "published"
            result = publish_selection(fixture.bank, fixture.replay, output)
            meta = json.loads((output / "results.json").read_text())
            self.assertEqual(meta["results"][0]["file"], "beam_b.ldr")
            self.assertEqual(meta["results"][0]["evidence"]["original_score"], .6)
            self.assertEqual(meta["results"][0]["evidence"]["v2_normalized_cost"], .4)
            self.assertEqual(meta["results"][0]["evidence"]["v2_score"], -.4)
            self.assertEqual(meta["results"][0]["evidence"]["score"], -.4)
            self.assertEqual(meta["results"][1]["evidence"]["score"], -.7)
            self.assertEqual(meta["results"][1]["evidence"]["original_score"], .8)
            self.assertEqual(meta["results"][0]["projection"],
                             [[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
            self.assertEqual(meta["results"][0]["origin"], [30.0, 40.0])
            self.assertEqual((output / "model.ldr").read_text(), "b")
            self.assertEqual((output / "selected.png").read_bytes(), b"image1")
            self.assertTrue((output / "beam_a.ldr").is_file())
            self.assertEqual(result.tie_count, 1)
            registration = json.loads((output / "v2-registration.json").read_text())
            self.assertEqual(registration["hypotheses"][0]["origin"], [30.0, 40.0])
            self.assertFalse(registration["truth_used"])
            self.assertEqual(meta["selection_v2"]["source_bank_sha256"],
                             sha(fixture.bank / "results.json"))

    def test_changed_candidate_is_rejected_and_source_is_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary)
            original_results = (fixture.bank / "results.json").read_bytes()
            (fixture.bank / "beam_a.ldr").write_text("changed")
            with self.assertRaisesRegex(ValueError, "changed after replay"):
                publish_selection(fixture.bank, fixture.replay, fixture.root / "bad")
            self.assertEqual((fixture.bank / "results.json").read_bytes(), original_results)

    def test_existing_output_is_never_resumed_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary)
            output = fixture.root / "existing"
            output.mkdir()
            sentinel = output / "keep"
            sentinel.write_text("safe")
            with self.assertRaisesRegex(ValueError, "fresh output"):
                publish_selection(fixture.bank, fixture.replay, output)
            self.assertEqual(sentinel.read_text(), "safe")


if __name__ == "__main__":
    unittest.main()
