"""Independent single-group cache controls, plus retained two-group kernel test."""
import unittest,json,hashlib
from pathlib import Path
import numpy as np
from placement_layer_pair_screen import shortlist_pairs
from placement_layer_pair_screen_test import kernel_control
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_palette_classes import material_render
from placement_colored_cad import nativecolor_render,_rgb


class SingleLayerScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out=Path('output/pdf-placement-diagnosis/single-layer-screen-tests');cls.out.mkdir(exist_ok=True);cls.records={}
    @classmethod
    def tearDownClass(cls):
        (cls.out/'results.json').write_text(json.dumps(dict(truth_used=False,protocol='Universal synthetic and bound native-PDF cache controls; no set pose truth',tests=cls.records),indent=2))
    def test_existing_pair_kernel_control_retained(self):
        self.records['pair_kernel']=kernel_control()
    def test_synthetic_single_material_and_sentinel(self):
        base=[('3001',15,np.eye(4))];placements=[]
        for x in (0.,20.,-20.):
            T=np.eye(4);T[:3,3]=[x,-8,0];placements.append(dict(items=[('3020',29,T)]))
        M=np.array([[.7,0,-.7],[.35,.7,.35]])
        source=nativecolor_render(base+placements[0]['items'],M,self.out/'synthetic-source.png')
        helper=MaterialFeatureSceneScorer(source,plane_depth=True);rendered=material_render(helper,base+placements[0]['items'],M)
        rgb=np.full(source['rgb'].shape,245,np.uint8)
        for index,color in enumerate(rendered['colors']):rgb[rendered['labels']==index+1]=_rgb(color)
        scorer=MaterialFeatureSceneScorer(dict(rgb=rgb,mask=rendered['mask']),plane_depth=True)
        chosen,summary=shortlist_pairs(base,placements,M,scorer,limit=10,copies=1)
        self.assertTrue(summary['material_colors']);self.assertEqual(summary['cache_layers'],len(placements)+2)
        self.assertEqual(chosen[0][0],0)
        # Virtual empty layer is outside real placement range and is never
        # consumed as a second model member in copies=1.
        self.assertTrue(all(0<=i<len(placements) and j==len(placements) for i,j,s in chosen))
        full=[]
        for i,j,coarse in chosen:
            ev=scorer.score(base+placements[i]['items'],M)
            full.append(dict(index=i,virtual_second=j,coarse=coarse,native_comparable=.8*ev['material_color_score']+.2*ev['silhouette_iou']))
        self.assertEqual(max(full,key=lambda r:r['native_comparable'])['index'],0)
        self.assertLess(abs(full[0]['coarse']-full[0]['native_comparable']),.08)
        only,one=shortlist_pairs(base,placements[:1],M,scorer,limit=4,copies=1)
        self.assertEqual([(i,j) for i,j,s in only],[(0,1)])
        self.records['synthetic_single']=dict(summary=summary,scores=full,single_only=only,sentinel_protocol='j=n is virtual empty layer; only i indexes a real group')
    def test_native_cached_single_vs_full(self):
        import pymupdf
        from placement_arrow_contacts import read_items
        from vector_scene import scene_images
        from placement_arrow_mask import protected_cad_colors,conservative_components
        cache=json.loads(Path('output/pdf-placement-diagnosis/page7-legal-placements.json').read_text())
        basepath=Path(cache['base_source']);self.assertEqual(hashlib.sha256(basepath.read_bytes()).hexdigest(),cache['base_sha256']);base=read_items(basepath)
        placements=[dict(items=[(p,c,np.asarray(T)) for p,c,T in row['items']]) for row in cache['placements'][:32]]
        camera=json.loads(Path('output/pdf-placement-beam/40377-gpu-seventeen-v1/camera.json').read_text());M=np.asarray(camera['hypotheses'][0]['matrix'])
        pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');self.assertEqual(hashlib.sha256(pdf.read_bytes()).hexdigest(),cache['pdf_sha256'])
        with pymupdf.open(pdf) as doc:scene=scene_images(doc,doc[7])[0]
        palette=protected_cad_colors([(p,c) for p,c,T in base+placements[0]['items']]);graph=conservative_components(scene,palette['rgb']);scorer=MaterialFeatureSceneScorer(dict(scene,mask=graph['clean_mask']),plane_depth=True)
        chosen,summary=shortlist_pairs(base,placements,M,scorer,limit=32,copies=1);rows=[]
        self.assertTrue(chosen)
        for i,j,coarse in chosen:
            self.assertLess(i,len(placements));self.assertEqual(j,len(placements))
            ev=scorer.score(base+placements[i]['items'],M);self.assertFalse(ev.get('bbox_rejected',False))
            native=.8*ev['material_color_score']+.2*ev['silhouette_iou'];rows.append(dict(index=i,coarse=coarse,native_comparable=native,difference=coarse-native))
        self.assertTrue(all(np.isfinite(r['coarse']) for r in rows))
        self.records['native_single']=dict(summary=summary,scores=rows,max_abs_difference=max(abs(r['difference']) for r in rows),limitation='Approximate screen; target depicts2copies but fixture intentionally supplies1 to compare screen/full mechanics, not reconstruction accuracy')


if __name__=='__main__':unittest.main()
