#!/usr/bin/env python3
"""Upload locally built SPKs as "extra" packages (not tied to a GitHub release).

Use this while a package repository has not published an `sspks-index.json`
release bundle yet: the cron sync merges `spk/index.extra.json` with the release
packages, and prunes only what is in neither.

Usage:
    python tools/add-extra.py --packages /path/to/dist --bucket sspks
    python tools/add-extra.py --packages /path/to/dist --bucket sspks --dry-run
    python tools/add-extra.py --clear --bucket sspks        # remove all extras

After uploading, wait for the next cron tick (<=5 min) or call /sync manually.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import index as spk_index  # noqa: E402  (tools/index.py)

EXTRA_BUNDLE_NAME = 'index.extra.json'


def write_bundle(path: Path, bundle: dict, pretty: bool) -> None:
    path.write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2 if pretty else None) + '\n',
        encoding='utf-8',
        newline='\n',
    )


def build_plan_from_packages(packages_dir: Path, temp_dir: Path, prefix: str, defaults: dict,
                             pretty: bool) -> tuple[list[tuple[str, Path, str]], dict]:
    options = {
        'file_mask': '*.spk',
        'pretty': pretty,
        'base_url': '',
        'defaults': defaults,
        'embed_icons': True,
        'write_output': False,
    }
    index, report = spk_index.build_index(packages_dir, temp_dir, options)
    if report['ok'] == 0:
        raise SystemExit(f'no valid SPK found in {packages_dir}')
    bundle = spk_index.build_bundle(index, {
        'embedded_icons': options['embedded_icons'],
        'repo': '',
        'tag': '',
    })

    bundle_path = temp_dir / EXTRA_BUNDLE_NAME
    write_bundle(bundle_path, bundle, pretty)

    plan: list[tuple[str, Path, str]] = [(f'{prefix}/{EXTRA_BUNDLE_NAME}', bundle_path, 'application/json')]
    icons_dir = temp_dir / 'icons'
    icons_dir.mkdir(parents=True, exist_ok=True)
    for key, data in sorted(options['embedded_icons'].items()):
        icon_path = icons_dir / key.split('/', 1)[1]
        icon_path.write_bytes(data)
        plan.append((f'{prefix}/{key}', icon_path, 'image/png'))
    for record in index['packages']:
        plan.append((f"{prefix}/packages/{record['file']}", packages_dir / record['file'], 'application/octet-stream'))
    return plan, index


def build_clear_plan(temp_dir: Path, prefix: str, defaults: dict, pretty: bool) -> list[tuple[str, Path, str]]:
    bundle = {
        'schema': 2,
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'repo': None,
        'tag': None,
        'defaults': defaults,
        'packages': [],
        'icons': {},
    }
    bundle_path = temp_dir / EXTRA_BUNDLE_NAME
    write_bundle(bundle_path, bundle, pretty)
    return [(f'{prefix}/{EXTRA_BUNDLE_NAME}', bundle_path, 'application/json')]


def upload_plan(plan: list[tuple[str, Path, str]], backend: str, bucket: str | None,
                wrangler_cmd: str) -> int:
    if backend == 'wrangler':
        return spk_index.upload_with_wrangler(plan, bucket, False, wrangler_cmd, False)

    from r2 import client_from_env

    client = client_from_env(bucket)
    for key, path, content_type in plan:
        client.put_file(key, path, content_type)
        print(f'  PUT {key} ({path.stat().st_size} bytes)')
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Upload local SPKs as extra packages (merged by the cron sync).')
    parser.add_argument('--packages', type=Path, help='directory containing the .spk files')
    parser.add_argument('--clear', action='store_true', help='remove every extra package (next sync prunes them)')
    parser.add_argument('--bucket', default=None, help='R2 bucket (default: $R2_BUCKET)')
    parser.add_argument('--prefix', default='spk', help='object key prefix (default: spk)')
    parser.add_argument('--upload-backend', choices=['wrangler', 's3'], default='wrangler')
    parser.add_argument('--wrangler-cmd', default='npx wrangler')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--pretty', action='store_true')
    args = parser.parse_args(argv)

    if not args.clear and args.packages is None:
        print('--packages is required unless --clear is used', file=sys.stderr)
        return 2

    bucket = args.bucket or None
    prefix = args.prefix.strip('/')
    defaults = spk_index.load_config(None)['defaults']
    temp_dir = Path(tempfile.mkdtemp(prefix='sspks-extra-'))
    try:
        if args.clear:
            plan = build_clear_plan(temp_dir, prefix, defaults, args.pretty)
            print('clearing extra packages')
        else:
            packages_dir = args.packages.resolve()
            if not packages_dir.is_dir():
                print(f'packages directory not found: {packages_dir}', file=sys.stderr)
                return 2
            plan, index = build_plan_from_packages(packages_dir, temp_dir, prefix, defaults, args.pretty)
            print(f'extra packages: {", ".join(item["package"] + " " + item["version"] for item in index["packages"])}')

        total = sum(path.stat().st_size for _, path, _ in plan)
        print(f'upload plan: {len(plan)} objects, {total / 1024 / 1024:.1f} MiB -> {prefix}/')
        if args.dry_run:
            for key, path, _ in plan:
                print(f'  PUT {key} ({path.stat().st_size} bytes)')
            return 0

        result = upload_plan(plan, args.upload_backend, bucket, args.wrangler_cmd)
        if result != 0:
            return result
        print('done: extra bundle uploaded; the Worker merges it on the next sync (<=5 min) or via /sync')
        return 0
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
