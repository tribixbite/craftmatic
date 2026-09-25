#!/usr/bin/env python3
"""Install built Craftmatic .mcaddon packs on an Android device over adb and
bind them to one Minecraft Bedrock world at their exact versions.

Usage (run with ``python -u`` so progress is not block-buffered):

    python -u scripts/_pixel_dev_deploy.py <world name> <pack.mcaddon>... \
        [--mode auto|dev|import] [--serial SERIAL] [--shots-dir DIR] \
        [--no-launch] [--dry-run]

Two install routes:

``dev``    Push each pack folder into ``development_{behavior,resource}_packs``.
           Needs a writable games/com.mojang tree (root, or a device where the
           app made those dirs group-writable). Existing dev folders are pulled
           to the backup dir first and overwritten in place; nothing on the
           device is deleted, so files a new build no longer ships are LEFT
           BEHIND and reported as stale.
``import`` Push each .mcaddon to ``/sdcard/Download/000-<stem>.mcaddon`` and hand
           it to Minecraft with a content-URI VIEW intent (Minecraft's own
           import, which writes regular ``behavior_packs``/``resource_packs``
           folders such as ``ArcadePinb(7)``). Success is judged ONLY by a
           folder whose manifest carries the pack's uuid AND exact version.
``auto``   (default) ``dev`` when every dev target is writable, else ``import``.

Measured on the Pixel 8 Pro (Android 17, Minecraft 26.51, storage External,
2026-09-24): ``files/`` is ``drwxrws---`` but Minecraft creates
``games/com.mojang`` and every dir below it ``drwxr-s---`` (owner u0_a<app>,
group ext_data_rw). The adb shell uid is in ext_data_rw: it can read
everything and overwrite existing ``-rw-rw----`` files in place, but cannot
create, rename or move anything there. So ``dev`` is blocked without root,
while the world's ``world_*_packs.json`` can still be rewritten IN PLACE —
which is why JSON goes through ``adb exec-in 'cat > file'`` (truncate + write
on the existing inode), never ``adb push`` (which may create a new file).

After installing, in either mode: force-stop Minecraft, back up and rewrite the
world's ``world_behavior_packs.json`` / ``world_resource_packs.json`` (each
pack's uuid bound at its exact manifest version, an entry with the same uuid
replaced, all other entries kept), re-pull to verify, and relaunch Minecraft to
its main menu (``--no-launch`` leaves it stopped). Opening the world is left
to the caller: the Play list order changes and a LAN tile can sit first.

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
MC_ROOT = f"/sdcard/Android/data/{MC_PACKAGE}/files/games/com.mojang"
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

    @property
    def dev_parent(self) -> str:
        """Device development-pack directory for this pack's kind."""
        return f"{MC_ROOT}/development_{self.kind}_packs"

    @property
    def device_dir(self) -> str:
        return f"{self.dev_parent}/{self.folder}"

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


class Adb:
    """Thin retrying wrapper around the adb executable."""

    def __init__(self, serial: str | None, dry_run: bool) -> None:
        self.serial = serial
        self.dry_run = dry_run

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
        """Run one shell command string on the device."""
        return self.run(["shell", command], check=check, mutating=mutating)

    def exists(self, device_path: str) -> bool:
        out = self.shell(f"[ -e {shlex.quote(device_path)} ] && echo YES || echo NO", check=False)
        return out.strip().endswith("YES")

    def writable(self, device_path: str) -> bool:
        out = self.shell(f"[ -w {shlex.quote(device_path)} ] && echo W || echo RO", check=False)
        return out.strip().endswith("W")

    def pull(self, device_path: str, local_path: Path) -> None:
        # Pulling is read-only on the device, so it runs even under --dry-run.
        self.run(["pull", device_path, str(local_path).replace("\\", "/")])

    def push(self, local_path: Path, device_path: str) -> None:
        self.run(["push", str(local_path).replace("\\", "/"), device_path], mutating=True)

    def write_in_place(self, device_path: str, data: bytes) -> None:
        """Overwrite an EXISTING device file's bytes without creating a new inode.

        ``cat >`` truncates and writes the open file, which only needs write
        permission on the file itself — not on its (read-only) directory.
        """
        self.run(["exec-in", f"cat > {shlex.quote(device_path)}"], mutating=True, stdin_bytes=data)

    def read_bytes(self, device_path: str) -> bytes:
        """A device file's exact bytes via `exec-out cat` (no stat-size dependence)."""
        proc = subprocess.run(self._cmd(["exec-out", "cat", device_path]), capture_output=True)
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


def resolve_world(adb: Adb, world_name: str) -> str:
    """Return the device path of the world folder whose levelname.txt matches."""
    listing = adb.shell(
        f"cd {MC_ROOT}/minecraftWorlds && for w in *; do printf '%s\\t' \"$w\"; cat \"$w/levelname.txt\" 2>/dev/null; echo; done"
    )
    matches: list[str] = []
    for line in listing.splitlines():
        if "\t" not in line:
            continue
        folder, level = line.split("\t", 1)
        if level.strip() == world_name:
            matches.append(folder)
    if not matches:
        raise SystemExit(f"No world named {world_name!r} on the device. Worlds:\n{listing}")
    if len(matches) > 1:
        raise SystemExit(f"World name {world_name!r} is ambiguous: folders {matches}")
    return f"{MC_ROOT}/minecraftWorlds/{matches[0]}"


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
    out = adb.shell(f"cd {shlex.quote(device_dir)} && find . -type f", check=False)
    return {line.strip()[2:] for line in out.splitlines() if line.strip().startswith("./")}


def local_files(local_dir: Path) -> set[str]:
    return {p.relative_to(local_dir).as_posix() for p in local_dir.rglob("*") if p.is_file()}


def scan_installed(adb: Adb, roots: tuple[str, ...] = ("behavior_packs", "resource_packs")) -> list[InstalledPack]:
    """Every pack folder under the given com.mojang roots, read from its manifest."""
    globs = " ".join(f"{MC_ROOT}/{r}/*" for r in roots)
    script = (
        f"for d in {globs}; do "
        f"[ -f \"$d/manifest.json\" ] || continue; "
        f"echo \"@@ $d\"; cat \"$d/manifest.json\"; echo; done"
    )
    out = adb.shell(script, check=False)
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


def dev_blocked_paths(adb: Adb, packs: list[PackInfo]) -> list[str]:
    """Dev-install targets the adb shell uid cannot write (see module docstring)."""
    needed = [p.device_dir if adb.exists(p.device_dir) else p.dev_parent for p in packs]
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


def deploy_dev(adb: Adb, packs: list[PackInfo], backup_dir: Path) -> dict[str, list[str]]:
    """Push every pack folder into the development pack dirs; returns stale files per dir."""
    stale_report: dict[str, list[str]] = {}
    for pack in packs:
        adb.shell(f"mkdir -p {shlex.quote(pack.dev_parent)}", mutating=True)
        if adb.exists(pack.device_dir):
            dest = backup_dir / f"development_{pack.kind}_packs"
            dest.mkdir(parents=True, exist_ok=True)
            print(f"  backing up existing {pack.device_dir} -> {dest / pack.folder}")
            adb.pull(pack.device_dir, dest)
            stale = sorted(list_device_files(adb, pack.device_dir) - local_files(pack.local_dir))
            if stale:
                stale_report[pack.device_dir] = stale
        # Pushing a directory onto an EXISTING parent lands it at parent/<basename>,
        # overwriting same-named files and leaving others untouched.
        print(f"  push {pack.folder} -> {pack.dev_parent}/")
        adb.push(pack.local_dir, pack.dev_parent + "/")
    return stale_report


def deploy_import(
    adb: Adb, mcaddons: list[Path], packs: list[PackInfo], shots_dir: Path | None
) -> dict[str, str]:
    """Import each .mcaddon through Minecraft's VIEW handler; returns uuid -> installed folder."""
    installed_where: dict[str, str] = {}
    before = scan_installed(adb)
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
            now = scan_installed(adb)
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


def bind_world(adb: Adb, world_dir: str, packs: list[PackInfo], backup_dir: Path, work: Path, exclusive: bool = False) -> dict[str, list[dict[str, Any]]]:
    """Rewrite the world's pack JSON in place and return the verified bindings per kind."""
    final: dict[str, list[dict[str, Any]]] = {}
    for kind in ("behavior", "resource"):
        name = f"world_{kind}_packs.json"
        device_json = f"{world_dir}/{name}"
        local_before = backup_dir / name
        existed = adb.exists(device_json)
        if existed:
            adb.pull(device_json, local_before)
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
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"), help="adb serial (default $ANDROID_SERIAL)")
    parser.add_argument("--shots-dir", type=Path, help="save an import-toast screenshot per pack here")
    parser.add_argument("--no-launch", action="store_true", help="leave Minecraft stopped after binding")
    parser.add_argument("--dry-run", action="store_true", help="read the device and plan, write nothing")
    parser.add_argument("--exclusive", action="store_true", help="bind ONLY these packs (drop every other binding; they stay installed)")
    args = parser.parse_args()

    adb = Adb(args.serial, args.dry_run)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    work = Path(tempfile.mkdtemp(prefix=f"pixel-dev-deploy-{stamp}-"))
    print(f"serial: {args.serial or '(adb default)'}   dry-run: {args.dry_run}")
    print(f"extract dir: {work}")
    print(f"backup dir:  {backup_dir}")

    world_dir = resolve_world(adb, args.world)
    print(f"world {args.world!r} -> {world_dir}")

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
    blocked_dev = dev_blocked_paths(adb, packs)
    mode = args.mode
    if mode == "auto":
        mode = "import" if blocked_dev else "dev"
        if blocked_dev:
            print("dev pack dirs are not writable by the adb shell uid -> import mode")
    if mode == "dev" and blocked_dev:
        print("BLOCKED: the adb shell uid cannot write these device paths:")
        for path in blocked_dev:
            print(f"  {path}")
        print("Nothing was written. Use --mode import (Minecraft's own import) instead.")
        return 2
    print(f"mode: {mode}")

    backup_dir.mkdir(parents=True, exist_ok=True)
    stale_report: dict[str, list[str]] = {}
    installed_where: dict[str, str] = {}
    if mode == "dev":
        # A regular imported copy with the same uuid can shadow the development one.
        for item in scan_installed(adb):
            for pack in packs:
                if item.uuid == pack.uuid:
                    print(f"  WARNING: regular pack {item.path} shares uuid {pack.uuid} with {pack.folder}")
        print("force-stopping Minecraft")
        adb.shell(f"am force-stop {MC_PACKAGE}", mutating=True)
        stale_report = deploy_dev(adb, packs, backup_dir)
        installed_where = {p.uuid: p.device_dir for p in packs}
    else:
        installed_where = deploy_import(adb, mcaddons, packs, args.shots_dir)

    # World JSON may only be edited while Minecraft is stopped.
    print("force-stopping Minecraft before binding")
    adb.shell(f"am force-stop {MC_PACKAGE}", mutating=True)
    final = bind_world(adb, world_dir, packs, backup_dir, work, args.exclusive)

    record = {
        "timestamp": stamp,
        "dry_run": args.dry_run,
        "mode": mode,
        "serial": args.serial,
        "world": args.world,
        "world_dir": world_dir,
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
    print(f"record: {backup_dir / 'deploy-record.json'}")
    if args.dry_run:
        print("dry-run: nothing on the device was written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
