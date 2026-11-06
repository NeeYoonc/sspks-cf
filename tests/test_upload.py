#!/usr/bin/env python3
"""End-to-end test for `python tools/index.py --upload`.

Runs the indexer against a local S3-compatible mock (signature verified) and
checks the produced object layout in the bucket.

Run: python tests/test_upload.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from make_spk import make_spk  # noqa: E402
from test_r2 import ACCESS_KEY, SECRET_KEY, MockR2Handler  # noqa: E402

INFO_VALID = """\
package="TestPkg"
version="1.0.0-1"
displayname="Test Package"
description="Upload test package"
arch="x86_64"
os_min_ver="7.2-64570"
maintainer="Test Maintainer"
"""


class UploadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockR2Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

        cls.temp = tempfile.TemporaryDirectory()
        base = Path(cls.temp.name)
        cls.packages = base / "packages"
        cls.out = base / "dist"
        make_spk(cls.packages / "Test-1.0.0-1.spk", INFO_VALID, screens=1)
        make_spk(cls.packages / "Broken-1.0-1.spk", None, icons=False)

        cls.env = dict(os.environ)
        cls.env.update({
            "R2_ACCOUNT_ID": "test-account",
            "R2_ACCESS_KEY_ID": ACCESS_KEY,
            "R2_SECRET_ACCESS_KEY": SECRET_KEY,
            "R2_BUCKET": "sspks",
            "R2_ENDPOINT": f"http://127.0.0.1:{cls.port}",
        })
        # A stand-in for the wrangler CLI: records its arguments as JSON lines.
        cls.wrangler_log = base / "wrangler-calls.jsonl"
        cls.fake_wrangler = base / "fake_wrangler.py"
        cls.fake_wrangler.write_text(
            "import json, os, sys\n"
            "with open(sys.argv[1], \"a\", encoding=\"utf-8\") as handle:\n"
            "    handle.write(json.dumps(sys.argv[2:]) + \"\\n\")\n"
            "if os.environ.get(\"FAKE_WRANGLER_FAIL\") == \"1\":\n"
            "    sys.stderr.write(\"simulated failure\\n\")\n"
            "    raise SystemExit(1)\n",
            encoding="utf-8",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def wrangler_command(self) -> str:
        return f'{sys.executable} "{self.fake_wrangler}" "{self.wrangler_log}"'

    def run_indexer(self, *extra: str, env: dict | None = None) -> subprocess.CompletedProcess:
        merged = dict(self.env)
        merged.update(env or {})
        return subprocess.run(
            [sys.executable, str(ROOT / "tools" / "index.py"),
             "--packages", str(self.packages), "--out", str(self.out), *extra],
            capture_output=True, text=True, timeout=180, env=merged,
        )

    def test_upload_layout(self) -> None:
        MockR2Handler.objects.clear()
        result = self.run_indexer("--upload", "--bucket", "sspks")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        objects = MockR2Handler.objects
        self.assertIn("spk/index.json", objects)
        self.assertIn("spk/icons/_default_72.png", objects)
        self.assertIn("spk/icons/_default_120.png", objects)
        self.assertIn("spk/packages/Test-1.0.0-1.spk", objects)
        self.assertIn("spk/icons/Test-1.0.0-1_thumb_72.png", objects)
        self.assertIn("spk/icons/Test-1.0.0-1_screen_1.png", objects)
        self.assertNotIn("spk/packages/Broken-1.0-1.spk", objects,
                         "skipped packages must not be uploaded")

        index = json.loads(objects["spk/index.json"].decode("utf-8"))
        self.assertEqual(len(index["packages"]), 1)
        self.assertEqual(index["packages"][0]["package"], "TestPkg")
        self.assertEqual(objects["spk/packages/Test-1.0.0-1.spk"],
                         (self.packages / "Test-1.0.0-1.spk").read_bytes())
        self.assertEqual(objects["spk/index.json"], (self.out / "index.json").read_bytes())

    def test_dry_run_uploads_nothing(self) -> None:
        MockR2Handler.objects.clear()
        result = self.run_indexer("--dry-run", "--bucket", "sspks")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PUT spk/index.json", result.stdout)
        self.assertEqual(MockR2Handler.objects, {})

    def test_skip_existing_keeps_objects(self) -> None:
        MockR2Handler.objects.clear()
        first = self.run_indexer("--upload", "--bucket", "sspks")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        # index.json embeds a build timestamp and is always re-uploaded.
        before = {key: value for key, value in MockR2Handler.objects.items() if key != "spk/index.json"}

        second = self.run_indexer("--upload", "--skip-existing", "--bucket", "sspks")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("skipped", second.stdout)
        after = {key: value for key, value in MockR2Handler.objects.items() if key != "spk/index.json"}
        self.assertEqual(after, before)

    def test_command_splitting_helpers(self) -> None:
        import index as spk_index

        command = spk_index.split_command(f'{sys.executable} "C:\\some dir\\fake.py"')
        self.assertEqual(command[0], sys.executable)
        self.assertEqual(command[1], "C:\\some dir\\fake.py")
        resolved = spk_index.resolve_executable(["definitely-not-a-real-binary-xyz", "--version"])
        self.assertEqual(resolved[0], "definitely-not-a-real-binary-xyz")
        if os.name == "nt":
            self.assertTrue(spk_index.resolve_executable(["npx"])[0].lower().endswith((".cmd", ".exe")))

    def test_wrangler_backend_dry_run_prints_commands(self) -> None:
        result = self.run_indexer(
            "--dry-run", "--upload-backend", "wrangler", "--bucket", "sspks",
            "--wrangler-cmd", self.wrangler_command(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("r2 object put sspks/spk/index.json", result.stdout)
        self.assertIn("--remote", result.stdout)
        self.assertIn("--file", result.stdout)
        self.assertFalse(self.wrangler_log.exists(), "dry run must not execute wrangler")

    def test_wrangler_backend_uploads_every_object(self) -> None:
        if self.wrangler_log.exists():
            self.wrangler_log.unlink()
        result = self.run_indexer(
            "--upload", "--upload-backend", "wrangler", "--bucket", "sspks",
            "--wrangler-cmd", self.wrangler_command(),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        calls = [json.loads(line) for line in self.wrangler_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(calls), 7, "index + 5 icons + 1 spk")
        for argv in calls:
            self.assertEqual(argv[:3], ["r2", "object", "put"])
            self.assertIn("--remote", argv)
            self.assertIn("--file", argv)
            self.assertTrue(argv[3].startswith("sspks/spk/"))
        targets = {argv[3] for argv in calls}
        self.assertIn("sspks/spk/index.json", targets)
        self.assertIn("sspks/spk/icons/_default_72.png", targets)
        self.assertIn("sspks/spk/packages/Test-1.0.0-1.spk", targets)
        self.assertNotIn("sspks/spk/packages/Broken-1.0-1.spk", targets)

    def test_wrangler_backend_surfaces_failure(self) -> None:
        result = self.run_indexer(
            "--upload", "--upload-backend", "wrangler", "--bucket", "sspks",
            "--wrangler-cmd", self.wrangler_command(),
            env={"FAKE_WRANGLER_FAIL": "1"},
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("simulated failure", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
