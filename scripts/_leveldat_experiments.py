#!/usr/bin/env python3
"""Read or flip Minecraft Bedrock world settings in a level.dat copy (offline).

Usage:
    python scripts/_leveldat_experiments.py <level.dat>                   # print the fields that matter
    python scripts/_leveldat_experiments.py <level.dat> --beta-apis <out>  # write a copy with Beta APIs + cheats on
    python scripts/_leveldat_experiments.py <level.dat> --creator-cameras <out>  # ... with "Experimental Creator Camera Features" on too

Needs ``pip install nbtlib``. A Bedrock level.dat is an int32 LE storage
version, an int32 LE body length, then little-endian NBT. The "Beta APIs"
experiment is ``experiments.gametest = 1b`` (plus ``experiments_ever_used`` and
``saved_with_toggled_experiments``); GameTest also needs ``commandsEnabled``.
"Experimental Creator Camera Features" is ``experiments.experimental_creator_cameras
= 1b`` (Bedrock Wiki, "Enabling Experiments by Editing NBT"); ``--creator-cameras``
sets it as well as everything ``--beta-apis`` sets.

Measured 2026-09-24 on the Pixel 8 Pro (Minecraft 1.26.51): a world created
through the UI with experiments OFF, then this copy written back IN PLACE over
adb while Minecraft was stopped (``adb exec-in "cat > <world>/level.dat" <
out``; adb cannot create files under games/com.mojang, but can overwrite an
existing one), shows the "Experimental" badge on the Play list and loads
``@minecraft/server-gametest`` 1.0.0-beta. The script refuses to write unless
nbtlib re-serialises the ORIGINAL body byte-for-byte first, so an unknown tag
cannot be dropped silently. Never point it at a world you play in: an
experiment cannot be turned off again and disables achievements.
"""
from __future__ import annotations

import io
import struct
import sys

import nbtlib
from nbtlib.tag import Byte, Compound

FIELDS = ("LevelName", "GameType", "Generator", "commandsEnabled", "cheatsEnabled", "experiments",
          "lastOpenedWithVersion", "MinimumCompatibleClientVersion")


def read(path: str) -> tuple[int, nbtlib.File, bytes]:
    raw = open(path, "rb").read()
    version, length = struct.unpack("<ii", raw[:8])
    if len(raw) - 8 != length:
        raise SystemExit(f"{path}: header says {length} body bytes, file has {len(raw) - 8}")
    root = nbtlib.File.parse(io.BytesIO(raw[8:]), byteorder="little")
    return version, root, raw[8:]


def body_bytes(root: nbtlib.File) -> bytes:
    out = io.BytesIO()
    root.write(out, byteorder="little")
    return out.getvalue()


def show(root: nbtlib.File) -> None:
    for key in FIELDS:
        if key in root:
            print(f"  {key} = {root[key]!r}"[:300])


def main() -> int:
    args = sys.argv[1:]
    if not args or len(args) not in (1, 3) or (len(args) == 3 and args[1] not in ("--beta-apis", "--creator-cameras")):
        print(__doc__)
        return 2
    version, root, body = read(args[0])
    print(f"{args[0]}: storage version {version}, {len(body)} body bytes")
    show(root)
    if len(args) == 1:
        return 0
    if body_bytes(root) != body:
        raise SystemExit("nbtlib does not round-trip this level.dat byte-exactly; refusing to write")
    experiments = root.get("experiments") or Compound()
    experiments["gametest"] = Byte(1)  # the "Beta APIs" toggle
    if args[1] == "--creator-cameras":
        experiments["experimental_creator_cameras"] = Byte(1)
    experiments["experiments_ever_used"] = Byte(1)
    experiments["saved_with_toggled_experiments"] = Byte(1)
    root["experiments"] = experiments
    root["commandsEnabled"] = Byte(1)
    root["cheatsEnabled"] = Byte(1)
    new_body = body_bytes(root)
    with open(args[2], "wb") as fh:
        fh.write(struct.pack("<ii", version, len(new_body)) + new_body)
    _, check, _ = read(args[2])
    print(f"wrote {args[2]} ({8 + len(new_body)} bytes):")
    show(check)
    return 0


if __name__ == "__main__":
    sys.exit(main())
