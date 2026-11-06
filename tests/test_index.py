#!/usr/bin/env python3
"""End-to-end tests for tools/index.py.

Run: python tests/test_index.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import index as spk_index  # noqa: E402  (tools/index.py)
from make_spk import icon_72, icon_120, make_spk  # noqa: E402

INFO_PLAIN = """\
# leading comment
package="PlainPkg"
version="1.0.0-1"
displayname="Plain Package"
description="A plain DSM 7 package"
arch="x86_64"
os_min_ver="7.2-64570"
maintainer="Test Maintainer"
maintainer_url="https://example.com/maintainer"
"""

INFO_GZ = """\
package="GzPkg"
version="2.0-1"
displayname="GZ Package"
description="Line one
Line two"
description_chs="中文描述"
displayname_chs="压缩包"
arch="apollolake"
os_min_ver="7.1-42661"
os_max_ver="7.2-72806"
maintainer="Test Maintainer"
beta="true"
silent_install="true"
qinst="true"
"""

INFO_MODEL = """\
package="ModelPkg"
version="1.5-3"
displayname="Model Package"
description="Requires root privileges to run"
arch="x86_64"
model="synology_apollolake_ds918+ synology_apollolake_ds920+"
exclude_model="synology_apollolake_ds423+"
os_min_ver="7.1-42661"
maintainer="Test Maintainer"
"""

INFO_NOARCH = """\
package="NoarchPkg"
version="1.0-1"
displayname="Noarch Package"
description="Architecture independent"
arch="noarch"
exclude_arch="armv8"
os_min_ver="7.0-40000"
maintainer="Test Maintainer"
"""


def build_fixtures(packages_dir: Path) -> None:
    make_spk(packages_dir / "01-plain.spk", INFO_PLAIN, wizard=True, screens=2)
    make_spk(packages_dir / "02-gz.spk", INFO_GZ, gzip=True, icons=False)
    make_spk(packages_dir / "03-model.spk", INFO_MODEL)
    make_spk(packages_dir / "04-noarch.spk", INFO_NOARCH)
    make_spk(
        packages_dir / "05-embedded-icon.spk",
        INFO_NOARCH.replace('package="NoarchPkg"', 'package="EmbeddedIconPkg"')
        .replace('displayname="Noarch Package"', 'displayname="Embedded Icon"')
        + f'package_icon="{base64.b64encode(icon_72()).decode()}"\n'
        + f'package_icon_256="{base64.b64encode(icon_120()).decode()}"\n',
        icons=False,
    )
    make_spk(packages_dir / "90-broken.spk", None, icons=False)
    (packages_dir / "91-encrypted.spk").write_bytes(b"\x01\xad\xbe\xef" + b"\x00" * 512)


class InfoParserTests(unittest.TestCase):
    def test_quotes_escapes_and_comments(self) -> None:
        content = (
            'a="simple"\n'
            "b='single \\n literal'\n"
            'c="escaped \\"quote\\" and \\\\ slash and \\$dollar"\n'
            "# comment\n"
            "; also comment\n"
            "d=unquoted value  \n"
        ).encode("utf-8")
        self.assertEqual(
            spk_index.parse_info(content),
            {
                "a": "simple",
                "b": "single \\n literal",
                "c": 'escaped "quote" and \\ slash and $dollar',
                "d": "unquoted value",
            },
        )

    def test_multiline_value_and_crlf_bom(self) -> None:
        content = ('\ufeffa="one\r\ntwo\r\nthree"\r\nb=2\r\n').encode("utf-8")
        self.assertEqual(spk_index.parse_info(content), {"a": "one\ntwo\nthree", "b": "2"})

    def test_invalid_input_raises(self) -> None:
        with self.assertRaises(spk_index.SpkError):
            spk_index.parse_info(b"this is not info\n")
        with self.assertRaises(spk_index.SpkError):
            spk_index.parse_info(b'a="unterminated\n')
        with self.assertRaises(spk_index.SpkError):
            spk_index.parse_info(b"a=\xff\xfe\n")


class VersionHelperTests(unittest.TestCase):
    def test_valid_dsm_versions(self) -> None:
        for version in ("7.0-40000", "7.2-69057", "7.2.1-69057", "7.2.2-72806"):
            self.assertTrue(spk_index.is_valid_dsm_version(version), version)
        for version in ("7.2.1", "7.2.1.0-69057", "7.2.-69057", "7.2.1_69057",
                        "7.2.2147483648-69057", "7.2.1-2147483648", "2147483648.2.1-69057"):
            self.assertFalse(spk_index.is_valid_dsm_version(version), version)

    def test_compare_dsm_versions(self) -> None:
        cases = [("7.2.1-69057", "7.2-69057", 0), ("7.2.1-69057", "7.2-64570", 1),
                 ("7.2.1-69057", "7.2.2-72806", -1), ("7.2.1-69057", "7.3-86009", -1),
                 ("7.2.1-69057", "7.1-99999", 1)]
        for left, right, expected in cases:
            self.assertEqual(spk_index.compare_dsm_versions(left, right), expected, (left, right))

    def test_package_version_validation(self) -> None:
        for version in ("1.0-1", "1.0.0-1", "2.0_1", "2026.01.01-1"):
            self.assertTrue(spk_index.is_valid_package_version(version), version)
        for version in ("1", "v1.0-1", "1.0-", "1.0-2147483648"):
            self.assertFalse(spk_index.is_valid_package_version(version), version)


class IndexerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        base = Path(cls.temp.name)
        cls.packages_dir = base / "packages"
        cls.out_dir = base / "dist"
        build_fixtures(cls.packages_dir)
        result = subprocess.run(
            [sys.executable, str(TOOLS / "index.py"), "--packages", str(cls.packages_dir),
             "--out", str(cls.out_dir), "--pretty", "--base-url", "https://spk.example.com/"],
            capture_output=True, text=True, timeout=180,
        )
        if result.returncode != 0:
            raise AssertionError(f"indexer failed:\n{result.stdout}\n{result.stderr}")
        cls.index = json.loads((cls.out_dir / "index.json").read_text(encoding="utf-8"))
        cls.report = json.loads((cls.out_dir / "index.report.json").read_text(encoding="utf-8"))
        cls.records = {record["file"]: record for record in cls.index["packages"]}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_schema_and_order(self) -> None:
        self.assertEqual(self.index["schema"], 1)
        self.assertEqual(self.index["base_url"], "https://spk.example.com/")
        self.assertIn("generated_at", self.index)
        self.assertEqual(
            [record["file"] for record in self.index["packages"]],
            ["01-plain.spk", "02-gz.spk", "03-model.spk", "04-noarch.spk", "05-embedded-icon.spk"],
        )
        self.assertEqual(self.report["ok"], 5)
        self.assertEqual(self.report["skipped"], 2)

    def test_plain_package(self) -> None:
        record = self.records["01-plain.spk"]
        self.assertEqual(record["package"], "PlainPkg")
        self.assertEqual(record["version"], "1.0.0-1")
        self.assertEqual(record["displayname"], "Plain Package")
        self.assertEqual(record["description"], "A plain DSM 7 package")
        self.assertEqual(record["arch"], ["x86_64"])
        self.assertEqual(record["os_min_ver"], "7.2-64570")
        self.assertEqual(record["os_max_ver"], "")
        self.assertFalse(record["beta"])
        self.assertFalse(record["official"])
        self.assertFalse(record["run_as_root"])
        # WIZARD_UIFILES present → quick install/start/upgrade are disabled.
        self.assertFalse(record["qinst"])
        self.assertFalse(record["qstart"])
        self.assertFalse(record["qupgrade"])
        self.assertEqual(record["file"], "01-plain.spk")
        self.assertEqual(record["filesize"], (self.packages_dir / "01-plain.spk").stat().st_size)
        self.assertEqual(record["md5"], hashlib.md5((self.packages_dir / "01-plain.spk").read_bytes()).hexdigest())
        self.assertEqual(
            record["thumbnail"],
            ["icons/01-plain_thumb_72.png", "icons/01-plain_thumb_120.png"],
        )
        self.assertEqual(len(record["snapshot"]), 2)
        self.assertEqual(record["snapshot"][0], "icons/01-plain_screen_1.png")
        self.assertEqual((self.out_dir / record["thumbnail"][0]).read_bytes(), icon_72())

    def test_gzip_package_and_localization(self) -> None:
        record = self.records["02-gz.spk"]
        self.assertEqual(record["arch"], ["apollolake"])
        self.assertEqual(record["os_max_ver"], "7.2-72806")
        self.assertEqual(record["description"], "Line one\nLine two")
        self.assertEqual(record["displayname_chs"], "压缩包")
        self.assertEqual(record["description_chs"], "中文描述")
        self.assertTrue(record["beta"])
        self.assertTrue(record["silent_install"])
        self.assertTrue(record["qinst"])  # explicit INFO override
        self.assertTrue(record["qupgrade"])  # no wizard directory
        self.assertFalse(record["silent_uninstall"])
        # No icons in the archive → bundled defaults.
        self.assertEqual(record["thumbnail"], ["icons/_default_72.png", "icons/_default_120.png"])
        self.assertEqual(record["snapshot"], [])

    def test_models_and_root_detection(self) -> None:
        record = self.records["03-model.spk"]
        self.assertEqual(record["model"], ["synology_apollolake_ds918+", "synology_apollolake_ds920+"])
        self.assertEqual(record["exclude_model"], ["synology_apollolake_ds423+"])
        self.assertTrue(record["run_as_root"])
        self.assertTrue(record["qinst"])  # no wizard directory → quick install enabled

    def test_noarch_and_exclude_arch(self) -> None:
        record = self.records["04-noarch.spk"]
        self.assertEqual(record["arch"], ["noarch"])
        self.assertEqual(record["exclude_arch"], ["armv8"])
        self.assertEqual(record["os_min_ver"], "7.0-40000")

    def test_embedded_base64_icons(self) -> None:
        record = self.records["05-embedded-icon.spk"]
        self.assertEqual(record["thumbnail"], ["icons/05-embedded-icon_thumb_72.png",
                                               "icons/05-embedded-icon_thumb_120.png"])
        self.assertEqual((self.out_dir / record["thumbnail"][0]).read_bytes(), icon_72())
        self.assertEqual((self.out_dir / record["thumbnail"][1]).read_bytes(), icon_120())

    def test_skipped_entries(self) -> None:
        entries = {entry["file"]: entry for entry in self.report["entries"]}
        self.assertEqual(entries["90-broken.spk"]["status"], "skipped")
        self.assertIn("INFO", entries["90-broken.spk"]["error"])
        self.assertEqual(entries["91-encrypted.spk"]["status"], "skipped")
        self.assertIn("keytype 3", entries["91-encrypted.spk"]["error"])
        self.assertNotIn("90-broken.spk", self.records)
        self.assertNotIn("91-encrypted.spk", self.records)

    def test_defaults_and_icons_on_disk(self) -> None:
        defaults = self.index["defaults"]
        self.assertEqual(defaults["download_count"], 0)
        self.assertEqual(defaults["maintainer"], "Community Repository")
        self.assertTrue((self.out_dir / "icons" / "_default_72.png").is_file())
        self.assertTrue((self.out_dir / "icons" / "_default_120.png").is_file())

    def test_bundle_mode_embeds_icons_and_metadata(self) -> None:
        bundle_path = Path(self.temp.name) / "sspks-index.json"
        out_dir = Path(self.temp.name) / "bundle-dist"
        result = subprocess.run(
            [sys.executable, str(TOOLS / "index.py"), "--packages", str(self.packages_dir),
             "--out", str(out_dir), "--bundle", str(bundle_path),
             "--repo", "NeeYoonc/dsh-nas", "--tag", "dsh-v0.2.2-rc.1"],
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((out_dir / "index.json").exists(), "bundle mode must not write dist")

        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        self.assertEqual(bundle["schema"], 2)
        self.assertEqual(bundle["repo"], "NeeYoonc/dsh-nas")
        self.assertEqual(bundle["tag"], "dsh-v0.2.2-rc.1")
        self.assertEqual(len(bundle["packages"]), 5)
        self.assertEqual(
            [item["file"] for item in bundle["packages"]],
            [record["file"] for record in self.index["packages"]],
        )
        self.assertIn("icons/_default_72.png", bundle["icons"])
        self.assertIn("icons/01-plain_thumb_72.png", bundle["icons"])
        self.assertEqual(base64.b64decode(bundle["icons"]["icons/_default_72.png"]), icon_72())
        self.assertEqual(base64.b64decode(bundle["icons"]["icons/01-plain_screen_1.png"]), icon_120())
        # md5 of the real SPK must survive into the bundle (the Worker cannot hash it).
        plain = next(item for item in bundle["packages"] if item["package"] == "PlainPkg")
        self.assertEqual(plain["md5"], hashlib.md5((self.packages_dir / "01-plain.spk").read_bytes()).hexdigest())

    def test_bundle_with_upload_is_rejected(self) -> None:
        result = subprocess.run(
            [sys.executable, str(TOOLS / "index.py"), "--packages", str(self.packages_dir),
             "--bundle", str(Path(self.temp.name) / "x.json"), "--dry-run"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--bundle", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
