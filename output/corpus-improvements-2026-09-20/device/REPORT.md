# Pixel device validation — crowded LOD and chalet follow-up

Date: 2026-09-20. Device: Pixel 8 Pro at `192.168.0.122:5555`, Minecraft
Bedrock 1.26.51. No reboot, app-data clear, pack import, or network publishing
was performed.

## Crowded LOD A/B — PASS

World `919` loaded the already-installed LOD builds for Hogwarts 71043,
Milano 76286, and Great Hall 76435. One main actor of each was summoned at
`985/-55/1000`, `1015/-60/1000`, and `1000/-55/1000`. The corrected near
camera was `1000/-55/980`, facing `1000/-60/1000`: all three actor roots were
20–25 blocks away, inside the measured 26–28-block full-detail boundary. The
far camera was `1000/-55/920` with the same facing target and identical actors.

Pulled pack diagnostics separate resident definitions from what these three
main actors draw:

| quantity | cuboids |
|---|---:|
| active/resident definitions (all three packs, full + figures + hull) | 80,210 |
| near: three main actors, full detail | 71,884 |
| far: the same three main actors, hull | 3,160 |

| sample | frames | median ms | mean ms | p90 ms | fps | nativePss kB | GL mtrack kB |
|---|---:|---:|---:|---:|---:|---:|---:|
| near/full | 62 | 16.72 | 24.74 | 33.40 | 59.8 | 426,200 | 362,484 |
| far/hull | 62 | 16.67 | 16.67 | 16.74 | 60.0 | 416,060 | 361,788 |

The corrected three-set comparison is the last two rows of `perf/fps.tsv` and
`perf/samples.tsv`. Earlier `crowded-*` rows are exploratory and excluded: the
flaky transport retried the Hogwarts summon and briefly produced three
coincident Hogwarts actors. Those copies were coordinate-bounded, killed, and
replaced by one actor before the reported A/B.

Result: the hull does not change resident definitions or materially change
memory, but it removes the crowded near scene's double-frame spikes. Near has
a 33.40 ms p90 and 24.74 ms mean; far is pinned to one refresh interval at
16.67/16.74 ms mean/p90. This directly repeats the previously missing crowded
case without the prior round's 66–108-block actor spacing.

Evidence:

- `shots/lod-three-near.jpg`
- `shots/lod-three-far.jpg`
- `shots/lod-hog-testfor.jpg` and `shots/lod-great-testfor.jpg` (coordinate-
  bounded actor checks during scene correction)
- `diagnostics/*.json`
- `perf/fps.tsv`, `perf/samples.tsv`, and the matching raw dumps

## Chalet h1.8 vs h0.95 — NOT RERUN

The preflight proved that world `blank` still had only the old h0.95 build
active (`[2,692,4971]`). It was switched while Minecraft was force-stopped to
the installed h1.8 build (`[2,692,4952]`), so the no-old-h0.95 prerequisite was
met. The comparison was stopped before loading or placing the chalet: wireless
ADB repeatedly dropped or blocked midway through chat-input sequences, and a
credible same-site placement plus two adequate dwell periods could not be
completed without risking an unrestored world. Therefore this round adds no
movement observation and does not change the prior bounded result (h1.8: 0/7,
h0.95: 1/7 after about six minutes each).

Recommendation: do not ship a global 0.95 height from a one-figure response.
The next pack should calculate each walking figure's collision height from its
local floor-to-ceiling clearance (capped at player height), keep seated figures
out of the movement denominator, and record the four walker starts/ends
individually after at least ten minutes in one fresh placement. If clearance is
below even the reduced box, relocate that actor to the nearest navigable cell
rather than shrinking every figure.

## Restoration — byte verified

Before any change, all four pack JSON files were pulled byte-for-byte. After
the experiment Minecraft was force-stopped, the originals were restored after
explicit target truncation, pulled again, and SHA-256 compared:

| file | bytes | SHA-256 | restored |
|---|---:|---|---|
| 919 behavior | 286 | `575CCEFFE4618B4BB4BCA9E2B26C8EF4CE3F74E34513C814347AEC91826075A7` | exact |
| 919 resource | 286 | `A825857127A0CA5CFC2048E5D7876E5B5ED9F4DBF7BEB2F91BAC3CA7EC93086A` | exact |
| blank behavior | 98 | `A325588EF2183E1B0E0429D30556B0211607FB92751DEED92A84D43BD9E8E008` | exact |
| blank resource | 98 | `BDACB788C28E5D32E6789AA9A981F7D81116A4F4D1B984E15B7E958444F1B457` | exact |

The isolated LOD test entities were killed with a coordinate-bounded selector,
the free camera was cleared, and the player was returned to the pre-round
`826/-60/87` position. World 919 is back on its original three non-LOD pack
versions; blank is back on its original h0.95 version. Minecraft was relaunched
and left on the Play/Worlds screen, matching the starting app view
(`shots/final-play-screen.jpg`).
