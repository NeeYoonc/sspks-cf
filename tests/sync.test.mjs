// Tests for the scheduled GitHub → R2 sync and the Worker endpoints around it.
//
// Run: node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import worker from '../src/worker.js';
import { syncFromGithub, latestAssetUrl, EXTRA_INDEX_KEY, MARKER_KEY } from '../src/sync.js';
import { MockBucket } from './mock_env.mjs';

const REPO = 'NeeYoonc/dsh-nas';
const TAG = 'dsh-v0.2.3';
const PKG_X86 = 'DeepSeekHarness-NAS_x86_64-0.2.3.spk';
const PKG_ARM = 'DeepSeekHarness-NAS_armv8-0.2.3.spk';
const ICON_KEY = 'icons/Pkg_thumb_72.png';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const X86_BYTES = new TextEncoder().encode('x86-spk');
const ARM_BYTES = new TextEncoder().encode('arm-spk');

function makeBundle(overrides = {}) {
  return {
    schema: 2,
    generated_at: '2026-11-05T00:00:00Z',
    repo: REPO,
    tag: TAG,
    defaults: { download_count: 0, maintainer: 'NeeYoonc' },
    packages: [
      {
        file: PKG_X86,
        package: 'DeepSeekHarness-NAS',
        version: '0.2.3',
        displayname: 'DeepSeek Harness NAS',
        description: 'x86 build',
        os_min_ver: '7.0-40851',
        os_max_ver: '',
        arch: ['x86_64'],
        exclude_arch: [],
        model: [],
        exclude_model: [],
        beta: false,
        thumbnail: [ICON_KEY, ICON_KEY],
        snapshot: [],
        filesize: X86_BYTES.byteLength,
        md5: 'md5-x86',
      },
      {
        file: PKG_ARM,
        package: 'DeepSeekHarness-NAS',
        version: '0.2.3',
        displayname: 'DeepSeek Harness NAS',
        description: 'arm build',
        os_min_ver: '7.0-40851',
        os_max_ver: '',
        arch: ['armv8'],
        exclude_arch: [],
        model: [],
        exclude_model: [],
        beta: false,
        thumbnail: [],
        snapshot: [],
        filesize: ARM_BYTES.byteLength,
        md5: 'md5-arm',
      },
    ],
    icons: { [ICON_KEY]: Buffer.from(PNG).toString('base64') },
    ...overrides,
  };
}

const BUNDLE_URL = latestAssetUrl(REPO, 'sspks-index.json');
const X86_URL = latestAssetUrl(REPO, PKG_X86);
const ARM_URL = latestAssetUrl(REPO, PKG_ARM);

let restoreFetch = null;

/**
 * Mock github.com/releases/latest/download/*:
 *   GET bundle → JSON; HEAD spk → size; GET spk → bytes; unknown → 404.
 */
function installFetch({ bundle = makeBundle(), bundles = {}, files = {}, missing = [], fail = null } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  const payloads = { [X86_URL]: X86_BYTES, [ARM_URL]: ARM_BYTES, ...files };
  const bundlePayloads = { [BUNDLE_URL]: bundle, ...bundles };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || 'GET').toUpperCase();
    calls.push(`${method} ${url}`);

    if (Object.prototype.hasOwnProperty.call(bundlePayloads, url)) {
      if (fail) return new Response('boom', { status: fail });
      return new Response(JSON.stringify(bundlePayloads[url]), { status: 200 });
    }
    if (missing.includes(url)) return new Response('not found', { status: 404 });

    const bytes = payloads[url];
    if (bytes === undefined) return new Response('not found', { status: 404 });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    }
    return new Response(new Blob([bytes]).stream(), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    });
  };
  restoreFetch = () => { globalThis.fetch = original; };
  return calls;
}

afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

// ---------------------------------------------------------------------------
// syncFromGithub
// ---------------------------------------------------------------------------

test('first sync mirrors packages, icons, index and marker into R2', async () => {
  installFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, DSH_REPO: REPO };

  const summary = await syncFromGithub(env);

  assert.equal(summary.status, 'synced');
  assert.equal(summary.tag, TAG);
  assert.equal(summary.uploaded, 3); // 1 icon + 2 SPK blobs
  assert.equal(summary.skipped, 0);
  assert.deepEqual(summary.missing, []);

  assert.ok(bucket.objects.has(`spk/packages/${PKG_X86}`));
  assert.ok(bucket.objects.has(`spk/packages/${PKG_ARM}`));
  assert.ok(bucket.objects.has(`spk/${ICON_KEY}`));
  assert.ok(bucket.objects.has('spk/index.json'));
  assert.equal(await (await bucket.get(MARKER_KEY)).text(), `${REPO}@${TAG}|none`);

  assert.deepEqual(bucket.objects.get(`spk/${ICON_KEY}`).bytes, PNG);
  assert.deepEqual(bucket.objects.get(`spk/packages/${PKG_X86}`).bytes, X86_BYTES);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.tag, TAG);
  assert.equal(index.repo, REPO);
  assert.equal(index.packages.length, 2);
  assert.equal(index.packages[0].md5, 'md5-x86');

  // Observable state for /health and for proving the cron ran.
  const lastSync = JSON.parse(await (await bucket.get('spk/.last-sync')).text());
  assert.equal(lastSync.status, 'synced');
  assert.equal(lastSync.tag, TAG);
  assert.equal(lastSync.trigger, 'cron');
  assert.match(lastSync.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('no GitHub REST API is used (avoids the 60 req/h limit)', async () => {
  const calls = installFetch();
  await syncFromGithub({ BUCKET: new MockBucket(), DSH_REPO: REPO });
  assert.equal(calls.some((call) => call.includes('api.github.com')), false);
  assert.ok(calls.every((call) => call.includes('/releases/latest/download/')));
});

test('second sync is a no-op once the marker matches', async () => {
  let calls = installFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, DSH_REPO: REPO };
  await syncFromGithub(env);

  calls = installFetch();
  const summary = await syncFromGithub(env);
  assert.equal(summary.status, 'up-to-date');
  assert.equal(summary.uploaded, 0);
  assert.equal(calls.length, 1, 'only the index bundle is fetched');

  const lastSync = JSON.parse(await (await bucket.get('spk/.last-sync')).text());
  assert.equal(lastSync.status, 'up-to-date');
});

test('a run without marker skips blobs that already match by size', async () => {
  installFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, DSH_REPO: REPO };
  await syncFromGithub(env);
  // Simulate a previous partial run: objects exist, marker is gone.
  await bucket.delete(MARKER_KEY);

  installFetch();
  const summary = await syncFromGithub(env);
  assert.equal(summary.status, 'synced');
  assert.equal(summary.skipped, 2, 'both SPKs already exist with the same size');
});

test('force sync re-downloads blobs to refresh cache metadata', async () => {
  installFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, DSH_REPO: REPO };
  await syncFromGithub(env);

  installFetch();
  const summary = await syncFromGithub(env, { force: true });
  assert.equal(summary.status, 'synced');
  assert.equal(summary.skipped, 0);
  assert.equal(summary.uploaded, 3, '1 icon + 2 SPKs are rewritten');
});

test('objects from older releases are pruned', async () => {
  installFetch();
  const bucket = new MockBucket();
  bucket.put('spk/packages/Old-0.1-1.spk', new Uint8Array([1, 2, 3]));
  bucket.put('spk/icons/Old_thumb_72.png', new Uint8Array([4]));
  bucket.put('spk/index.json', '{"packages":[]}');

  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPO: REPO });
  assert.equal(summary.status, 'synced');
  assert.equal(summary.deleted, 2);
  assert.equal(bucket.objects.has('spk/packages/Old-0.1-1.spk'), false);
  assert.equal(bucket.objects.has('spk/icons/Old_thumb_72.png'), false);
});

test('a package missing from the release is reported, not fatal', async () => {
  installFetch({ missing: [ARM_URL] });
  const bucket = new MockBucket();

  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPO: REPO });
  assert.equal(summary.status, 'partial');
  assert.deepEqual(summary.missing, [PKG_ARM]);
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.deepEqual(index.packages.map((item) => item.file), [PKG_X86]);
  // No marker → the next cron tick retries once the Release is complete.
  assert.equal(bucket.objects.has(MARKER_KEY), false);
});

test('the next tick completes the sync once the missing asset shows up', async () => {
  installFetch({ missing: [ARM_URL] });
  const bucket = new MockBucket();
  assert.equal((await syncFromGithub({ BUCKET: bucket, DSH_REPO: REPO })).status, 'partial');

  installFetch();
  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPO: REPO });
  assert.equal(summary.status, 'synced');
  assert.deepEqual(summary.missing, []);
  assert.equal(await (await bucket.get(MARKER_KEY)).text(), `${REPO}@${TAG}|none`);
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.length, 2);
});

test('bundle without a tag is rejected', async () => {
  installFetch({ bundle: makeBundle({ tag: '' }) });
  await assert.rejects(
    () => syncFromGithub({ BUCKET: new MockBucket(), DSH_REPO: REPO }),
    /bundle\.tag is missing/,
  );
});

test('missing index bundle fails clearly', async () => {
  installFetch({ fail: 404 });
  await assert.rejects(
    () => syncFromGithub({ BUCKET: new MockBucket(), DSH_REPO: REPO }),
    /no source published sspks-index\.json/,
  );
});

test('download errors surface as exceptions', async () => {
  installFetch({ fail: 500 });
  await assert.rejects(
    () => syncFromGithub({ BUCKET: new MockBucket(), DSH_REPO: REPO }),
    /HTTP 500/,
  );
});

// ---------------------------------------------------------------------------
// Extra (locally uploaded) packages
// ---------------------------------------------------------------------------

function makeExtraBundle(overrides = {}) {
  return {
    schema: 2,
    generated_at: '2026-11-05T06:00:00Z',
    repo: '',
    tag: '',
    defaults: {},
    packages: [
      {
        file: 'bili-sync-up_x86_64-3.1.5.spk',
        package: 'bili-sync-up',
        version: '3.1.5',
        displayname: 'Bili Sync Up',
        description: 'extra package',
        os_min_ver: '7.0-40851',
        os_max_ver: '',
        arch: ['x86_64'],
        exclude_arch: [],
        model: [],
        exclude_model: [],
        beta: false,
        thumbnail: ['icons/bili-sync-up_x86_64-3.1.5_thumb_72.png'],
        snapshot: [],
        filesize: 5,
        md5: 'md5-extra',
      },
    ],
    icons: { 'icons/bili-sync-up_x86_64-3.1.5_thumb_72.png': Buffer.from(PNG).toString('base64') },
    ...overrides,
  };
}

test('extra packages are merged with the release and kept during pruning', async () => {
  installFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, DSH_REPO: REPO };
  // tools/add-extra.py uploads the blob + bundle before the next sync.
  bucket.put('spk/packages/bili-sync-up_x86_64-3.1.5.spk', new Uint8Array([9, 9, 9, 9, 9]));
  bucket.put(EXTRA_INDEX_KEY, JSON.stringify(makeExtraBundle()), 'application/json');

  const summary = await syncFromGithub(env);
  assert.equal(summary.status, 'synced');
  assert.deepEqual(summary.missing, []);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  const names = [...new Set(index.packages.map((item) => item.package))].sort();
  assert.deepEqual(names, ['DeepSeekHarness-NAS', 'bili-sync-up']);
  // release SPKs + the extra blob are all retained
  assert.ok(bucket.objects.has(`spk/packages/${PKG_X86}`));
  assert.ok(bucket.objects.has('spk/packages/bili-sync-up_x86_64-3.1.5.spk'));
  assert.ok(bucket.objects.has('spk/icons/bili-sync-up_x86_64-3.1.5_thumb_72.png'));
  // marker includes the extra bundle signature
  assert.equal(await (await bucket.get(MARKER_KEY)).text(), `${REPO}@${TAG}|2026-11-05T06:00:00Z:1`);
});

test('a new extra bundle triggers a re-sync even when the release tag is unchanged', async () => {
  installFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, DSH_REPO: REPO };
  bucket.put('spk/packages/bili-sync-up_x86_64-3.1.5.spk', new Uint8Array([9, 9, 9, 9, 9]));
  bucket.put(EXTRA_INDEX_KEY, JSON.stringify(makeExtraBundle()), 'application/json');
  await syncFromGithub(env);

  // add-extra uploads a newer bundle (new generated_at) for the same release
  bucket.put(EXTRA_INDEX_KEY, JSON.stringify(makeExtraBundle({ generated_at: '2026-11-05T07:00:00Z' })), 'application/json');
  const summary = await syncFromGithub(env);
  assert.equal(summary.status, 'synced');
  assert.equal(summary.skipped, 2, 'release blobs are skipped by size');
});

test('an extra package whose blob is missing is reported and skipped', async () => {
  installFetch();
  const bucket = new MockBucket();
  bucket.put(EXTRA_INDEX_KEY, JSON.stringify(makeExtraBundle()), 'application/json');

  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPO: REPO });
  assert.equal(summary.status, 'partial');
  assert.deepEqual(summary.missing, ['bili-sync-up_x86_64-3.1.5.spk (extra)']);
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.deepEqual([...new Set(index.packages.map((item) => item.package))], ['DeepSeekHarness-NAS']);
});

test('release packages win over an extra package with the same name', async () => {
  installFetch();
  const bucket = new MockBucket();
  bucket.put('spk/packages/bili-sync-up_x86_64-3.1.5.spk', new Uint8Array([9, 9, 9, 9, 9]));
  bucket.put(EXTRA_INDEX_KEY, JSON.stringify(makeExtraBundle({
    packages: [{ ...makeExtraBundle().packages[0], package: 'DeepSeekHarness-NAS', file: 'bili-sync-up_x86_64-3.1.5.spk' }],
  })), 'application/json');

  await syncFromGithub({ BUCKET: bucket, DSH_REPO: REPO });
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(
    index.packages.some((item) => item.file === 'bili-sync-up_x86_64-3.1.5.spk'),
    false,
    'the extra record with a clashing package name must be dropped',
  );
});

// ---------------------------------------------------------------------------
// Multiple release sources (DSH_REPOS)
// ---------------------------------------------------------------------------

const REPO2 = 'NeeYoonc/bili-sync-up';
const TAG2 = 'v3.1.6';
const PKG2_X86 = 'bili-sync-up_x86_64-3.1.6.spk';
const PKG2_ARM = 'bili-sync-up_armv8-3.1.6.spk';
const BILI_BYTES = new TextEncoder().encode('bili-spk');

function makeBiliBundle(overrides = {}) {
  return {
    schema: 2,
    generated_at: '2026-11-05T07:50:00Z',
    repo: REPO2,
    tag: TAG2,
    defaults: { maintainer: 'NeeYoonc' },
    packages: [
      {
        file: PKG2_X86,
        package: 'bili-sync-up',
        version: '3.1.6',
        displayname: 'Bili Sync Up',
        description: 'bili build',
        os_min_ver: '7.0-40851',
        os_max_ver: '',
        arch: ['x86_64'],
        exclude_arch: [],
        model: [],
        exclude_model: [],
        beta: false,
        thumbnail: [],
        snapshot: [],
        filesize: BILI_BYTES.byteLength,
        md5: 'md5-bili-x86',
      },
      {
        file: PKG2_ARM,
        package: 'bili-sync-up',
        version: '3.1.6',
        displayname: 'Bili Sync Up',
        description: 'bili build',
        os_min_ver: '7.0-40851',
        os_max_ver: '',
        arch: ['armv8'],
        exclude_arch: [],
        model: [],
        exclude_model: [],
        beta: false,
        thumbnail: [],
        snapshot: [],
        filesize: BILI_BYTES.byteLength,
        md5: 'md5-bili-arm',
      },
    ],
    icons: {},
    ...overrides,
  };
}

function installTwoSources() {
  installFetch({
    bundles: { [latestAssetUrl(REPO2, 'sspks-index.json')]: makeBiliBundle() },
    files: {
      [latestAssetUrl(REPO2, PKG2_X86)]: BILI_BYTES,
      [latestAssetUrl(REPO2, PKG2_ARM)]: BILI_BYTES,
    },
  });
}

test('multiple repositories are merged into one index', async () => {
  installTwoSources();
  const bucket = new MockBucket();
  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPOS: `${REPO},${REPO2}` });

  assert.equal(summary.status, 'synced');
  assert.deepEqual(summary.repos, [REPO, REPO2]);
  assert.deepEqual(summary.sources.map((source) => [source.repo, source.status, source.tag]), [
    [REPO, 'ok', TAG],
    [REPO2, 'ok', TAG2],
  ]);
  assert.equal(summary.tag, TAG, 'summary.tag stays the first source tag');

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.deepEqual(
    [...new Set(index.packages.map((item) => item.package))].sort(),
    ['DeepSeekHarness-NAS', 'bili-sync-up'],
  );
  assert.ok(bucket.objects.has(`spk/packages/${PKG2_X86}`));
  assert.ok(bucket.objects.has(`spk/packages/${PKG2_ARM}`));
  // download fallback needs to know which repo owns each record
  const biliRecord = index.packages.find((item) => item.package === 'bili-sync-up');
  assert.equal(biliRecord.source, REPO2);
  assert.equal(await (await bucket.get(MARKER_KEY)).text(), `${REPO}@${TAG}|${REPO2}@${TAG2}|none`);
});

test('a source without an index bundle is skipped, not fatal', async () => {
  installFetch(); // only the first repo publishes a bundle
  const bucket = new MockBucket();
  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPOS: `${REPO},${REPO2}` });

  assert.equal(summary.status, 'synced');
  assert.equal(summary.sources[0].status, 'ok');
  assert.equal(summary.sources[1].status, 'no-bundle');
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.deepEqual([...new Set(index.packages.map((item) => item.package))], ['DeepSeekHarness-NAS']);
});

test('a source that temporarily loses its bundle keeps its previous packages', async () => {
  installTwoSources();
  const bucket = new MockBucket();
  await syncFromGithub({ BUCKET: bucket, DSH_REPOS: `${REPO},${REPO2}` });
  assert.ok(bucket.objects.has(`spk/packages/${PKG2_X86}`));

  // Second tick: only the first source has a bundle right now (mid-release).
  installFetch();
  const summary = await syncFromGithub({ BUCKET: bucket, DSH_REPOS: `${REPO},${REPO2}` });
  assert.equal(summary.sources[1].status, 'no-bundle');
  assert.ok(summary.carried >= 1);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.ok(index.packages.some((item) => item.package === 'bili-sync-up'));
  assert.ok(bucket.objects.has(`spk/packages/${PKG2_X86}`), 'carried-over blob must not be pruned');
});

test('the first source wins when two sources publish the same package', async () => {
  installFetch({
    bundles: {
      [latestAssetUrl(REPO2, 'sspks-index.json')]: makeBiliBundle({
        packages: [{ ...makeBiliBundle().packages[0], package: 'DeepSeekHarness-NAS' }],
      }),
    },
    files: { [latestAssetUrl(REPO2, PKG2_X86)]: BILI_BYTES },
  });
  const bucket = new MockBucket();
  await syncFromGithub({ BUCKET: bucket, DSH_REPOS: `${REPO},${REPO2}` });

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.some((item) => item.file === PKG2_X86), false);
});

// ---------------------------------------------------------------------------
// Worker routes: /sync and the GitHub download fallback
// ---------------------------------------------------------------------------

function makeEnv(bucket, overrides = {}) {
  return { BUCKET: bucket, SYNC_TOKEN: 'test-token', BASE_URL: 'https://spk.example.com/', ...overrides };
}

test('manual /sync requires the secret token and syncs when supplied', async () => {
  installFetch();
  const env = makeEnv(new MockBucket());
  const request = (headers) => new Request('https://spk.example.com/sync', { headers });

  assert.equal((await worker.fetch(request({}), env)).status, 403);
  assert.equal((await worker.fetch(request({ 'x-sync-token': 'nope' }), env)).status, 403);

  const ok = await worker.fetch(request({ 'x-sync-token': 'test-token' }), env);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.status, 'synced');
  assert.equal(body.tag, TAG);
});

test('manual /sync is disabled without a configured token', async () => {
  const response = await worker.fetch(
    new Request('https://spk.example.com/sync', { headers: { 'x-sync-token': 'anything' } }),
    { BUCKET: new MockBucket() },
  );
  assert.equal(response.status, 403);
});

test('missing R2 object falls back to the GitHub release asset', async () => {
  const bucket = new MockBucket();
  bucket.put('spk/index.json', JSON.stringify({
    schema: 1,
    packages: [{ file: PKG_X86, package: 'DeepSeekHarness-NAS', version: '0.2.3' }],
    repo: REPO,
    tag: TAG,
  }), 'application/json');
  installFetch();

  const response = await worker.fetch(
    new Request(`https://spk.example.com/packages/${PKG_X86}`),
    { BUCKET: bucket },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), X86_BYTES);

  const missing = await worker.fetch(
    new Request('https://spk.example.com/packages/Nope-1.0-1.spk'),
    { BUCKET: bucket },
  );
  assert.equal(missing.status, 404);
});

test('latestAssetUrl encodes asset names', () => {
  assert.equal(
    latestAssetUrl(REPO, 'Pkg 名称+1.spk'),
    'https://github.com/NeeYoonc/dsh-nas/releases/latest/download/Pkg%20%E5%90%8D%E7%A7%B0%2B1.spk',
  );
});

// ---------------------------------------------------------------------------
// Non-GitHub sources (`SPK_HOSTS`): a vendor's own Package Center endpoint
// ---------------------------------------------------------------------------

const HOST = 'https://release.66666.host/spk';
const HOST_VERSION = '3.7.1-70001';
const HOST_PKG_X86 = 'lucky_3.7.1-1_dsm7_x86_64_wanji.spk';
const HOST_PKG_ARM = 'lucky_3.7.1-1_dsm7_armv8_wanji.spk';
const HOST_URL_X86 = `https://release.66666.host/spk/packages/${'a'.repeat(64)}/${HOST_PKG_X86}`;
const HOST_URL_ARM = `https://release.66666.host/spk/packages/${'b'.repeat(64)}/${HOST_PKG_ARM}`;
const md5 = (bytes) => createHash('md5').update(Buffer.from(bytes)).digest('hex');

function hostQueryUrl(arch, model) {
  return `${HOST}/?unique=${encodeURIComponent(model)}&arch=${arch}&major=7&minor=2&build=69057&package_update_channel=stable&language=chs`;
}

const HOST_QUERY_X86 = hostQueryUrl('geminilake', 'synology_geminilake_ds920+');
const HOST_QUERY_ARM = hostQueryUrl('armada37xx', 'synology_armada37xx_ds220j');

// Tiny tar writer, same shape as tests/autoindex.test.mjs.
function hostTarHeader(name, size, type = '0') {
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

function hostTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = entry.data === undefined ? new Uint8Array(0)
      : (typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data);
    chunks.push(hostTarHeader(entry.name, data.byteLength, entry.type || '0'));
    if (data.byteLength > 0) {
      chunks.push(data);
      const pad = (512 - (data.byteLength % 512)) % 512;
      if (pad > 0) chunks.push(new Uint8Array(pad));
    }
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function makeLuckySpk({ arch = 'x86_64', description = 'An example package' } = {}) {
  const info = [
    'package="lucky-wanji"',
    'displayname="Lucky · wanji"',
    'version="3.7.1-70001"',
    `description="${description}"`,
    `arch="${arch}"`,
    'maintainer="古大羊"',
    'os_min_ver="7.0-41890"',
    'os_max_ver="7.9-99999"',
  ].join('\n');
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  return hostTar([
    { name: 'INFO', data: info },
    { name: 'package.tgz', data: new Uint8Array(1500).fill(7) },
    { name: 'PACKAGE_ICON.PNG', data: png },
    { name: 'PACKAGE_ICON_256.PNG', data: png },
    { name: 'WIZARD_UIFILES/', type: '5' },
    { name: 'conf/privilege', data: '{"defaults":{"run-as":"root"}}' },
  ]);
}

const LUCKY_X86 = makeLuckySpk({ arch: 'x86_64' });
const LUCKY_ARM = makeLuckySpk({ arch: 'armv8' });

function hostQueries({ x86 = LUCKY_X86, arm = LUCKY_ARM } = {}) {
  return {
    [HOST_QUERY_X86]: {
      packages: [{ package: 'lucky-wanji', version: HOST_VERSION, link: HOST_URL_X86, md5: md5(x86), size: x86.byteLength }],
    },
    [HOST_QUERY_ARM]: {
      packages: [{ package: 'lucky-wanji', version: HOST_VERSION, link: HOST_URL_ARM, md5: md5(arm), size: arm.byteLength }],
    },
  };
}

const HOST_REAL_FETCH = globalThis.fetch;
let restoreHostFetch = null;

/**
 * Mock both the host Package Center endpoints and (optionally) the GitHub
 * release endpoints used by the same sync run.
 */
function installHostFetch({
  queries = hostQueries(),
  hostFiles = {},
  failHostQueries = false,
  github = false,
} = {}) {
  const original = globalThis.fetch;
  const calls = [];
  const hostPayloads = { [HOST_URL_X86]: LUCKY_X86, [HOST_URL_ARM]: LUCKY_ARM, ...hostFiles };
  const githubPayloads = { [X86_URL]: X86_BYTES, [ARM_URL]: ARM_BYTES };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const range = headers.get('range');
    calls.push({ url, method, range });

    if (Object.prototype.hasOwnProperty.call(queries, url)) {
      if (failHostQueries) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify(queries[url]), { status: 200 });
    }
    if (Object.prototype.hasOwnProperty.call(hostPayloads, url)) {
      const bytes = hostPayloads[url];
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), bytes.byteLength - 1);
        const slice = bytes.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: { 'content-length': String(slice.byteLength), 'content-range': `bytes ${start}-${end}/${bytes.byteLength}` },
        });
      }
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    }
    if (github) {
      if (url === BUNDLE_URL) return new Response(JSON.stringify(makeBundle()), { status: 200 });
      const bytes = githubPayloads[url];
      if (bytes === undefined) return new Response('not found', { status: 404 });
      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
      }
      return new Response(new Blob([bytes]).stream(), {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      });
    }
    return new Response('not found', { status: 404 });
  };
  restoreHostFetch = () => { globalThis.fetch = HOST_REAL_FETCH; };
  return calls;
}

afterEach(() => {
  if (restoreHostFetch) restoreHostFetch();
  restoreHostFetch = null;
});

test('SPK_HOSTS: a non-GitHub source is mirrored into R2 and indexed', async () => {
  const calls = installHostFetch();
  const bucket = new MockBucket();

  const summary = await syncFromGithub({ BUCKET: bucket, SPK_HOSTS: HOST }, { repos: '' });

  assert.equal(summary.status, 'synced');
  assert.deepEqual(summary.missing, []);
  assert.equal(summary.uploaded, 2);
  assert.deepEqual(summary.hosts, [HOST]);
  assert.deepEqual(summary.sources.map((source) => source.status), ['host']);
  assert.equal(summary.sources[0].files, 2);
  // One query per supported architecture family, no GitHub traffic.
  assert.ok(calls.some((call) => call.url.includes('arch=geminilake')));
  assert.ok(calls.some((call) => call.url.includes('arch=armada37xx')));
  assert.equal(calls.some((call) => call.url.includes('github.com')), false);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.length, 2);
  assert.equal(index.packages[0].package, 'lucky-wanji');
  assert.equal(index.packages[0].source, HOST);
  assert.equal(index.packages[0].md5, md5(LUCKY_X86));
  assert.equal(index.packages[0].os_min_ver, '7.0-41890');
  assert.ok(bucket.objects.has('spk/packages/' + HOST_PKG_X86));
  assert.ok(bucket.objects.has('spk/icons/lucky_3.7.1-1_dsm7_x86_64_wanji_thumb_72.png'));
  assert.ok(bucket.objects.has('spk/icons/lucky_3.7.1-1_dsm7_x86_64_wanji_thumb_120.png'));

  const marker = await (await bucket.get(MARKER_KEY)).text();
  assert.match(marker, /@host\(/);
});

test('SPK_HOSTS: second run is a no-op (only the two source queries)', async () => {
  installHostFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };
  await syncFromGithub(env, { repos: '' });

  const calls = installHostFetch();
  const summary = await syncFromGithub(env, { repos: '' });
  assert.equal(summary.status, 'up-to-date');
  assert.equal(summary.uploaded, 0);
  assert.equal(calls.length, 2);
});

test('SPK_HOSTS: a rebuilt same-size SPK is re-downloaded', async () => {
  installHostFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };
  await syncFromGithub(env, { repos: '' });

  const rebuilt = makeLuckySpk({ arch: 'x86_64', description: 'An example packagX' });
  assert.equal(rebuilt.byteLength, LUCKY_X86.byteLength, 'fixture must keep the same byte size');
  installHostFetch({ queries: hostQueries({ x86: rebuilt }), hostFiles: { [HOST_URL_X86]: rebuilt } });

  const summary = await syncFromGithub(env, { repos: '' });
  assert.equal(summary.status, 'synced');
  assert.equal(summary.uploaded, 1, 'the changed SPK is rewritten');
  assert.equal(summary.skipped, 1, 'the unchanged SPK is skipped');

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  const record = index.packages.find((item) => item.file === HOST_PKG_X86);
  assert.equal(record.md5, md5(rebuilt));
});

test('SPK_HOSTS: large SPKs are fetched as ranges and reassembled', async () => {
  const calls = installHostFetch();
  const bucket = new MockBucket();

  const summary = await syncFromGithub(
    { BUCKET: bucket, SPK_HOSTS: HOST },
    { repos: '', hostChunkBytes: 512 },
  );
  assert.equal(summary.status, 'synced');
  assert.ok(calls.filter((call) => call.range !== null).length >= 4, 'expected several range requests');
  const stored = bucket.objects.get('spk/packages/' + HOST_PKG_X86).bytes;
  assert.deepEqual(stored, LUCKY_X86);
});

test('SPK_HOSTS: previous packages are carried when the source is unreachable', async () => {
  installHostFetch({ github: true });
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST, DSH_REPO: REPO };
  const first = await syncFromGithub(env);
  assert.equal(first.status, 'synced');
  assert.equal(first.sources.filter((source) => source.status === 'host').length, 1);

  installHostFetch({ github: true, failHostQueries: true });
  const second = await syncFromGithub(env);
  assert.equal(second.status, 'synced');
  assert.equal(second.carried, 2);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.filter((item) => item.source === HOST).length, 2);
  assert.equal(index.packages.filter((item) => item.source === REPO).length, 2);
});

test('a concurrent sync is skipped while the lock is held', async () => {
  installHostFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };
  await syncFromGithub(env, { repos: '' });

  // Simulate a run in progress: a fresh lock plus a forced (stale-marker) run.
  await bucket.put('spk/.sync-lock', JSON.stringify({ at: Date.now(), trigger: 'cron' }), 'application/json');
  const calls = installHostFetch();
  const summary = await syncFromGithub(env, { repos: '', force: true });
  assert.equal(summary.status, 'busy');
  assert.equal(summary.uploaded, 0);
  assert.equal(calls.filter((call) => !call.url.includes('/?')).length, 0, 'no package downloads while busy');
  const lastSync = JSON.parse(await (await bucket.get('spk/.last-sync')).text());
  assert.equal(lastSync.status, 'busy');
  // A busy run must not release a lock it does not own.
  assert.ok(bucket.objects.has('spk/.sync-lock'));
});

test('an expired lock does not block the sync', async () => {
  installHostFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };
  await syncFromGithub(env, { repos: '' });

  await bucket.put('spk/.sync-lock', JSON.stringify({ at: Date.now() - 60 * 60 * 1000 }), 'application/json');
  installHostFetch();
  const summary = await syncFromGithub(env, { repos: '', force: true });
  assert.equal(summary.status, 'synced');
  assert.equal(bucket.objects.has('spk/.sync-lock'), false, 'the stale lock is replaced and released');
});

test('SPK_HOSTS: links with query parameters are mirrored (SynoCommunity style)', async () => {
  const x86Url = `${HOST_URL_X86}?arch=geminilake&build=69057`;
  const armUrl = `${HOST_URL_ARM}?arch=armada37xx&build=69057`;
  installHostFetch({
    queries: {
      [HOST_QUERY_X86]: {
        packages: [{ package: 'lucky-wanji', version: HOST_VERSION, link: x86Url, md5: md5(LUCKY_X86), size: LUCKY_X86.byteLength }],
      },
      [HOST_QUERY_ARM]: {
        packages: [{ package: 'lucky-wanji', version: HOST_VERSION, link: armUrl, md5: md5(LUCKY_ARM), size: LUCKY_ARM.byteLength }],
      },
    },
    hostFiles: { [x86Url]: LUCKY_X86, [armUrl]: LUCKY_ARM },
  });
  const bucket = new MockBucket();
  const summary = await syncFromGithub({ BUCKET: bucket, SPK_HOSTS: HOST }, { repos: '' });
  assert.equal(summary.status, 'synced');
  assert.equal(summary.uploaded, 2);
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.length, 2);
  assert.equal(index.packages[0].file, HOST_PKG_X86);
});

test('SPK_HOSTS: a large source is mirrored in batches and resumes', async () => {
  installHostFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };

  const first = await syncFromGithub(env, { repos: '', hostBatchFiles: 1 });
  assert.equal(first.status, 'partial');
  assert.deepEqual(first.progress, { done: 1, total: 2, pending: 1 });
  assert.equal(bucket.objects.has('spk/index.json'), false, 'the index is not published mid-mirror');
  assert.ok(bucket.objects.has('spk/.host-sync-state.json'));

  const calls = installHostFetch();
  const second = await syncFromGithub(env, { repos: '', hostBatchFiles: 1 });
  assert.equal(second.status, 'synced');
  assert.equal(second.uploaded, 1, 'only the pending file is downloaded');
  assert.equal(
    calls.filter((call) => call.url === HOST_URL_X86 && call.method === 'GET' && !call.range).length,
    0,
    'the file mirrored by the first run is not downloaded again',
  );
  assert.equal(bucket.objects.has('spk/.host-sync-state.json'), false, 'the state is cleared once complete');
  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.length, 2);
});

test('SPK_HOSTS: a new source signature reuses records whose md5 is unchanged', async () => {
  installHostFetch();
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };
  await syncFromGithub(env, { repos: '' });

  const rebuilt = makeLuckySpk({ arch: 'x86_64', description: 'An example packagX' });
  const calls = installHostFetch({ queries: hostQueries({ x86: rebuilt }), hostFiles: { [HOST_URL_X86]: rebuilt } });
  const summary = await syncFromGithub(env, { repos: '' });
  assert.equal(summary.status, 'synced');
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.skipped, 1, 'the unchanged armv8 record is reused');
  assert.equal(
    calls.filter((call) => call.url === HOST_URL_ARM && !call.range).length,
    0,
    'the unchanged SPK is not downloaded again',
  );
});

test('SPK_HOSTS: an unparsable SPK is retried and then reported as failed', async () => {
  const bad = new Uint8Array(2048); // no tar entries at all -> no INFO
  installHostFetch({ queries: hostQueries({ x86: bad }), hostFiles: { [HOST_URL_X86]: bad } });
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, SPK_HOSTS: HOST };

  const summary = await syncFromGithub(env, { repos: '' });
  assert.equal(summary.status, 'synced');
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0], /no INFO/);

  const index = JSON.parse(await (await bucket.get('spk/index.json')).text());
  assert.equal(index.packages.length, 1, 'the good package is still indexed');
});
