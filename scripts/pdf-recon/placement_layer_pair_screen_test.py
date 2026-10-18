import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from placement_layer_pair_screen import shortlist_pairs,SCORE_KERNEL
from placement_cuda_layers import LayerRasterizer


def kernel_control():
    cp=LayerRasterizer().cp;kernel=cp.RawKernel(SCORE_KERNEL,'score_pairs',options=('--std=c++11',))
    labels=np.zeros((3,3,5),np.uint8);z=np.zeros(labels.shape,np.float32)
    labels[0,1,1:3]=[1,2];z[0,1,1:3]=1
    labels[1,1,4]=1;z[1,1,4]=2 # Explicit false positive outside target window.
    labels[2,1,2]=2;z[2,1,2]=3
    target=np.array([[1,2]],np.uint8);valid=np.ones_like(target,np.uint8);mask=valid.copy()
    pairs=np.array([[0,1]],np.int32);shifts=np.array([[1,1]],np.int32);counts=np.array([1,1],np.int32)
    result=cp.empty(1,cp.float32)
    kernel((1,),(256,),(cp.asarray(z.view(np.uint32)),cp.asarray(labels),cp.asarray(pairs),cp.asarray(shifts),
        cp.asarray(target),cp.asarray(valid),cp.asarray(mask),cp.asarray(counts),result,
        np.int32(1),np.int32(15),np.int32(5),np.int32(2),np.int32(1),np.int32(2),np.int32(2)))
    actual=float(cp.asnumpy(result)[0]);expected=.8*((.5+1)/2)+.2*(2/3)
    assert abs(actual-expected)<1e-6 and actual<1
    return dict(full_canvas_false_positive_penalty=True,score=actual,cpu_expected=expected)


def run(out,count):
    import pymupdf
    from vector_scene import scene_images
    from placement_arrow_mask import conservative_components,protected_cad_colors
    from placement_multirow_camera import row_camera_hypotheses
    from placement_gpu_colored_scene_score import GpuColoredSceneScorer
    from placement_arrow_contacts import read_items
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    control=kernel_control()
    source=Path('output/pdf-placement-diagnosis/page7-legal-placements.json')
    record=json.loads(source.read_text());assert record['truth_used'] is False
    basepath=Path(record['base_source']);assert hashlib.sha256(basepath.read_bytes()).hexdigest()==record['base_sha256']
    base=read_items(basepath)
    placements=[dict(row,items=[(p,c,np.asarray(T)) for p,c,T in row['items']]) for row in record['placements'][:count]]
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');assert hashlib.sha256(pdf.read_bytes()).hexdigest()==record['pdf_sha256']
    doc=pymupdf.open(pdf);scene=scene_images(doc,doc[7])[0]
    palette=protected_cad_colors([(p,c) for p,c,T in base+placements[0]['items']])
    clean=conservative_components(scene,palette['rgb']);scene=dict(scene,mask=clean['clean_mask'])
    M=np.asarray(row_camera_hypotheses(scene)['hypotheses'][0]['matrix'])
    scorer=GpuColoredSceneScorer(scene,plane_depth=True)
    pairs,summary=shortlist_pairs(base,placements,M,scorer,limit=256)
    result=dict(kernel_test=control,summary=summary,pairs=pairs,projection=M.tolist(),
        cache_source=str(source),truth_used=False,protocol='Runtime PDF cache and native camera hypothesis; performance screen, not accuracy evaluation')
    (out/'results.json').write_text(json.dumps(result,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);p.add_argument('--count',type=int,default=979)
    a=p.parse_args();run(a.out,a.count)
