`batcave-car-assembly.ldr` contains the first 399-part Batmobile assembly and the
first following scenery record from Craftmatic's existing
`MecabricksLDR/76252.ldr` model (MB_ALIGN v5), retrieved from
https://craftmatic.click/lego-models/MecabricksLDR/76252.ldr on 2026-09-10.

It tests the exact assembly boundary. The previous wheel-box crop retained only
287 car parts and incorrectly included 52 scenery parts from the full model.
The production extractor verifies all 399 placement records, including their
transforms, before using this source-specific partition.

`nimbus-fixture.ldr` (298 placements, written by `scripts/_nimbus_fixture_gen.ts`,
2026-09-29) stands in for LEGO 11390 Dragon Ball: Shenron & Goku until its
model file exists (release 2026-11-01): a 22-layer rock-and-dragon pillar of
real library bricks and slopes (dark bluish grey, dark grey, dark green) on a
black 12 x 12 base, and beside it a minifig (973 / 3626c / 3901 / 3815 / 3816 /
3817 / arms / hands) standing on a 26-part golden cloud (3032, 3021, 54200,
3020, 3024 in yellow, bright light orange and white) joined to the rock by one
trans-clear Bar 4L (30374, colour 47). `test/nimbus-fixture.test.ts` exports it
with the label `Dragon Ball: Shenron & Goku (11390-1)` so the set's canon
(engine/set-canon.ts) applies and `findMounts` (engine/bedrock-flyer.ts) must
read the cloud as the flyer mount with that figure. LDraw part origins sit at
the top stud plane with the body extending to +Y, except 54200, whose origin
is at its bottom; the generator's y arithmetic follows that.
