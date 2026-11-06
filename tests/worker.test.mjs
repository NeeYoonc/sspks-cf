// End-to-end tests for the Worker: a real index built by tools/index.py is
// loaded into an in-memory R2 mock, then requests are made exactly the way DSM 7
// Package Center and a browser would.
//
// Run: node --test tests/

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/worker.js';
import { MockBucket, MockCache, MockDB } from './mock_env.mjs';
import { resetCountsCache } from '../src/stats.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ORIGIN = 'https://spk.example.com';

let workdir;
let fixture; // { index, packages: Map<name, Uint8Array>, icons: Map<name, Uint8Array> }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBucket() {
  const bucket = new MockBucket();
  bucket.put('spk/index.json', new TextEncoder().encode(JSON.stringify(fixture.index)), 'application/json');
  for (const [name, bytes] of fixture.icons) bucket.put(`spk/icons/${name}`, bytes, 'image/png');
  for (const [name, bytes] of fixture.packages) bucket.put(`spk/packages/${name}`, bytes, 'application/octet-stream');
  return bucket;
}

function makeEnv(overrides = {}) {
  return { BUCKET: makeBucket(), BASE_URL: `${ORIGIN}/`, ...overrides };
}

async function request(env, pathname, init = {}) {
  return worker.fetch(new Request(ORIGIN + pathname, init), env);
}

/**
 * Build a realistic DSM 7 Package Center query string. The `unique` value is
 * encoded like the real client does (`+` → %2B).
 */
function packageCenterQuery(overrides = {}) {
  const params = new URLSearchParams({
    unique: 'synology_apollolake_ds918+',
    arch: 'apollolake',
    major: '7',
    minor: '2',
    build: '69057',
    package_update_channel: 'stable',
    language: 'chs',
    ...overrides,
  });
  return `/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Fixtures: run the Python indexer once
// ---------------------------------------------------------------------------

before(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'sspks-cf-worker-'));
  const result = spawnSync(PYTHON, [path.join(ROOT, 'tests', 'build_worker_fixtures.py'), workdir], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`fixture build failed:\n${result.stdout}\n${result.stderr}`);
  }

  const dist = path.join(workdir, 'dist');
  const packagesDir = path.join(workdir, 'packages');
  const icons = new Map();
  for (const name of readdirSync(path.join(dist, 'icons'))) {
    icons.set(name, new Uint8Array(readFileSync(path.join(dist, 'icons', name))));
  }
  const packages = new Map();
  for (const name of readdirSync(packagesDir)) {
    if (name.endsWith('.spk')) packages.set(name, new Uint8Array(readFileSync(path.join(packagesDir, name))));
  }
  fixture = { index: JSON.parse(readFileSync(path.join(dist, 'index.json'), 'utf8')), icons, packages };
});

after(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

const sha256 = async (bytes) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------------------
// Package Center contract
// ---------------------------------------------------------------------------

test('Package Center response matches the DSM 7 contract', async () => {
  const response = await request(makeEnv(), packageCenterQuery());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');

  const body = await response.json();
  assert.deepEqual(body.packages.map((item) => item.package), ['ModelPkg', 'NoarchPkg', 'PlainPkg']);
  const byName = new Map(body.packages.map((item) => [item.package, item]));

  const plain = byName.get('PlainPkg');
  assert.deepEqual(Object.keys(plain).sort(), [
    'auto_upgrade_from', 'category', 'changelog', 'conflictpkgs', 'depsers', 'deppkgs', 'desc',
    'distributor', 'distributor_url', 'dname', 'download_count', 'link', 'maintainer',
    'maintainer_url', 'md5', 'package', 'price', 'qinst', 'qstart', 'qupgrade',
    'recent_download_count', 'silent_install', 'silent_uninstall', 'silent_upgrade', 'size',
    'snapshot', 'start', 'subcategory', 'support_url', 'thirdparty', 'thumbnail', 'type', 'version',
  ].sort());
  assert.equal('beta' in plain, false, 'DSM 7 responses must not contain the beta field');

  assert.equal(plain.package, 'PlainPkg');
  assert.equal(plain.version, '1.0.0-1');
  assert.equal(plain.dname, 'Plain Package');
  assert.equal(plain.desc, 'A plain DSM 7 package');
  // Download links carry ?v=<md5 prefix> so a rebuilt asset invalidates edge caches.
  const plainMd5 = fixture.index.packages.find((item) => item.package === 'PlainPkg').md5;
  assert.equal(plain.link, `${ORIGIN}/packages/Plain-1.0.0-1.spk?v=${plainMd5.slice(0, 12)}`);
  assert.equal(plain.price, 0);
  assert.equal(plain.download_count, 0);
  assert.equal(plain.recent_download_count, 0);
  assert.equal(plain.size, fixture.packages.get('Plain-1.0.0-1.spk').byteLength);
  assert.equal(plain.md5, fixture.index.packages.find((item) => item.package === 'PlainPkg').md5);
  assert.deepEqual(plain.thumbnail, [
    `${ORIGIN}/icons/Plain-1.0.0-1_thumb_72.png`,
    `${ORIGIN}/icons/Plain-1.0.0-1_thumb_120.png`,
  ]);
  assert.deepEqual(plain.snapshot, [
    `${ORIGIN}/icons/Plain-1.0.0-1_screen_1.png`,
    `${ORIGIN}/icons/Plain-1.0.0-1_screen_2.png`,
  ]);
  assert.equal(plain.qinst, false, 'WIZARD_UIFILES must disable quick install');
  assert.equal(plain.qstart, false);
  assert.equal(plain.qupgrade, false);
  assert.equal(plain.start, true);
  assert.equal(plain.thirdparty, true);
  assert.equal(plain.category, 0);
  assert.equal(plain.subcategory, 0);
  assert.equal(plain.type, 0);
  assert.equal(plain.silent_install, false);
  assert.equal(plain.auto_upgrade_from, null);
  assert.equal(plain.depsers, null);
  assert.equal(plain.deppkgs, null);
  assert.equal(plain.conflictpkgs, null);
  assert.equal(plain.maintainer, 'Test Maintainer');
  assert.equal(plain.maintainer_url, 'https://example.com/maintainer');
  assert.equal(plain.distributor, 'Community Repository');

  // Fallback icon: the GZ fixture ships no icons.
  const gz = fixture.index.packages.find((item) => item.package === 'GzPkg');
  assert.deepEqual(gz.thumbnail, ['icons/_default_72.png', 'icons/_default_120.png']);
});

test('beta channel is only visible when requested', async () => {
  const stable = await (await request(makeEnv(), packageCenterQuery())).json();
  assert.equal(stable.packages.some((item) => item.package === 'GzPkg'), false);

  const beta = await (await request(makeEnv(), packageCenterQuery({ package_update_channel: 'beta' }))).json();
  const gz = beta.packages.find((item) => item.package === 'GzPkg');
  assert.ok(gz, 'beta package missing from beta channel');
  assert.equal(gz.dname, '压缩包');
  assert.equal(gz.desc, '中文描述');
});

test('language falls back to the default metadata', async () => {
  const body = await (await request(makeEnv(), packageCenterQuery({
    package_update_channel: 'beta',
    language: 'enu',
  }))).json();
  const gz = body.packages.find((item) => item.package === 'GzPkg');
  assert.equal(gz.dname, 'GZ Package');
  assert.equal(gz.desc, 'Line one\nLine two');
});

test('firmware build and os_max_ver are honoured', async () => {
  const older = await (await request(makeEnv(), packageCenterQuery({ minor: '1', build: '42962' }))).json();
  assert.deepEqual(older.packages.map((item) => item.package), ['ModelPkg', 'NoarchPkg']);

  const tooNew = await (await request(makeEnv(), packageCenterQuery({
    package_update_channel: 'beta',
    build: '72807',
  }))).json();
  assert.equal(tooNew.packages.some((item) => item.package === 'GzPkg'), false,
    'os_max_ver 7.2.2-72806 must not match build 72807');

  const exact = await (await request(makeEnv(), packageCenterQuery({
    package_update_channel: 'beta',
    build: '72806',
  }))).json();
  assert.ok(exact.packages.some((item) => item.package === 'GzPkg'));
});

test('model include/exclude lists use the synology_<arch>_<model> identifier', async () => {
  const included = await (await request(makeEnv(), packageCenterQuery({
    unique: 'synology_apollolake_ds918+',
  }))).json();
  assert.ok(included.packages.some((item) => item.package === 'ModelPkg'));

  const excluded = await (await request(makeEnv(), packageCenterQuery({
    unique: 'synology_apollolake_ds423+',
  }))).json();
  assert.equal(excluded.packages.some((item) => item.package === 'ModelPkg'), false);
  assert.deepEqual(excluded.packages.map((item) => item.package), ['NoarchPkg', 'PlainPkg']);
});

test('unique with a literal plus sign is restored after form decoding', async () => {
  // `+` in the query string decodes to a space; the handler must restore it.
  const response = await request(
    makeEnv(),
    '/?unique=synology_apollolake_ds918+&arch=apollolake&major=7&minor=2&build=69057'
      + '&package_update_channel=stable&language=chs',
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.packages.some((item) => item.package === 'ModelPkg'));
});

test('invalid Package Center requests are rejected with 400', async () => {
  const cases = [
    ['empty unique', '/?unique=&arch=apollolake&major=7&minor=2&build=69057'],
    ['non-synology unique', packageCenterQuery({ unique: 'foo' })],
    ['unknown architecture', packageCenterQuery({ arch: 'foo', unique: 'synology_foo_ds918+' })],
    ['DSM 6 client', packageCenterQuery({ major: '6' })],
    ['minor too long', packageCenterQuery({ minor: '1234' })],
    ['build out of range', packageCenterQuery({ build: '2147483648' })],
    ['unsupported channel', packageCenterQuery({ package_update_channel: 'nightly' })],
    ['bad language', packageCenterQuery({ language: 'zh' })],
    ['unique arch mismatch', packageCenterQuery({ unique: 'synology_x86_64_ds918+' })],
  ];
  const env = makeEnv();
  for (const [label, pathname] of cases) {
    const response = await request(env, pathname);
    assert.equal(response.status, 400, label);
    assert.deepEqual(await response.json(), { error: 'Invalid Package Center request' }, label);
    assert.equal(response.headers.get('cache-control'), 'no-store', label);
  }
});

test('SPK_BASE_URL moves only download links to the R2 domain', async () => {
  const env = makeEnv({ SPK_BASE_URL: 'https://dl.dnof.net' });
  const body = await (await request(env, packageCenterQuery())).json();
  const plain = body.packages.find((item) => item.package === 'PlainPkg');
  const md5 = fixture.index.packages.find((item) => item.package === 'PlainPkg').md5;
  assert.equal(plain.link, `https://dl.dnof.net/packages/Plain-1.0.0-1.spk?v=${md5.slice(0, 12)}`);
  // icons still come from the Worker origin
  assert.ok(plain.thumbnail[0].startsWith(`${ORIGIN}/icons/`));
});

test('base_url can be pinned via env and defaults to the request origin', async () => {
  const pinned = await (await request(makeEnv({ BASE_URL: 'https://cdn.example.net/spk/' }), packageCenterQuery())).json();
  const pinnedMd5 = fixture.index.packages.find((item) => item.package === 'PlainPkg').md5;
  assert.equal(
    pinned.packages.find((item) => item.package === 'PlainPkg').link,
    `https://cdn.example.net/spk/packages/Plain-1.0.0-1.spk?v=${pinnedMd5.slice(0, 12)}`,
  );

  const env = makeEnv();
  delete env.BASE_URL;
  const dynamic = await worker.fetch(new Request('https://nas.example.org/?'
    + new URLSearchParams({
      unique: 'synology_apollolake_ds918+', arch: 'apollolake', major: '7', minor: '2',
      build: '69057', package_update_channel: 'stable', language: 'chs',
    }).toString()), env);
  const body = await dynamic.json();
  assert.equal(
    body.packages.find((item) => item.package === 'PlainPkg').link,
    `https://nas.example.org/packages/Plain-1.0.0-1.spk?v=${pinnedMd5.slice(0, 12)}`,
  );
});

// ---------------------------------------------------------------------------
// SPK downloads
// ---------------------------------------------------------------------------

test('SPK downloads stream from R2 with the expected headers', async () => {
  const env = makeEnv();
  const bytes = fixture.packages.get('Plain-1.0.0-1.spk');
  const response = await request(env, '/packages/Plain-1.0.0-1.spk');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=2592000, immutable');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="Plain-1\.0\.0-1\.spk"/);
  assert.equal(await sha256(new Uint8Array(await response.arrayBuffer())), await sha256(bytes));
});

test('legacy .spk.bin links still resolve', async () => {
  const response = await request(makeEnv(), '/packages/Plain-1.0.0-1.spk.bin');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /filename="Plain-1\.0\.0-1\.spk"/);
});

test('SPK downloads are edge-cached with a plain .spk URL', async () => {
  const env = makeEnv();
  env.CACHE = new MockCache();
  const path = '/packages/Plain-1.0.0-1.spk?v=cafc3b9a79a5';

  const first = await request(env, path);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  const firstBytes = new Uint8Array(await first.arrayBuffer());

  const second = await request(env, path);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), firstBytes);

  // Query string is part of the cache key (?v=md5 busts stale entries).
  const other = await request(env, '/packages/Plain-1.0.0-1.spk?v=000000000000');
  assert.equal(other.headers.get('x-cache'), 'MISS');

  // Range requests bypass the cache (resume keeps working).
  const ranged = await request(env, path, { headers: { Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('x-cache'), null);
});

test('HEAD returns metadata without a body', async () => {
  const response = await request(makeEnv(), '/packages/Plain-1.0.0-1.spk', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(fixture.packages.get('Plain-1.0.0-1.spk').byteLength));
  assert.equal(await response.text(), '');
});

test('single byte ranges are supported', async () => {
  const bytes = fixture.packages.get('Plain-1.0.0-1.spk');
  const response = await request(makeEnv(), '/packages/Plain-1.0.0-1.spk', {
    headers: { Range: 'bytes=0-9' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-9/${bytes.byteLength}`);
  assert.equal(response.headers.get('content-length'), '10');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.subarray(0, 10));

  const suffix = await request(makeEnv(), '/packages/Plain-1.0.0-1.spk', { headers: { Range: 'bytes=-5' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 5));

  const invalid = await request(makeEnv(), '/packages/Plain-1.0.0-1.spk', { headers: { Range: 'bytes=-0' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.byteLength}`);
});

test('ETag revalidation returns 304', async () => {
  const env = makeEnv();
  const first = await request(env, '/packages/Plain-1.0.0-1.spk');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await request(env, '/packages/Plain-1.0.0-1.spk', { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
});

test('unknown and unsafe package paths are rejected', async () => {
  const env = makeEnv();
  for (const pathname of [
    '/packages/Missing-1.0-1.spk',
    '/packages/..%2F..%2Fetc%2Fpasswd',
    '/packages/Plain-1.0.0-1.spk/extra',
    '/packages/notes.txt',
  ]) {
    const response = await request(env, pathname);
    assert.equal(response.status, 404, pathname);
  }
});

// ---------------------------------------------------------------------------
// Icons, landing page, health
// ---------------------------------------------------------------------------

test('downloads are counted and surfaced in the Package Center response', async () => {
  resetCountsCache();
  const env = makeEnv();
  env.DB = new MockDB();

  const download = await request(env, '/packages/Plain-1.0.0-1.spk?v=counter-test');
  assert.equal(download.status, 200);
  await download.arrayBuffer();

  const body = await (await request(env, packageCenterQuery())).json();
  const plain = body.packages.find((item) => item.package === 'PlainPkg');
  assert.equal(plain.download_count, 1);
  assert.equal(plain.recent_download_count, 1);
  const model = body.packages.find((item) => item.package === 'ModelPkg');
  assert.equal(model.download_count, 0, 'uncounted packages keep the default');
});

test('icons are served from R2 and cached in memory', async () => {
  const env = makeEnv();
  const bytes = fixture.icons.get('Plain-1.0.0-1_thumb_72.png');
  const response = await request(env, '/icons/Plain-1.0.0-1_thumb_72.png');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);

  // Drop the object: the second request must still be served from the isolate cache.
  env.BUCKET.delete('spk/icons/Plain-1.0.0-1_thumb_72.png');
  const cached = await request(env, '/icons/Plain-1.0.0-1_thumb_72.png');
  assert.equal(cached.status, 200);
  assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), bytes);
});

test('missing icons return 404', async () => {
  const response = await request(makeEnv(), '/icons/nope.png');
  assert.equal(response.status, 404);
});

test('landing page lists packages and the source URL', async () => {
  const response = await request(makeEnv(), '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Plain Package/);
  assert.match(html, /共 4 个套件/);
  assert.match(html, /https:\/\/spk\.example\.com\//);
  assert.match(html, /Plain-1\.0\.0-1\.spk/);
  // Search box: each card carries a lowercase haystack for client-side filtering.
  assert.match(html, /id="q"/);
  assert.match(html, /data-search="[^"]*plain-1\.0\.0-1\.spk/i);
  assert.match(html, /没有匹配的套件/);
});

test('health reports the index state', async () => {
  const response = await request(makeEnv(), '/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.packages, 4);
  assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('missing index is reported without crashing', async () => {
  const env = { BUCKET: new MockBucket() };
  const packageCenter = await request(env, packageCenterQuery());
  assert.equal(packageCenter.status, 503);
  assert.equal(await packageCenter.text(), '{"packages":[]}');

  const landing = await request(env, '/');
  assert.equal(landing.status, 503);
  assert.match(await landing.text(), /索引尚未上传/);

  const health = await request(env, '/health');
  assert.equal(health.status, 503);
});

test('misc routes and methods', async () => {
  const env = makeEnv();
  assert.equal((await request(env, '/robots.txt')).status, 200);
  assert.equal((await request(env, '/favicon.ico')).status, 204);
  assert.equal((await request(env, '/nope')).status, 404);

  const post = await request(env, '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('index is cached per isolate for five minutes', async () => {
  const env = makeEnv();
  const first = await (await request(env, packageCenterQuery())).json();
  assert.equal(first.packages.length, 3);

  env.BUCKET.put('spk/index.json', new TextEncoder().encode(JSON.stringify({ ...fixture.index, packages: [] })), 'application/json');
  const cached = await (await request(env, packageCenterQuery())).json();
  assert.equal(cached.packages.length, 3, 'index must be served from the isolate cache');

  const health = await (await request(env, '/health')).json();
  assert.equal(health.packages, 0, 'health forces a fresh read');
});
