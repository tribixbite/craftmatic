#!/usr/bin/env python3
"""Install built Craftmatic .mcaddon packs on an Android device over adb and
bind them to one Minecraft Bedrock world at their exact versions.

Usage (run with ``python -u`` so progress is not block-buffered):

    python -u scripts/_pixel_dev_deploy.py <world name> <pack.mcaddon>... \
        [--mode auto|dev|import] [--root | --no-root] [--serial SERIAL] \
        [--shots-dir DIR] [--no-launch] [--dry-run] [--exclusive]

Two install routes:

``dev``    Put each pack folder into ``development_{behavior,resource}_packs``,
           which Minecraft re-reads on every world load, so a new build
           replaces the old one IN PLACE under the same folder name.
           Needs root (see "Root mode" below) or a device where the adb shell
           uid can create files under games/com.mojang. Existing dev folders
           are backed up to the backup dir first and overwritten in place;
           nothing on the device is deleted, so files a new build no longer
           ships are LEFT BEHIND and reported as stale.
``import`` Push each .mcaddon to ``/sdcard/Download/000-<stem>.mcaddon`` and hand
           it to Minecraft with a content-URI VIEW intent (Minecraft's own
           import, which writes regular ``behavior_packs``/``resource_packs``
           folders such as ``ArcadePinb(7)``). Success is judged ONLY by a
           folder whose manifest carries the pack's uuid AND exact version.
``auto``   (default) ``dev`` when every dev target is writable (always true
           in root mode), else ``import``.

Measured on the Pixel 8 Pro (Android 17, Minecraft 26.51, storage External,
2026-09-24, NOT rooted): ``files/`` is ``drwxrws---`` but Minecraft creates
``games/com.mojang`` and every dir below it ``drwxr-s---`` (owner u0_a<app>,
group ext_data_rw). The adb shell uid is in ext_data_rw: it can read
everything and overwrite existing ``-rw-rw----`` files in place, but cannot
create, rename or move anything there. So ``dev`` is blocked without root,
while the world's ``world_*_packs.json`` can still be rewritten IN PLACE —
which is why JSON goes through ``adb exec-in 'cat > file'`` (truncate + write
on the existing inode), never ``adb push`` (which may create a new file).

Root mode (``--root``; auto-detected with ``su -c id`` unless ``--no-root``).
Measured on the Solana Saga (Android 13, Magisk, Minecraft 26.51,
2026-09-25): root can write anywhere, but whatever root creates is owned by
``root`` and labelled ``…:s0`` WITHOUT the app's MLS categories
(``s0:c15,c257,c512,c768``), which the app cannot use. So every file-system
command runs under ``su -c`` and every folder root writes is repaired from
LIVE values read off the device, never hard-coded (the app uid and its
categories change on every reinstall):

  * owner, group, directory mode and SELinux label come from the
    ``games/com.mojang`` directory itself (``stat -c '%U %G %a %C'``);
  * the file mode comes from the world's own ``levelname.txt``.

Pack folders are pushed to a NEW staging dir ``/data/local/tmp/<unique>``
(the shell uid can write there), then ``su -c 'cp -r <stage>/<pack>/. <dev
dir>/'`` copies the contents over the existing dev folder (same uuid, same
folder name = replaced in place), followed by ``chown -R``, ``chmod`` per
dirs/files and ``chcon -R``. Staging dirs are NOT removed (this tool never
deletes anything recursively); each is named in the summary and costs
roughly the size of the packs.

The storage root (games/com.mojang) is the one whose ``minecraftWorlds``
holds the named world. Root mode searches the internal root
(``/data/user/0/<pkg>/games/com.mojang``, needs root even to read) and the
raw external root (``/data/media/0/Android/data/<pkg>/files/games/com.mojang``);
without root only the external root through ``/sdcard`` is readable.

After installing, in either mode: force-stop Minecraft, back up and rewrite the
world's ``world_behavior_packs.json`` / ``world_resource_packs.json`` (each
pack's uuid bound at its exact manifest version, an entry with the same uuid
replaced, all other entries kept), re-read to verify, and relaunch Minecraft
to its main menu (``--no-launch`` leaves it stopped). Opening the world is
left to the caller: the Play list order changes and a LAN tile can sit first.

adb is always run through ``subprocess`` with forward-slash device paths, so
Git Bash's MSYS path rewriting never touches a device path. Transient adb
failures (``error: closed``, device offline, ``no devices``) are retried.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MC_PACKAGE = "com.mojang.minecraftpe"
MC_ACTIVITY = f"{MC_PACKAGE}/.MainActivity"
# The external root as the (unrooted) adb shell uid sees it, through FUSE.
MC_ROOT_SHELL = f"/sdcard/Android/data/{MC_PACKAGE}/files/games/com.mojang"
# Root mode reads the lower file systems directly: chown/chcon through the
# FUSE view are not what the app's bind mount sees.
MC_ROOT_EXTERNAL_RAW = f"/data/media/0/Android/data/{MC_PACKAGE}/files/games/com.mojang"
MC_ROOT_INTERNAL = f"/data/user/0/{MC_PACKAGE}/games/com.mojang"
STAGING_PARENT = "/data/local/tmp"
DOWNLOAD_DIR = "/sdcard/Download"
REPO_ROOT = Path(__file__).resolve().parent.parent
BACKUP_ROOT = REPO_ROOT / "output" / "bedrock-entity-qa" / "device-backups"

# Substrings of adb output that mean "the transport hiccupped, try again".
TRANSIENT_ADB_ERRORS = (
    "error: closed",
    "device offline",
    "no devices",
    "device not found",
    "connection reset",
    "protocol fault",
    "device still authorizing",
)
ADB_RETRIES = 5
ADB_RETRY_DELAY_S = 3.0
IMPORT_TIMEOUT_S = 60.0
IMPORT_POLL_S = 2.0
LAUNCH_TIMEOUT_S = 60.0
# Minecraft reports its activity resumed well before the menu accepts an
# import intent; this settle time after resume is what the import needs.
LAUNCH_SETTLE_S = 12.0
VERIFY_RETRIES = 5
VERIFY_DELAY_S = 1.0


class AdbError(RuntimeError):
    """An adb command failed with a non-transient error, or retries ran out."""


@dataclass(frozen=True)
class PackInfo:
    """One pack folder extracted from an .mcaddon."""

    source: Path  # the .mcaddon it came from
    folder: str  # top-level folder name inside the archive
    local_dir: Path  # extracted folder on this machine
    kind: str  # "behavior" or "resource"
    uuid: str
    version: list[int]
    name: str

    def dev_parent(self, mc_root: str) -> str:
        """Device development-pack directory for this pack's kind under ``mc_root``."""
        return f"{mc_root}/development_{self.kind}_packs"

    def device_dir(self, mc_root: str) -> str:
        return f"{self.dev_parent(mc_root)}/{self.folder}"

    @property
    def version_str(self) -> str:
        return ".".join(map(str, self.version))


@dataclass(frozen=True)
class InstalledPack:
    """A pack folder found on the device, from its manifest."""

    path: str
    uuid: str
    version: list[int]
    name: str


@dataclass(frozen=True)
class FsAttrs:
    """Ownership, modes and SELinux label Minecraft's own files carry, read live."""

    owner: str
    group: str
    dir_mode: str  # octal, e.g. "2750" (external) or "700" (internal)
    file_mode: str  # octal, e.g. "660" (external) or "600" (internal)
    label: str  # e.g. u:object_r:media_rw_data_file:s0:c15,c257,c512,c768


class Adb:
    """Thin retrying wrapper around the adb executable.

    ``su`` makes every file-system command (``fs``, ``read_bytes``,
    ``write_in_place``) run as root; activity-manager commands stay on the
    plain ``shell`` so they behave exactly as on an unrooted device.
    """

    def __init__(self, serial: str | None, dry_run: bool, su: bool = False) -> None:
        self.serial = serial
        self.dry_run = dry_run
        self.su = su

    def _cmd(self, args: list[str]) -> list[str]:
        base = ["adb"]
        if self.serial:
            base += ["-s", self.serial]
        return base + args

    def run(
        self,
        args: list[str],
        *,
        check: bool = True,
        mutating: bool = False,
        stdin_bytes: bytes | None = None,
    ) -> str:
        """Run adb with retries on transient transport errors.

        ``mutating`` commands are only printed under --dry-run.
        Returns combined stdout+stderr text.
        """
        cmd = self._cmd(args)
        if mutating and self.dry_run:
            print(f"  [dry-run] {' '.join(shlex.quote(c) for c in cmd)}")
            return ""
        last = ""
        for attempt in range(1, ADB_RETRIES + 1):
            proc = subprocess.run(cmd, capture_output=True, input=stdin_bytes)
            out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
            last = out
            transient = any(t in out.lower() for t in TRANSIENT_ADB_ERRORS)
            if proc.returncode == 0 and not transient:
                return out
            if transient and attempt < ADB_RETRIES:
                print(f"  adb transient failure (attempt {attempt}/{ADB_RETRIES}): {out.strip()[:200]}; retrying")
                time.sleep(ADB_RETRY_DELAY_S)
                continue
            if not check:
                return out
            raise AdbError(f"adb {' '.join(args)} failed (exit {proc.returncode}): {out.strip()}")
        raise AdbError(f"adb {' '.join(args)} failed after {ADB_RETRIES} attempts: {last.strip()}")

    def shell(self, command: str, *, check: bool = True, mutating: bool = False) -> str:
        """Run one shell command string on the device as the adb shell uid."""
        return self.run(["shell", command], check=check, mutating=mutating)

    def as_fs_user(self, command: str) -> str:
        """``command`` wrapped for the file-system user: ``su -c '…'`` in root mode."""
        return f"su -c {shlex.quote(command)}" if self.su else command

    def fs(self, command: str, *, check: bool = True, mutating: bool = False) -> str:
        """Run a file-system command, as root in root mode."""
        return self.shell(self.as_fs_user(command), check=check, mutating=mutating)

    def exists(self, device_path: str) -> bool:
        out = self.fs(f"[ -e {shlex.quote(device_path)} ] && echo YES || echo NO", check=False)
        return out.strip().endswith("YES")

    def writable(self, device_path: str) -> bool:
        out = self.fs(f"[ -w {shlex.quote(device_path)} ] && echo W || echo RO", check=False)
        return out.strip().endswith("W")

    def pull(self, device_path: str, local_path: Path) -> None:
        # Pulling is read-only on the device, so it runs even under --dry-run.
        self.run(["pull", device_path, str(local_path).replace("\\", "/")])

    def push(self, local_path: Path, device_path: str) -> None:
        self.run(["push", str(local_path).replace("\\", "/"), device_path], mutating=True)

    def write_in_place(self, device_path: str, data: bytes) -> None:
        """Overwrite an EXISTING device file's bytes without creating a new inode.

        ``cat >`` truncates and writes the open file, which only needs write
        permission on the file itself — not on its (read-only) directory — and
        keeps the file's owner, mode and SELinux label.
        """
        self.run(
            ["exec-in", self.as_fs_user(f"cat > {shlex.quote(device_path)}")],
            mutating=True,
            stdin_bytes=data,
        )

    def read_bytes(self, device_path: str) -> bytes:
        """A device file's exact bytes via `exec-out cat` (no stat-size dependence)."""
        proc = subprocess.run(
            self._cmd(["exec-out", self.as_fs_user(f"cat {shlex.quote(device_path)}")]),
            capture_output=True,
        )
        return proc.stdout

    def screenshot(self, dest_jpg: Path) -> None:
        """Screencap to a JPEG no larger than 1999 px (ImageMagick when present)."""
        dest_jpg.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(self._cmd(["exec-out", "screencap", "-p"]), capture_output=True)
        png = dest_jpg.with_suffix(".png")
        png.write_bytes(proc.stdout)
        magick = shutil.which("magick")
        if magick:
            subprocess.run([magick, str(png), "-resize", "1999x1999>", "-quality", "85", str(dest_jpg)], check=True)
            png.unlink()
            print(f"  screenshot {dest_jpg}")
        else:
            # TODO: downscale without ImageMagick; the PNG is full-resolution.
            print(f"  screenshot {png} (full size: ImageMagick not found)")


def detect_root(adb: Adb) -> bool:
    """True when ``su -c id`` on the device reports uid 0."""
    out = adb.shell("su -c id", check=False)
    return "uid=0(" in out


def list_worlds(adb: Adb, mc_root: str) -> list[tuple[str, str]]:
    """(folder, levelname) of every world under ``mc_root``; empty when the root is absent."""
    script = (
        f"cd {shlex.quote(mc_root + '/minecraftWorlds')} 2>/dev/null || exit 0; "
        "for w in *; do [ -d \"$w\" ] || continue; printf '%s\\t' \"$w\"; "
        "cat \"$w/levelname.txt\" 2>/dev/null; echo; done"
    )
    worlds: list[tuple[str, str]] = []
    for line in adb.fs(script, check=False).splitlines():
        if "\t" in line:
            folder, level = line.split("\t", 1)
            worlds.append((folder, level.strip()))
    return worlds


def resolve_world(adb: Adb, world_name: str) -> tuple[str, str]:
    """Return (games/com.mojang root, world folder path) of the world named ``world_name``.

    Unrooted, only the external root is readable. Rooted, both the internal
    and the raw external roots are searched and the name must be unique
    across them, so packs always land beside the world they are bound to.
    """
    roots = [MC_ROOT_INTERNAL, MC_ROOT_EXTERNAL_RAW] if adb.su else [MC_ROOT_SHELL]
    matches: list[tuple[str, str]] = []
    listing: list[str] = []
    for root in roots:
        for folder, level in list_worlds(adb, root):
            listing.append(f"  {root}/minecraftWorlds/{folder}: {level}")
            if level == world_name:
                matches.append((root, f"{root}/minecraftWorlds/{folder}"))
    if not matches:
        raise SystemExit(f"No world named {world_name!r} on the device. Worlds:\n" + "\n".join(listing))
    if len(matches) > 1:
        raise SystemExit(f"World name {world_name!r} is ambiguous: {[m[1] for m in matches]}")
    return matches[0]


def read_fs_attrs(adb: Adb, mc_root: str, world_dir: str) -> FsAttrs:
    """Owner/group/dir mode/label of ``mc_root`` and the file mode of the world's levelname.txt."""
    fmt = shlex.quote("%U %G %a %C")
    dir_line = adb.fs(f"stat -c {fmt} {shlex.quote(mc_root)}").strip().splitlines()[-1]
    file_line = adb.fs(f"stat -c {fmt} {shlex.quote(world_dir + '/levelname.txt')}").strip().splitlines()[-1]
    owner, group, dir_mode, label = dir_line.split()
    file_mode = file_line.split()[2]
    # A root-owned games/com.mojang, or one without the app's MLS categories
    # (…:s0:cNN,…), would mean an earlier bad write; copying its attributes
    # onto new folders would spread the damage, so refuse instead.
    if owner == "root" or ":s0:c" not in label:
        raise SystemExit(f"{mc_root}: unexpected attributes {dir_line!r}; refusing to copy them")
    return FsAttrs(owner=owner, group=group, dir_mode=dir_mode, file_mode=file_mode, label=label)


def extract_packs(mcaddon: Path, work: Path) -> list[PackInfo]:
    """Unzip one .mcaddon into ``work`` and describe every pack folder in it."""
    dest = work / mcaddon.stem
    dest.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(mcaddon) as zf:
        zf.extractall(dest)
    packs: list[PackInfo] = []
    for folder in sorted(p for p in dest.iterdir() if p.is_dir()):
        manifest_path = folder / "manifest.json"
        if not manifest_path.is_file():
            print(f"  skip {folder.name}: no manifest.json")
            continue
        manifest: dict[str, Any] = json.loads(manifest_path.read_bytes().decode("utf-8-sig"))
        header = manifest["header"]
        module_types = {m.get("type") for m in manifest.get("modules", [])}
        if "resources" in module_types:
            kind = "resource"
        elif module_types & {"data", "script"}:
            kind = "behavior"
        else:
            raise SystemExit(f"{mcaddon.name}/{folder.name}: unknown module types {module_types}")
        packs.append(
            PackInfo(
                source=mcaddon,
                folder=folder.name,
                local_dir=folder,
                kind=kind,
                uuid=str(header["uuid"]).lower(),
                version=[int(v) for v in header["version"]],
                name=str(header.get("name", folder.name)),
            )
        )
    if not packs:
        raise SystemExit(f"{mcaddon}: no pack folders with a manifest.json")
    return packs


def list_device_files(adb: Adb, device_dir: str) -> set[str]:
    """Relative paths of all regular files under a device directory."""
    out = adb.fs(f"cd {shlex.quote(device_dir)} && find . -type f", check=False)
    return {line.strip()[2:] for line in out.splitlines() if line.strip().startswith("./")}


def local_files(local_dir: Path) -> set[str]:
    return {p.relative_to(local_dir).as_posix() for p in local_dir.rglob("*") if p.is_file()}


def scan_installed(
    adb: Adb, mc_root: str, roots: tuple[str, ...] = ("behavior_packs", "resource_packs")
) -> list[InstalledPack]:
    """Every pack folder under the given com.mojang roots, read from its manifest."""
    globs = " ".join(f"{mc_root}/{r}/*" for r in roots)
    script = (
        f"for d in {globs}; do "
        f"[ -f \"$d/manifest.json\" ] || continue; "
        f"echo \"@@ $d\"; cat \"$d/manifest.json\"; echo; done"
    )
    out = adb.fs(script, check=False)
    found: list[InstalledPack] = []
    for chunk in out.split("@@ ")[1:]:
        path, _, body = chunk.partition("\n")
        try:
            header = json.loads(body)["header"]
            found.append(
                InstalledPack(
                    path=path.strip(),
                    uuid=str(header["uuid"]).lower(),
                    version=[int(v) for v in header["version"]],
                    name=str(header.get("name", "")),
                )
            )
        except (ValueError, KeyError, TypeError):
            continue
    return found


def find_installed(installed: list[InstalledPack], pack: PackInfo) -> InstalledPack | None:
    for item in installed:
        if item.uuid == pack.uuid and item.version == pack.version:
            return item
    return None


def load_bindings(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    text = path.read_bytes().decode("utf-8-sig").strip()
    if not text:
        return []
    data = json.loads(text)
    if not isinstance(data, list):
        raise SystemExit(f"{path}: expected a JSON list, got {type(data).__name__}")
    return data


def rebind(entries: list[dict[str, Any]], packs: list[PackInfo], exclusive: bool = False) -> list[dict[str, Any]]:
    """Bind each pack at its exact version; same-uuid entries are replaced in place.

    `exclusive` drops every other binding, so the world runs exactly these packs.
    An older build of the same set under a DIFFERENT uuid (the uuid follows the
    pack label, and CLI builds relabelled 76417 etc. on 2026-09-25) otherwise
    stays bound, defines the same entity and item identifiers, and can override
    the new build ("has already been overridden by a pack higher in the pack
    stack" in the content log).
    """
    if exclusive:
        return [{"pack_id": pack.uuid, "version": list(pack.version)} for pack in packs]
    result = [dict(e) for e in entries]
    for pack in packs:
        new_entry = {"pack_id": pack.uuid, "version": list(pack.version)}
        for i, entry in enumerate(result):
            if str(entry.get("pack_id", "")).lower() == pack.uuid:
                result[i] = new_entry
                break
        else:
            result.append(new_entry)
    return result


def json_bytes(data: Any) -> bytes:
    """JSON as explicit UTF-8 bytes with LF newlines (no platform translation)."""
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def fmt_bindings(entries: list[dict[str, Any]]) -> str:
    if not entries:
        return "    (none)"
    return "\n".join(
        f"    {e.get('pack_id')} @ {'.'.join(str(v) for v in e.get('version', []))}" for e in entries
    )


def dev_blocked_paths(adb: Adb, packs: list[PackInfo], mc_root: str) -> list[str]:
    """Dev-install targets the file-system user cannot write (see module docstring)."""
    needed: list[str] = []
    for p in packs:
        if adb.exists(p.device_dir(mc_root)):
            needed.append(p.device_dir(mc_root))
        elif adb.exists(p.dev_parent(mc_root)):
            needed.append(p.dev_parent(mc_root))
        else:
            needed.append(mc_root)
    return [path for path in dict.fromkeys(needed) if not adb.writable(path)]


def world_json_blocked(adb: Adb, world_dir: str) -> list[str]:
    """World JSON files that cannot be rewritten in place (missing ones need a writable dir)."""
    blocked: list[str] = []
    for kind in ("behavior", "resource"):
        path = f"{world_dir}/world_{kind}_packs.json"
        target = path if adb.exists(path) else world_dir
        if not adb.writable(target):
            blocked.append(path)
    return blocked


def minecraft_resumed(adb: Adb) -> bool:
    out = adb.shell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'", check=False)
    return MC_PACKAGE in out


def launch_minecraft(adb: Adb) -> None:
    """Start Minecraft (or bring it forward) and wait until it is resumed and settled."""
    adb.shell(f"monkey -p {MC_PACKAGE} -c android.intent.category.LAUNCHER 1", mutating=True)
    if adb.dry_run:
        return
    deadline = time.monotonic() + LAUNCH_TIMEOUT_S
    while time.monotonic() < deadline:
        if minecraft_resumed(adb):
            time.sleep(LAUNCH_SETTLE_S)
            return
        time.sleep(IMPORT_POLL_S)
    raise SystemExit("Minecraft did not reach the foreground within the launch timeout")


def deploy_dev(adb: Adb, packs: list[PackInfo], mc_root: str, backup_dir: Path) -> dict[str, list[str]]:
    """Unrooted dev install: push every pack folder into the dev pack dirs; returns stale files per dir."""
    stale_report: dict[str, list[str]] = {}
    for pack in packs:
        adb.shell(f"mkdir -p {shlex.quote(pack.dev_parent(mc_root))}", mutating=True)
        if adb.exists(pack.device_dir(mc_root)):
            dest = backup_dir / f"development_{pack.kind}_packs"
            dest.mkdir(parents=True, exist_ok=True)
            print(f"  backing up existing {pack.device_dir(mc_root)} -> {dest / pack.folder}")
            adb.pull(pack.device_dir(mc_root), dest)
            stale = sorted(list_device_files(adb, pack.device_dir(mc_root)) - local_files(pack.local_dir))
            if stale:
                stale_report[pack.device_dir(mc_root)] = stale
        # Pushing a directory onto an EXISTING parent lands it at parent/<basename>,
        # overwriting same-named files and leaving others untouched.
        print(f"  push {pack.folder} -> {pack.dev_parent(mc_root)}/")
        adb.push(pack.local_dir, pack.dev_parent(mc_root) + "/")
    return stale_report


def fix_attrs_commands(path: str, attrs: FsAttrs) -> list[str]:
    """Root commands that give ``path`` (recursively) Minecraft's own owner, modes and label."""
    q = shlex.quote(path)
    return [
        f"chown -R {attrs.owner}:{attrs.group} {q}",
        f"find {q} -type d -exec chmod {attrs.dir_mode} {{}} +",
        f"find {q} -type f -exec chmod {attrs.file_mode} {{}} +",
        f"chcon -R {shlex.quote(attrs.label)} {q}",
    ]


def ensure_dir_as_app(adb: Adb, path: str, attrs: FsAttrs) -> None:
    """Create ``path`` (one level) as root and give it the app's attributes, if missing."""
    if adb.exists(path):
        return
    print(f"  creating {path} with the app's attributes")
    q = shlex.quote(path)
    adb.fs(
        " && ".join(
            [
                f"mkdir {q}",
                f"chown {attrs.owner}:{attrs.group} {q}",
                f"chmod {attrs.dir_mode} {q}",
                f"chcon {shlex.quote(attrs.label)} {q}",
            ]
        ),
        mutating=True,
    )


def deploy_dev_root(
    adb: Adb, packs: list[PackInfo], mc_root: str, attrs: FsAttrs, staging: str, backup_dir: Path
) -> dict[str, list[str]]:
    """Root dev install through ``staging``; returns stale files per replaced dev folder.

    Order per pack: back up the existing dev folder (root copy into staging,
    made shell-readable, pulled), push the new folder into staging, then
    ``cp -r <stage>/<pack>/. <dev folder>/`` (overwrite in place, delete
    nothing) and repair owner/modes/label on the whole dev folder.
    """
    stale_report: dict[str, list[str]] = {}
    adb.shell(f"mkdir {shlex.quote(staging)}", mutating=True)
    adb.shell(f"mkdir {shlex.quote(staging + '/new')}", mutating=True)
    for kind in sorted({p.kind for p in packs}):
        ensure_dir_as_app(adb, f"{mc_root}/development_{kind}_packs", attrs)
    for pack in packs:
        target = pack.device_dir(mc_root)
        if adb.exists(target):
            stale = sorted(list_device_files(adb, target) - local_files(pack.local_dir))
            if stale:
                stale_report[target] = stale
            stage_backup = f"{staging}/backup-{pack.kind}"
            print(f"  backing up existing {target}")
            adb.fs(
                f"mkdir -p {shlex.quote(stage_backup)} && cp -r {shlex.quote(target)} {shlex.quote(stage_backup + '/')}"
                f" && chmod -R a+rX {shlex.quote(stage_backup)}",
                mutating=True,
            )
            if not adb.dry_run:
                dest = backup_dir / f"development_{pack.kind}_packs"
                dest.mkdir(parents=True, exist_ok=True)
                adb.pull(f"{stage_backup}/{pack.folder}", dest)
        print(f"  push {pack.folder} -> {staging}/new/")
        adb.push(pack.local_dir, f"{staging}/new/")
        steps = [
            f"mkdir -p {shlex.quote(target)}",
            f"cp -r {shlex.quote(f'{staging}/new/{pack.folder}')}/. {shlex.quote(target)}/",
            *fix_attrs_commands(target, attrs),
        ]
        print(f"  install {pack.folder} -> {target}")
        adb.fs(" && ".join(steps), mutating=True)
        if not adb.dry_run:
            missing = local_files(pack.local_dir) - list_device_files(adb, target)
            if missing:
                raise SystemExit(f"{target}: {len(missing)} files missing after copy, e.g. {sorted(missing)[:5]}")
    return stale_report


def deploy_import(
    adb: Adb, mcaddons: list[Path], packs: list[PackInfo], mc_root: str, shots_dir: Path | None
) -> dict[str, str]:
    """Import each .mcaddon through Minecraft's VIEW handler; returns uuid -> installed folder."""
    installed_where: dict[str, str] = {}
    before = scan_installed(adb, mc_root)
    if all(find_installed(before, p) for p in packs):
        for p in packs:
            hit = find_installed(before, p)
            assert hit is not None
            print(f"  {p.folder} @ {p.version_str} already installed at {hit.path}")
            installed_where[p.uuid] = hit.path
        return installed_where
    # Import from a fresh main menu: an import delivered into a running world is untested.
    print("force-stopping Minecraft, then launching it to the main menu for import")
    adb.shell(f"am force-stop {MC_PACKAGE}", mutating=True)
    launch_minecraft(adb)
    for mcaddon in mcaddons:
        own = [p for p in packs if p.source == mcaddon]
        pending = [p for p in own if find_installed(before, p) is None]
        for p in own:
            hit = find_installed(before, p)
            if hit:
                print(f"  {p.folder} @ {p.version_str} already installed at {hit.path}; not re-importing it")
                installed_where[p.uuid] = hit.path
        if not pending:
            continue
        device_name = f"000-{mcaddon.stem}.mcaddon"
        device_file = f"{DOWNLOAD_DIR}/{device_name}"
        print(f"  push {mcaddon.name} -> {device_file}")
        adb.push(mcaddon, device_file)
        uri = "content://com.android.externalstorage.documents/document/" + urllib.parse.quote(
            f"primary:Download/{device_name}", safe=""
        )
        if not minecraft_resumed(adb) and not adb.dry_run:
            launch_minecraft(adb)
        print(f"  import via VIEW {uri}")
        adb.shell(
            f"am start -n {MC_ACTIVITY} -a android.intent.action.VIEW -d {shlex.quote(uri)} "
            f"-t application/octet-stream --grant-read-uri-permission",
            mutating=True,
        )
        if adb.dry_run:
            continue
        shot_taken = False
        deadline = time.monotonic() + IMPORT_TIMEOUT_S
        while pending and time.monotonic() < deadline:
            time.sleep(IMPORT_POLL_S)
            if shots_dir and not shot_taken:
                # The import toast shows for a few seconds right after the intent.
                adb.screenshot(shots_dir / f"import-{mcaddon.stem}.jpg")
                shot_taken = True
            now = scan_installed(adb, mc_root)
            for p in list(pending):
                hit = find_installed(now, p)
                if hit:
                    print(f"    installed {p.kind} {p.uuid} @ {p.version_str} -> {hit.path}")
                    installed_where[p.uuid] = hit.path
                    pending.remove(p)
        if pending:
            names = ", ".join(f"{p.folder}@{p.version_str}" for p in pending)
            raise SystemExit(f"import of {mcaddon.name} timed out: no installed folder for {names}")
    return installed_where


def backup_device_file(adb: Adb, device_path: str, local_path: Path) -> None:
    """Copy one device file to ``local_path``: root mode reads through su, else adb pull."""
    if adb.su:
        local_path.write_bytes(adb.read_bytes(device_path))
    else:
        adb.pull(device_path, local_path)


def bind_world(
    adb: Adb,
    world_dir: str,
    packs: list[PackInfo],
    backup_dir: Path,
    work: Path,
    exclusive: bool = False,
    root_create: tuple[FsAttrs, str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Rewrite the world's pack JSON in place and return the verified bindings per kind.

    ``root_create`` (attrs, staging dir) lets root mode create a MISSING JSON
    file through staging with the app's attributes; without it a missing file
    is pushed directly (possible only where the shell uid can create files).
    """
    final: dict[str, list[dict[str, Any]]] = {}
    for kind in ("behavior", "resource"):
        name = f"world_{kind}_packs.json"
        device_json = f"{world_dir}/{name}"
        local_before = backup_dir / name
        existed = adb.exists(device_json)
        if existed:
            backup_device_file(adb, device_json, local_before)
        before = load_bindings(local_before)
        after = rebind(before, [p for p in packs if p.kind == kind], exclusive)
        print(f"{name} before:\n{fmt_bindings(before)}")
        if after == before:
            print("  unchanged")
            final[kind] = before
            continue
        payload = json_bytes(after)
        (work / name).write_bytes(payload)
        if existed:
            adb.write_in_place(device_json, payload)
        elif root_create is not None:
            attrs, staging = root_create
            staged = f"{staging}/{name}"
            adb.push(work / name, staged)
            q = shlex.quote(device_json)
            adb.fs(
                f"cp {shlex.quote(staged)} {q} && chown {attrs.owner}:{attrs.group} {q}"
                f" && chmod {attrs.file_mode} {q} && chcon {shlex.quote(attrs.label)} {q}",
                mutating=True,
            )
        else:
            adb.push(work / name, device_json)
        if adb.dry_run:
            final[kind] = after
            continue
        # Measured 2026-09-24: an `adb pull` issued straight after the in-place
        # write returned 0 bytes although the file was correct seconds later
        # (FUSE size/attr cache after the truncate). Read the CONTENT back with
        # `cat` and retry briefly instead of trusting the first pull.
        verify = work / f"verify-{name}"
        for _attempt in range(VERIFY_RETRIES):
            verify.write_bytes(adb.read_bytes(device_json))
            if verify.read_bytes() == payload:
                break
            time.sleep(VERIFY_DELAY_S)
        final[kind] = load_bindings(verify)
        if final[kind] != after:
            raise SystemExit(f"{name}: device content after write does not match what was written")
    return final


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("world", help="world name as shown in levelname.txt")
    parser.add_argument("packs", nargs="+", type=Path, help=".mcaddon files")
    parser.add_argument("--mode", choices=("auto", "dev", "import"), default="auto")
    parser.add_argument(
        "--root",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="run file-system commands through su (default: auto-detect with `su -c id`)",
    )
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"), help="adb serial (default $ANDROID_SERIAL)")
    parser.add_argument("--shots-dir", type=Path, help="save an import-toast screenshot per pack here")
    parser.add_argument("--no-launch", action="store_true", help="leave Minecraft stopped after binding")
    parser.add_argument("--dry-run", action="store_true", help="read the device and plan, write nothing")
    parser.add_argument("--exclusive", action="store_true", help="bind ONLY these packs (drop every other binding; they stay installed)")
    args = parser.parse_args()

    adb = Adb(args.serial, args.dry_run)
    use_root = detect_root(adb) if args.root is None else bool(args.root)
    if use_root and args.root is True and not detect_root(adb):
        raise SystemExit("--root given but `su -c id` does not report uid 0 on the device")
    adb.su = use_root
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    work = Path(tempfile.mkdtemp(prefix=f"pixel-dev-deploy-{stamp}-"))
    # A NEW staging dir per run (never cleared, never reused): pid + time.
    staging = f"{STAGING_PARENT}/craftmatic-deploy-{stamp}-{os.getpid()}"
    print(f"serial: {args.serial or '(adb default)'}   dry-run: {args.dry_run}   root: {use_root}")
    print(f"extract dir: {work}")
    print(f"backup dir:  {backup_dir}")

    mc_root, world_dir = resolve_world(adb, args.world)
    print(f"world {args.world!r} -> {world_dir}")
    print(f"storage root: {mc_root}")
    attrs: FsAttrs | None = None
    if use_root:
        attrs = read_fs_attrs(adb, mc_root, world_dir)
        print(
            f"app attributes: owner {attrs.owner}:{attrs.group}, dirs {attrs.dir_mode}, "
            f"files {attrs.file_mode}, label {attrs.label}"
        )

    mcaddons: list[Path] = []
    packs: list[PackInfo] = []
    for mcaddon in args.packs:
        if not mcaddon.is_file():
            raise SystemExit(f"not a file: {mcaddon}")
        mcaddons.append(mcaddon.resolve())
        for info in extract_packs(mcaddon.resolve(), work):
            packs.append(info)
            print(f"  {mcaddon.name}: {info.kind:8s} {info.folder}  {info.uuid} @ {info.version_str}")
    uuids = [p.uuid for p in packs]
    if len(uuids) != len(set(uuids)):
        raise SystemExit("two packs share a uuid; refusing to deploy both")

    blocked_json = world_json_blocked(adb, world_dir)
    if blocked_json:
        print("BLOCKED: cannot rewrite the world's pack JSON: " + ", ".join(blocked_json))
        return 2
    blocked_dev = dev_blocked_paths(adb, packs, mc_root)
    mode = args.mode
    if mode == "auto":
        mode = "import" if blocked_dev else "dev"
        if blocked_dev:
            print("dev pack dirs are not writable by the adb shell uid -> import mode")
    if mode == "dev" and blocked_dev:
        print("BLOCKED: the adb shell uid cannot write these device paths:")
        for path in blocked_dev:
            print(f"  {path}")
        print("Nothing was written. Use --mode import (Minecraft's own import) or --root instead.")
        return 2
    print(f"mode: {mode}")

    backup_dir.mkdir(parents=True, exist_ok=True)
    stale_report: dict[str, list[str]] = {}
    installed_where: dict[str, str] = {}
    staging_used = False
    if mode == "dev":
        # A regular imported copy with the same uuid can shadow the development one.
        for item in scan_installed(adb, mc_root):
            for pack in packs:
                if item.uuid == pack.uuid:
                    print(f"  WARNING: regular pack {item.path} shares uuid {pack.uuid} with {pack.folder}")
        print("force-stopping Minecraft")
        adb.shell(f"am force-stop {MC_PACKAGE}", mutating=True)
        if attrs is not None:
            print(f"staging dir: {staging} (kept; nothing is deleted)")
            stale_report = deploy_dev_root(adb, packs, mc_root, attrs, staging, backup_dir)
            staging_used = True
        else:
            stale_report = deploy_dev(adb, packs, mc_root, backup_dir)
        installed_where = {p.uuid: p.device_dir(mc_root) for p in packs}
    else:
        installed_where = deploy_import(adb, mcaddons, packs, mc_root, args.shots_dir)

    # World JSON may only be edited while Minecraft is stopped.
    print("force-stopping Minecraft before binding")
    adb.shell(f"am force-stop {MC_PACKAGE}", mutating=True)
    root_create: tuple[FsAttrs, str] | None = None
    if attrs is not None:
        if not staging_used:
            adb.shell(f"mkdir {shlex.quote(staging)}", mutating=True)
            staging_used = True
        root_create = (attrs, staging)
    final = bind_world(adb, world_dir, packs, backup_dir, work, args.exclusive, root_create)

    record = {
        "timestamp": stamp,
        "dry_run": args.dry_run,
        "mode": mode,
        "root": use_root,
        "serial": args.serial,
        "world": args.world,
        "storage_root": mc_root,
        "world_dir": world_dir,
        "staging_dir": staging if staging_used else None,
        "packs": [
            {"source": str(p.source), "folder": p.folder, "kind": p.kind, "uuid": p.uuid, "version": p.version,
             "installed_at": installed_where.get(p.uuid), "name": p.name}
            for p in packs
        ],
        "bindings": final,
        "stale_device_files": stale_report,
    }
    (backup_dir / "deploy-record.json").write_bytes(json_bytes(record))

    if not args.no_launch:
        print("relaunching Minecraft (main menu; open the world from the Play list)")
        launch_minecraft(adb)

    print("\n=== summary ===")
    for pack in packs:
        print(f"  {pack.kind:8s} {pack.uuid} @ {pack.version_str}  {installed_where.get(pack.uuid, '?')}")
    for kind in ("behavior", "resource"):
        print(f"world_{kind}_packs.json now:\n{fmt_bindings(final[kind])}")
    for device_dir, files in stale_report.items():
        print(f"  STALE (left on device, not in new build) {device_dir}: {len(files)} files, e.g. {files[:5]}")
    if staging_used:
        print(f"  staging dir kept on device: {staging}")
    print(f"record: {backup_dir / 'deploy-record.json'}")
    if args.dry_run:
        print("dry-run: nothing on the device was written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
