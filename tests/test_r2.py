#!/usr/bin/env python3
"""Tests for the dependency-free R2 client (tools/r2.py).

The client signs requests with AWS Signature V4. These tests run a local mock
S3 endpoint that verifies the signature against the wire request, so the
canonical request / signing-key construction and the HTTP transport are both
exercised without Cloudflare credentials.

Run: python tests/test_r2.py
"""
from __future__ import annotations

import hashlib
import hmac
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import r2  # noqa: E402

ACCESS_KEY = "AKIDTESTEXAMPLE"
SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
BUCKET = "sspks"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, date_stamp: str) -> bytes:
    key = _hmac(("AWS4" + secret).encode("utf-8"), date_stamp)
    key = _hmac(key, "auto")
    key = _hmac(key, "s3")
    return _hmac(key, "aws4_request")


def verify_signature(method: str, path: str, headers, payload_hash: str) -> tuple[bool, str]:
    """Rebuild the canonical request from the wire data and verify the signature."""
    authorization = headers.get("Authorization", "")
    if not authorization.startswith("AWS4-HMAC-SHA256 "):
        return False, "bad algorithm"
    fields: dict[str, str] = {}
    for part in authorization[len("AWS4-HMAC-SHA256 "):].split(","):
        name, _, value = part.strip().partition("=")
        fields[name] = value
    credential = fields.get("Credential", "")
    signed_headers = fields.get("SignedHeaders", "")
    signature = fields.get("Signature", "")
    amz_date = headers.get("x-amz-date", "")
    if "/" not in credential or not signed_headers or not signature:
        return False, "missing credential fields"
    # Credential is "<access-key>/<date>/<region>/<service>/aws4_request"; the
    # string-to-sign scope keeps the date, the signing key uses it separately.
    _, scope = credential.split("/", 1)
    date_stamp = scope.split("/", 1)[0]
    if not amz_date:
        return False, "missing x-amz-date"

    canonical_headers = ""
    for name in signed_headers.split(";"):
        value = headers.get(name)
        if value is None:
            return False, f"signed header {name} missing"
        canonical_headers += f"{name.lower()}:{value.strip()}\n"
    if "host" not in signed_headers.split(";"):
        return False, "host not signed"

    canonical_request = "\n".join([method, path, "", canonical_headers, signed_headers, payload_hash])
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    expected = hmac.new(_signing_key(SECRET_KEY, date_stamp), string_to_sign.encode("utf-8"),
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return False, "SignatureDoesNotMatch"
    return True, ""


class MockR2Handler(BaseHTTPRequestHandler):
    objects: dict[str, bytes] = {}
    lock = threading.Lock()

    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # silence the test log
        return

    def _handle(self, method: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        payload_hash = self.headers.get("x-amz-content-sha256", "")
        expected_hash = hashlib.sha256(body).hexdigest()
        if payload_hash != expected_hash:
            self._send(400, b"payload hash mismatch")
            return
        ok, reason = verify_signature(method, self.path, self.headers, payload_hash)
        if not ok:
            self._send(403, reason.encode())
            return
        # /<bucket>/<key>
        prefix = f"/{BUCKET}/"
        if not self.path.startswith(prefix):
            self._send(404, b"no bucket")
            return
        key = unquote(self.path[len(prefix):])
        with self.lock:
            if method == "PUT":
                type(self).objects[key] = body
                self._send(200, b"", extra={"ETag": '"' + hashlib.md5(body).hexdigest() + '"'})
            elif method == "HEAD":
                if key not in type(self).objects:
                    self._send(404, b"")
                    return
                self._send(200, b"", extra={"Content-Length": str(len(type(self).objects[key]))})
            elif method == "DELETE":
                if type(self).objects.pop(key, None) is None:
                    self._send(404, b"")
                    return
                self._send(204, b"")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("HEAD")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def _send(self, status: int, body: bytes, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        if "Content-Length" not in (extra or {}):
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)


class R2ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockR2Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host = f"127.0.0.1:{cls.port}"
        cls.temp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def make_client(self, secret: str = SECRET_KEY) -> r2.R2Client:
        return r2.R2Client("account", ACCESS_KEY, secret, BUCKET, host=self.host, secure=False)

    def make_file(self, name: str, data: bytes) -> Path:
        path = self.base / name
        path.write_bytes(data)
        return path

    def test_put_and_head_roundtrip(self) -> None:
        MockR2Handler.objects.clear()
        payload = b"hello r2" * 1000
        source = self.make_file("a.json", payload)
        client = self.make_client()

        client.put_file("spk/index.json", source, "application/json")
        self.assertEqual(MockR2Handler.objects["spk/index.json"], payload)
        self.assertEqual(client.head("spk/index.json"), len(payload))

    def test_missing_object_head_returns_none(self) -> None:
        MockR2Handler.objects.clear()
        self.assertIsNone(self.make_client().head("spk/nope.json"))

    def test_delete_removes_object(self) -> None:
        MockR2Handler.objects.clear()
        source = self.make_file("d.json", b"payload")
        client = self.make_client()
        client.put_file("spk/gone.json", source)
        self.assertTrue(client.delete("spk/gone.json"))
        self.assertFalse(client.delete("spk/gone.json"))
        self.assertIsNone(client.head("spk/gone.json"))

    def test_keys_are_url_encoded(self) -> None:
        MockR2Handler.objects.clear()
        source = self.make_file("weird.spk", b"payload")
        client = self.make_client()
        key = "spk/packages/中文 名称+test.spk"
        client.put_file(key, source)
        self.assertIn(key, MockR2Handler.objects)
        self.assertEqual(client.head(key), 7)

    def test_wrong_secret_is_rejected(self) -> None:
        MockR2Handler.objects.clear()
        source = self.make_file("b.json", b"{}")
        with self.assertRaises(r2.R2Error) as context:
            self.make_client(secret="wrong-secret").put_file("spk/index.json", source)
        self.assertIn("403", str(context.exception))

    def test_client_from_env_requires_credentials(self) -> None:
        with self.assertRaises(r2.R2Error):
            r2.R2Client("", "", "", "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
