#!/usr/bin/env python3
"""Helpers that build synthetic .spk archives for the test suite."""
from __future__ import annotations

import io
import tarfile
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"


def icon_72() -> bytes:
    return (ASSETS / "default_icon_72.png").read_bytes()


def icon_120() -> bytes:
    return (ASSETS / "default_icon_120.png").read_bytes()


def make_spk(
    path: Path,
    info: str | None,
    *,
    gzip: bool = False,
    wizard: bool = False,
    icons: bool = True,
    screens: int = 0,
    privilege: bytes | None = None,
    extra: dict[str, bytes] | None = None,
) -> Path:
    """Create an SPK archive at `path` (plain tar, or gzip-compressed)."""
    mode = "w:gz" if gzip else "w"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, mode=mode) as archive:
        def add(name: str, data: bytes) -> None:
            info_obj = tarfile.TarInfo(name)
            info_obj.size = len(data)
            info_obj.mtime = 1_700_000_000
            archive.addfile(info_obj, io.BytesIO(data))

        if info is not None:
            add("INFO", info.encode("utf-8"))
        if icons:
            add("PACKAGE_ICON.PNG", icon_72())
            add("PACKAGE_ICON_256.PNG", icon_120())
        for index in range(1, screens + 1):
            add(f"screen_{index}.png", icon_120())
        if wizard:
            directory = tarfile.TarInfo("WIZARD_UIFILES")
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o755
            archive.addfile(directory, io.BytesIO(b""))
            add("WIZARD_UIFILES/install.sh", b"#!/bin/sh\nexit 0\n")
        if privilege is not None:
            add("conf/privilege", privilege)
        add("package.tgz", b"\x1f\x8b\x08\x00promise-not-a-real-tarball")
        for name, data in (extra or {}).items():
            add(name, data)
    return path


def info_text(**fields: str) -> str:
    lines = [f'{key}="{value}"' for key, value in fields.items()]
    return "\n".join(lines) + "\n"
