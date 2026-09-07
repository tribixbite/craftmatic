import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, 'C:/git/clego')


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, Path('C:/git/clego') / path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


bom = module('test_bom', 'recon_extract/pdf_inventory.py')
pick = module('test_pick', 'recon_v7/pdfpick.py')
pipeline = module('test_pipeline', 'recon_v7/pipeline.py')
publish = module('test_publish', 'recon_v7/exit3_publish.py')
schema = module('test_label_schema', 'recon_extract/label_schema.py')


class PipelineGaps(unittest.TestCase):
    def test_tuple_shaped_part_label_is_not_a_part_identifier(self):
        self.assertIsNotNone(schema.label_error({'part': ['32556.dat', '19'], 'color': 2, 'qty': 1}))
        self.assertIsNone(schema.label_error({'part': '32556.dat', 'color': '19', 'qty': 1}))

    def test_inventory_duplicate_paint_not_duplicate_piece(self):
        words = [(0, 0, 8, 8, '3x'), (0, 8, 35, 16, '4560182'),
                 (0, 8, 35, 16, '4560182')]
        labels, count = bom.inventory_labels(words)
        self.assertEqual(count, 1)
        self.assertEqual([(r['element_id'], r['qty']) for r in labels], [('4560182', 3)])

    def test_quantity_pairs_stay_in_columns(self):
        words = [(0, 0, 8, 8, '2x'), (60, 0, 68, 8, '7x'),
                 (0, 8, 35, 16, '4560182'), (60, 8, 95, 16, '1234567')]
        self.assertEqual([r['qty'] for r in bom.inventory_labels(words)[0]], [2, 7])

    def test_ambiguous_catalog_is_unresolved(self):
        class Page:
            def get_text(self, _):
                return [(i * 60, y, i * 60 + 30, y + 8, text)
                        for i in range(4) for y, text in [(0, '2x'), (8, str(1234560 + i))]]
        result = bom.extract([Page()], {'1234560': {('3001', '0'), ('3002', '0')}})
        self.assertEqual(result['pieces'], 8)
        self.assertEqual(result['resolved_pieces'], 0)
        self.assertEqual(len(result['unresolved']), 4)

    def test_vector_only_first_page_is_eligible(self):
        import pymupdf
        with pymupdf.open() as doc:
            page = doc.new_page()
            page.draw_rect((10, 10, 30, 30), fill=(1, 0, 0))
            self.assertEqual(pick.visual_pages(doc), [0])

    def test_changed_pdf_invalidates_image_cache(self):
        import pymupdf
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            pdf = root / 'booklet.pdf'
            def write(color):
                with pymupdf.open() as doc:
                    page = doc.new_page()
                    page.draw_rect((10, 10, 100, 100), fill=color)
                    doc.save(pdf)
            with patch.object(pipeline, 'build_step_pages', return_value=([0], pdf)), \
                 patch.object(pipeline, 'crop_pages', return_value=(None, 1)):
                write((1, 0, 0))
                signature = pick.candidate_signature([('book', pdf)])
                png = pipeline.render_pages('x', root)[0][1]
                first = png.read_bytes()
                self.assertEqual(pipeline.render_pages('x', root)[0][1].read_bytes(), first)
                write((0, 0, 1))
                self.assertNotEqual(pick.candidate_signature([('book', pdf)]), signature)
                self.assertNotEqual(pipeline.render_pages('x', root)[0][1].read_bytes(), first)

    def test_better_source_is_protected_even_behind_reconstruction(self):
        self.assertTrue(publish.protected_sources([{'src': 'recon_v8'}, {'src': 'io'}]))
        self.assertTrue(publish.protected_sources([{'src': 'dbix_conv_v3', 'conv': 1}]))
        self.assertFalse(publish.protected_sources([{'src': 'recon_v3'}]))

    def test_publish_needs_pose_evidence_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / '123.ldr'
            path.write_text('model A')
            self.assertFalse(publish.publication_proof(path)[0])
            proof = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                     'pdf_only': True, 'runtime_vlm_calls': 0, 'unresolved': [],
                     'accuracy': {'kind': 'full_pose', 'allows_mirror': False,
                                  'part_and_color': True, 'one_to_one': True,
                                  'position_tolerance_ldu': 1, 'rotation_tolerance': .0001,
                                  'coverage': .96, 'precision': .97}}
            path.with_suffix('.verified.json').write_text(json.dumps(proof))
            self.assertTrue(publish.publication_proof(path)[0])
            for invalid in [float('nan'), float('inf'), 1.1, True, '0.99']:
                proof['accuracy']['coverage'] = invalid
                path.with_suffix('.verified.json').write_text(json.dumps(proof))
                self.assertFalse(publish.publication_proof(path)[0])
            proof['accuracy']['coverage'] = .96
            path.with_suffix('.verified.json').write_text(json.dumps(proof))
            path.write_text('different unverified model')
            self.assertFalse(publish.publication_proof(path)[0])


if __name__ == '__main__':
    unittest.main()
