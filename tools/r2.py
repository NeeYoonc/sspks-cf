#!/usr/bin/env python3
"""Minimal, dependency-free Cloudflare R2 (S3 compatible) client.

Only what the indexer needs: PUT an object, HEAD an object.  Requests are signed
with AWS Signature Version 4, region "auto", service "s3".

Credentials come from the environment:
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import mimetypes
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
CHUNK_SIZE = 1024 * 1024
CONTENT_TYPES = {
    ".json": "application/json",
    ".png": "image/png",
    ".spk": "application/octet-stream",
}


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def encode_key(key: str) -> str:
    """RFC 3986 encoding for the canonical URI / request path (keep `/`)."""
    return quote(key.lstrip("/"), safe="/~")


class R2Error(RuntimeError):
    pass


class R2Client:
    def __init__(self, account_id: str, access_key: str, secret_key: str, bucket: str,
                 host: str | None = None, secure: bool = True):
        if not all([account_id, access_key, secret_key, bucket]):
            raise R2Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required")
        self.account_id = account_id
        self.access_key = access_key
        self.secret_key = secret_key
        self.bucket = bucket
        self.secure = secure
        self.host = host or f"{account_id}.r2.cloudflarestorage.com"

    def _connection(self, timeout: int):
        if self.secure:
            return http.client.HTTPSConnection(self.host, timeout=timeout)
        hostname, _, port = self.host.partition(":")
        return http.client.HTTPConnection(hostname, int(port) if port else 80, timeout=timeout)

    # -- signing ---------------------------------------------------------
    def _signing_key(self, date_stamp: str) -> bytes:
        date_key = _hmac(("AWS4" + self.secret_key).encode("utf-8"), date_stamp)
        region_key = _hmac(date_key, "auto")
        service_key = _hmac(region_key, "s3")
        return _hmac(service_key, "aws4_request")

    def _authorization(self, method: str, canonical_uri: str, payload_hash: str,
                       amz_date: str, date_stamp: str) -> str:
        canonical_headers = (
            f"host:{self.host}\n"
            f"x-amz-content-sha256:{payload_hash}\n"
            f"x-amz-date:{amz_date}\n"
        )
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
        canonical_request = "\n".join([
            method,
            canonical_uri,
            "",  # canonical query string
            canonical_headers,
            signed_headers,
            payload_hash,
        ])
        # Kept for diagnostics: lets callers log exactly what was signed.
        self.last_canonical_request = canonical_request
        credential_scope = f"{date_stamp}/auto/s3/aws4_request"
        string_to_sign = "\n".join([
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ])
        self.last_string_to_sign = string_to_sign
        signature = hmac.new(
            self._signing_key(date_stamp), string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return (
            "AWS4-HMAC-SHA256 "
            f"Credential={self.access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )

    # -- operations ------------------------------------------------------
    def put_file(self, key: str, path: Path, content_type: str | None = None) -> None:
        size = path.stat().st_size
        payload_hash = hash_file(path)
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        canonical_uri = "/" + encode_key(f"{self.bucket}/{key}")
        authorization = self._authorization("PUT", canonical_uri, payload_hash, amz_date, date_stamp)

        connection = self._connection(300)
        try:
            connection.putrequest("PUT", canonical_uri, skip_host=True, skip_accept_encoding=True)
            connection.putheader("Host", self.host)
            connection.putheader("x-amz-content-sha256", payload_hash)
            connection.putheader("x-amz-date", amz_date)
            connection.putheader("Authorization", authorization)
            connection.putheader("Content-Type", content_type or _guess_content_type(path))
            connection.putheader("Content-Length", str(size))
            connection.endheaders()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
                    connection.send(chunk)
            response = connection.getresponse()
            body = response.read()
            if response.status not in (200, 201):
                raise R2Error(f"PUT {key} failed: HTTP {response.status} {body[:400]!r}")
        finally:
            connection.close()

    def head(self, key: str) -> int | None:
        """Return the object size in bytes, or None when it does not exist."""
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        canonical_uri = "/" + encode_key(f"{self.bucket}/{key}")
        authorization = self._authorization("HEAD", canonical_uri, EMPTY_SHA256, amz_date, date_stamp)

        connection = self._connection(60)
        try:
            connection.putrequest("HEAD", canonical_uri, skip_host=True, skip_accept_encoding=True)
            connection.putheader("Host", self.host)
            connection.putheader("x-amz-content-sha256", EMPTY_SHA256)
            connection.putheader("x-amz-date", amz_date)
            connection.putheader("Authorization", authorization)
            connection.endheaders()
            response = connection.getresponse()
            response.read()
            if response.status == 404:
                return None
            if response.status != 200:
                raise R2Error(f"HEAD {key} failed: HTTP {response.status}")
            length = response.getheader("Content-Length")
            return int(length) if length is not None else -1
        finally:
            connection.close()

    def delete(self, key: str) -> bool:
        """Delete an object; returns False when it did not exist."""
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        canonical_uri = "/" + encode_key(f"{self.bucket}/{key}")
        authorization = self._authorization("DELETE", canonical_uri, EMPTY_SHA256, amz_date, date_stamp)

        connection = self._connection(60)
        try:
            connection.putrequest("DELETE", canonical_uri, skip_host=True, skip_accept_encoding=True)
            connection.putheader("Host", self.host)
            connection.putheader("x-amz-content-sha256", EMPTY_SHA256)
            connection.putheader("x-amz-date", amz_date)
            connection.putheader("Authorization", authorization)
            connection.putheader("Content-Length", "0")
            connection.endheaders()
            response = connection.getresponse()
            response.read()
            if response.status in (200, 204):
                return True
            if response.status == 404:
                return False
            raise R2Error(f"DELETE {key} failed: HTTP {response.status}")
        finally:
            connection.close()


def _guess_content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in CONTENT_TYPES:
        return CONTENT_TYPES[suffix]
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def client_from_env(bucket: str | None = None) -> R2Client:
    """Build a client from the documented R2_* environment variables.

    R2_ENDPOINT is an escape hatch for S3-compatible test servers (and MinIO);
    normal R2 usage only needs the account id + token + bucket.
    """
    endpoint = os.environ.get("R2_ENDPOINT", "").strip()
    host = None
    secure = True
    if endpoint:
        from urllib.parse import urlsplit

        parsed = urlsplit(endpoint if "://" in endpoint else f"http://{endpoint}")
        host = parsed.netloc
        secure = parsed.scheme == "https"
    return R2Client(
        account_id=os.environ.get("R2_ACCOUNT_ID", "").strip(),
        access_key=os.environ.get("R2_ACCESS_KEY_ID", "").strip(),
        secret_key=os.environ.get("R2_SECRET_ACCESS_KEY", "").strip(),
        bucket=(bucket or os.environ.get("R2_BUCKET", "")).strip(),
        host=host,
        secure=secure,
    )


if __name__ == "__main__":  # tiny smoke helper: python tools/r2.py head <key>
    entry = client_from_env()
    target = sys.argv[2] if len(sys.argv) > 2 else "spk/index.json"
    print(entry.head(target))
