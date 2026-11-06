// Tests for the bundle-less auto indexer: tar parsing from R2 ranges, GitHub
// release discovery without the REST API, and the sync fallback path.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildRecord,
  discoverRelease,
  ensureDefaultIcons,
  md5FromEtag,
  parseInfo,
  readSpkParts,
  readSpkPartsFromBytes,
} from '../src/autoindex.js';
import { latestAssetUrl, syncFromGithub } from '../src/sync.js';
import { MockBucket } from './mock_env.mjs';

const REPO = 'NeeYoonc/example-pkg';
const TAG = 'v9.9.9';
const PKG_X86 = 'Example_x86_64-9.9.9.spk';
const PKG_ARM = 'Example_armv8-9.9.9.spk';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// ---------------------------------------------------------------------------
// Tiny tar writer (ustar) used to build SPK fixtures
// ---------------------------------------------------------------------------

function tarHeader(name, size, type = '0') {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(encoder.encode('0000644\0'), 100);
  header.set(encoder.encode('0000000\0'), 108);
  header.set(encoder.encode('0000000\0'), 116);
  header.set(encoder.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  header.set(encoder.encode('00000000000\0'), 136);
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode('ustar\0'), 257);
  header.set(encoder.encode('00'), 263);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return header;
}

function makeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = entry.data === undefined ? new Uint8Array(0)
      : (typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data);
    chunks.push(tarHeader(entry.name, data.byteLength, entry.type || '0'));
    if (data.byteLength > 0) {
      chunks.push(data);
      const pad = (512 - (data.byteLength % 512)) % 512;
      if (pad > 0) chunks.push(new Uint8Array(pad));
    }
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function infoText(overrides = {}) {
  const fields = {
    package: 'example-pkg',
    version: '9.9.9',
    description: 'An example package',
    arch: 'x86_64',
    maintainer: 'NeeYoonc',
    os_min_ver: '7.0-40851',
    displayname: 'Example Pkg',
    changelog: 'first release',
    ...overrides,
  };
  return Object.entries(fields).map(([key, value]) => `${key}="${value}"`).join('\n');
}

function makeSpk({ arch = 'x86_64', info = {}, withIcons = true, withWizard = true, privilege = '{"defaults":{"run-as":"root"}}' } = {}) {
  const entries = [
    { name: 'INFO', data: infoText({ arch, ...info }) },
    { name: 'package.tgz', data: new Uint8Array(1500).fill(7) },
  ];
  if (withIcons) {
    entries.push({ name: 'PACKAGE_ICON.PNG', data: PNG });
    entries.push({ name: 'PACKAGE_ICON_256.PNG', data: PNG });
  }
  if (withWizard) entries.push({ name: 'WIZARD_UIFILES/', type: '5' });
  if (privilege !== null) entries.push({ name: 'conf/privilege', data: privilege });
  entries.push({ name: 'screen_1.png', data: PNG });
  return makeTar(entries);
}

const X86_TAR = makeSpk({ arch: 'x86_64' });
const ARM_TAR = makeSpk({ arch: 'armv8' });

const md5 = (bytes) => createHash('md5').update(Buffer.from(bytes)).digest('hex');

// ---------------------------------------------------------------------------
// Fetch mock for github.com HTML endpoints + release assets
// ---------------------------------------------------------------------------

let restoreFetch = null;
afterEach(() => {
  if (restoreFetch) {
    globalThis.fetch = restoreFetch;
    restoreFetch = null;
  }
});

function installGithub({ tag = TAG, files = { [PKG_X86]: X86_TAR, [PKG_ARM]: ARM_TAR } } = {}) {
  const original = globalThis.fetch;
  restoreFetch = original;
  const html = Object.keys(files)
    .map((file) => `<a href="/${REPO}/releases/download/${tag}/${file}">${file}</a>`)
    .join('\n');
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || 'GET').toUpperCase();
    if (url === `https://github.com/${REPO}/releases/latest`) {
      return new Response(null, { status: 302, headers: { location: `https://github.com/${REPO}/releases/tag/${tag}` } });
    }
    if (url === `https://github.com/${REPO}/releases/expanded_assets/${tag}`) {
      return new Response(html, { status: 200 });
    }
    for (const [file, bytes] of Object.entries(files)) {
      const assetUrl = `https://github.com/${REPO}/releases/download/${tag}/${file}`;
      if (url === assetUrl || url === latestAssetUrl(REPO, file)) {
        if (method === 'HEAD') {
          return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
        }
        return new Response(bytes, { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test('parseInfo decodes quoted values, escapes and localized keys', () => {
  const info = parseInfo(new TextEncoder().encode([
    'package="example-pkg"',
    'description="line one\\nline two"',
    'displayname_deu="Beispiel"',
    '  # comment',
    'os_min_ver="7.0-40851"',
  ].join('\n')));
  assert.equal(info.package, 'example-pkg');
  assert.equal(info.description, 'line one\nline two');
  assert.equal(info.displayname_deu, 'Beispiel');
  assert.equal(info.os_min_ver, '7.0-40851');
});

test('md5FromEtag accepts plain MD5 ETags only', () => {
  assert.equal(md5FromEtag('"cafc3b9a79a577f6d58ffc6efdcbb9ed"'), 'cafc3b9a79a577f6d58ffc6efdcbb9ed');
  assert.equal(md5FromEtag('cafc3b9a79a577f6d58ffc6efdcbb9ed'), 'cafc3b9a79a577f6d58ffc6efdcbb9ed');
  assert.equal(md5FromEtag('"abc-2"'), null);
  assert.equal(md5FromEtag(''), null);
});

test('discoverRelease resolves the tag via redirect and lists .spk assets', async () => {
  installGithub();
  const result = await discoverRelease({}, REPO);
  assert.equal(result.tag, TAG);
  assert.deepEqual(result.files, [PKG_ARM, PKG_X86].sort());
});

test('readSpkPartsFromBytes parses an in-memory SPK', () => {
  const parts = readSpkPartsFromBytes(X86_TAR);
  const info = parseInfo(parts.info);
  assert.equal(info.package, 'example-pkg');
  assert.equal(info.arch, 'x86_64');
  assert.deepEqual(parts.icons[72], PNG);
  assert.deepEqual(parts.icons[120], PNG);
  assert.equal(parts.wizard, true);
  assert.ok(parts.privilege instanceof Uint8Array);
});

test('readSpkParts + buildRecord parse an SPK straight from R2 ranges', async () => {
  const bucket = new MockBucket();
  const key = `spk/packages/${PKG_X86}`;
  bucket.put(key, X86_TAR);
  const head = await bucket.head(key);

  const parts = await readSpkParts({ BUCKET: bucket }, key);
  const record = await buildRecord({ BUCKET: bucket }, {
    file: PKG_X86,
    parts,
    size: head.size,
    md5: md5(X86_TAR),
  });

  assert.equal(record.package, 'example-pkg');
  assert.equal(record.version, '9.9.9');
  assert.deepEqual(record.arch, ['x86_64']);
  assert.equal(record.os_min_ver, '7.0-40851');
  assert.equal(record.filesize, X86_TAR.byteLength);
  assert.equal(record.md5, md5(X86_TAR));
  assert.equal(record.run_as_root, true);
  assert.equal(record.qinst, false, 'a package with WIZARD_UIFILES needs the wizard');
  assert.equal(record.thumbnail.length, 2);
  assert.deepEqual(record.snapshot, ['icons/Example_x86_64-9.9.9_screen_1.png']);
  assert.ok(bucket.objects.has('spk/icons/Example_x86_64-9.9.9_thumb_72.png'));
  assert.ok(bucket.objects.has('spk/icons/Example_x86_64-9.9.9_thumb_120.png'));
});

test('records without an SPK icon fall back to the default icons', async () => {
  const bucket = new MockBucket();
  const key = 'spk/packages/NoIcon_x86_64-1.0-1.spk';
  const tar = makeSpk({ withIcons: false });
  bucket.put(key, tar);
  const parts = await readSpkParts({ BUCKET: bucket }, key);
  const record = await buildRecord({ BUCKET: bucket }, { file: 'NoIcon_x86_64-1.0-1.spk', parts, size: tar.byteLength, md5: md5(tar) });
  assert.deepEqual(record.thumbnail, ['icons/_default_72.png', 'icons/_default_120.png']);
  await ensureDefaultIcons({ BUCKET: bucket });
  assert.ok(bucket.objects.has('spk/icons/_default_72.png'));
  assert.ok(bucket.objects.has('spk/icons/_default_120.png'));
});

// ---------------------------------------------------------------------------
// Sync integration (no bundle → auto index)
// ---------------------------------------------------------------------------

test('a repository without a bundle is indexed automatically', async () => {
  installGithub();
  const bucket = new MockBucket();
  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPOS: REPO });

  assert.equal(summary.status, 'synced');
  assert.equal(summary.sources[0].status, 'auto');
  assert.equal(summary.sources[0].tag, TAG);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.deepEqual(
    [...new Set(index.packages.map((item) => item.package))],
    ['example-pkg'],
  );
  const x86 = index.packages.find((item) => item.file === PKG_X86);
  assert.equal(x86.md5, md5(X86_TAR));
  assert.equal(x86.source, REPO);
  assert.equal(x86.filesize, X86_TAR.byteLength);
  assert.ok(bucket.objects.has(`spk/packages/${PKG_ARM}`));
  assert.ok(bucket.objects.has('spk/icons/Example_x86_64-9.9.9_thumb_72.png'));

  // Marker records the auto signature, so the next tick is a no-op.
  const marker = await (await bucket.get('spk/.synced-release')).text();
  assert.match(marker, /@auto\(/);
  const second = await syncFromGithub({ BUCKET: bucket, DSH_REPOS: REPO });
  assert.equal(second.status, 'up-to-date');
});

test('a repository whose release has no .spk still fails clearly', async () => {
  installGithub({ files: {} });
  await assert.rejects(
    () => syncFromGithub({ BUCKET: new MockBucket(), DSH_REPOS: REPO }),
    /no source published sspks-index\.json/,
  );
});
