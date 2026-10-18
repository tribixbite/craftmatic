import hashlib,json,tempfile,unittest
from pathlib import Path
from placement_pdf_group_evidence import load_allocations,inset_multiplier
import pymupdf


class AllocationProvenance(unittest.TestCase):
    def test_multiplier_uses_same_panel_not_pli_quantity(self):
        class Page:
            rect=pymupdf.Rect(0,0,400,400)
            def get_drawings(self):return [dict(rect=pymupdf.Rect(200,20,300,200),fill=(1,1,.8))]
            def get_text(self,kind):return [(20,10,30,20,'9x'),(270,170,290,190,'2x')]
        scene=dict(bbox=[210,30,280,160])
        self.assertEqual(inset_multiplier(Page(),scene)['multiplier'],2)
        self.assertIsNone(inset_multiplier(Page(),dict(bbox=[10,40,80,100]))['multiplier'])

    def test_requires_matching_pdf_and_zero_vlm(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pdf=root/'input.pdf';pdf.write_bytes(b'synthetic provenance fixture')
            manifest=dict(pdf_only=True,runtime_vlm_calls=0,pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest())
            assignment=dict(pdf_only=True,runtime_vlm_calls=0,evidence=[dict(page=7,part='3001',color='4',qty=2),dict(page=8,part='3002',color='1',qty=1)])
            (root/'manifest.json').write_text(json.dumps(manifest));(root/'global-assignment.json').write_text(json.dumps(assignment))
            parts,_=load_allocations(pdf,7,root);self.assertEqual(parts,[('3001',4),('3001',4)])
            assignment['runtime_vlm_calls']=1;(root/'global-assignment.json').write_text(json.dumps(assignment))
            with self.assertRaisesRegex(ValueError,'VLM'):load_allocations(pdf,7,root)
            assignment['runtime_vlm_calls']=0;(root/'global-assignment.json').write_text(json.dumps(assignment));pdf.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'hash mismatch'):load_allocations(pdf,7,root)


if __name__=='__main__':unittest.main()
