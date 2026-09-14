`batcave-car-assembly.ldr` contains the first 399-part Batmobile assembly and the
first following scenery record from Craftmatic's existing
`MecabricksLDR/76252.ldr` model (MB_ALIGN v5), retrieved from
https://craftmatic.click/lego-models/MecabricksLDR/76252.ldr on 2026-09-10.

It tests the exact assembly boundary. The previous wheel-box crop retained only
287 car parts and incorrectly included 52 scenery parts from the full model.
The production extractor verifies all 399 placement records, including their
transforms, before using this source-specific partition.
