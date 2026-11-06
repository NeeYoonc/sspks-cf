// Pull the latest dsh-nas GitHub Release and mirror it into R2.
//
// The release carries a small `sspks-index.json` bundle produced by the dsh-nas
// CI (`.sspks/tools/index.py --bundle`). It already contains the exact md5 of
// every SPK and every icon as base64, so this Worker never has to parse a
// 171 MB tar or hash it with Web Crypto (which has no MD5 implementation).
//
// IMPORTANT: no GitHub REST API calls. `releases/latest/download/<asset>` is a
// plain github.com URL that redirects to the asset CDN, so the cron never hits
// the 60-req/hour unauthenticated API limit that Workers' shared egress IPs run
// into (observed as HTTP 403). It also follows GitHub's "Latest" = newest
// non-prerelease release, which matches the package source's stable channel.
//
// Flow (idempotent, safe to re-run):
//   1. download sspks-index.json from the latest release (bundle.tag decides)
//   2. compare tag with spk/.synced-release → stop when unchanged
//   3. HEAD every SPK on GitHub, stream it into R2 when missing/size differs
//   4. write icons + spk/index.json
//   5. delete R2 objects that belong to older releases
//   6. write the release marker (only after everything else succeeded)

import { assetSize, buildRecord, discoverRelease, ensureDefaultIcons, md5FromEtag, readSpkParts, SpkTarScanner } from './autoindex.js';

const DEFAULT_REPO = 'NeeYoonc/dsh-nas';
const DEFAULT_BUNDLE_ASSET = 'sspks-index.json';

export const INDEX_KEY = 'spk/index.json';
export const MARKER_KEY = 'spk/.synced-release';
export const LAST_SYNC_KEY = 'spk/.last-sync';
// Locally uploaded packages (not tied to a GitHub release), e.g. a package whose
// repository does not publish an sspks-index.json bundle yet.
export const EXTRA_INDEX_KEY = 'spk/index.extra.json';
const PACKAGES_PREFIX = 'spk/packages/';
const ICONS_PREFIX = 'spk/icons/';
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const SAFE_FILE = /^[^/\\\u0000]+\.spk$/i;
const SAFE_KEY = /^[A-Za-z0-9._\-/]+$/;

// Non-GitHub package sources (`SPK_HOSTS`): a vendor's own DSM Package Center
// endpoint, e.g. https://release.66666.host/spk. The Worker queries it once per
// architecture family it supports, mirrors the SPKs it lists into R2 and indexes
// them with the same bundle-less SPK parser used for GitHub releases.
const HOST_FAMILY_QUERIES = [
  { arch: 'geminilake', model: 'synology_geminilake_ds920+' },
  { arch: 'armada37xx', model: 'synology_armada37xx_ds220j' },
];
const HOST_QUERY = 'major=7&minor=2&build=69057&package_update_channel=stable&language=chs';
// Some CDNs rate-limit a single large response (release.66666.host throttles a
// full GET to ~0.8 MB/s but serves ~6 MiB ranges at full speed), so large SPKs
// are fetched as ranges and assembled before the R2 put.
const HOST_CHUNK_BYTES = 6 * 1024 * 1024;
const HOST_FETCH_CONCURRENCY = 4;
// A source with hundreds of packages cannot be mirrored in one invocation
// (per-invocation subrequest limit / cron interval), so each run mirrors a
// bounded batch and keeps its progress in R2 until the source is complete.
const HOST_SYNC_STATE_KEY = 'spk/.host-sync-state.json';
const HOST_BATCH_FILES = 60;
const HOST_PART_CONCURRENCY = 5;
// A package that cannot be parsed (corrupt/unsupported SPK) is retried a few
// times and then reported as failed instead of blocking the whole source.
const HOST_MAX_ATTEMPTS = 3;
// Only one sync runs at a time: cron ticks overlap when a release has large
// assets, and two concurrent runs would download the same files twice.
const SYNC_LOCK_KEY = 'spk/.sync-lock';
const SYNC_LOCK_TTL_MS = 20 * 60 * 1000;

function requestHeaders(env) {
  const headers = { 'User-Agent': 'sspks-cf-worker' };
  const token = String(env.GH_TOKEN || '').trim();
  if (token !== '') headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** `SPK_HOSTS` (or `options.hosts`) as a de-duplicated list of base URLs. */
function hostsFromEnv(env, options) {
  const raw = options.hosts !== undefined ? options.hosts : (env.SPK_HOSTS || '');
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((item) => String(item).trim().replace(/\/+$/, '')).filter(Boolean))];
}

function hostQueryUrl(base, family) {
  return `${base}/?unique=${encodeURIComponent(family.model)}&arch=${family.arch}&${HOST_QUERY}`;
}

/**
 * Load one non-GitHub source: two cheap Package Center queries (x86_64 and armv8
 * families) tell us the latest version of every package and where to download it.
 */
async function loadHostSource(env, base) {
  const files = new Map();
  const seenMd5 = new Set();
  const versions = new Set();
  const errors = [];
  for (const family of HOST_FAMILY_QUERIES) {
    try {
      const response = await fetch(hostQueryUrl(base, family), {
        headers: requestHeaders(env),
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const packages = body && Array.isArray(body.packages) ? body.packages : [];
      for (const item of packages) {
        const link = String((item && item.link) || '').trim();
        if (!/^https?:\/\//i.test(link)) continue;
        // The link may carry query parameters (?arch=…&build=…) after the file name.
        const file = decodeURIComponent(link.split('?')[0].split('/').pop() || '');
        if (!SAFE_FILE.test(file) || files.has(file)) continue;
        const size = Number(item.size);
        const md5 = String(item.md5 || '').trim().toLowerCase();
        if (!Number.isFinite(size) || size <= 0 || !/^[a-f0-9]{32}$/.test(md5)) continue;
        if (seenMd5.has(md5)) continue; // same bytes listed for another architecture family
        seenMd5.add(md5);
        files.set(file, { file, url: link, size, md5 });
        const version = String(item.version || '').trim();
        if (version !== '') versions.add(version);
      }
    } catch (error) {
      errors.push(`${family.arch}: ${(error && error.message) || error}`);
    }
  }
  if (files.size === 0) {
    return {
      repo: base,
      status: 'no-bundle',
      bundle: null,
      tag: null,
      autoError: errors.join('; ') || 'host source returned no packages',
    };
  }
  const versionList = [...versions];
  return {
    repo: base,
    status: 'host',
    bundle: null,
    // One package version (Lucky) is a useful tag; sources where every package
    // has its own version (SynoCommunity) get a compact summary instead of a
    // multi-kilobyte list in /health and the index metadata.
    tag: versionList.length === 0 ? base : (versionList.length === 1 ? versionList[0] : `${versionList.length} versions`),
    host: { files: [...files.values()] },
  };
}

/** FNV-1a hash; keeps the sync marker small for sources with hundreds of files. */
function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function hostSignature(source) {
  const files = source.host.files.map((item) => `${item.file}:${item.md5}`).join('|');
  return `${source.repo}@${source.tag || 'host'}@host(${source.host.files.length}:${hashString(files)})`;
}

async function readHostState(env) {
  try {
    const object = await env.BUCKET.get(HOST_SYNC_STATE_KEY);
    if (object === null || object === undefined) return { version: 1, sources: {} };
    const parsed = JSON.parse(await object.text());
    if (parsed === null || typeof parsed !== 'object'
      || parsed.sources === null || typeof parsed.sources !== 'object') {
      return { version: 1, sources: {} };
    }
    return parsed;
  } catch {
    return { version: 1, sources: {} };
  }
}

async function writeHostState(env, state) {
  if (Object.keys(state.sources || {}).length === 0) {
    try {
      await env.BUCKET.delete(HOST_SYNC_STATE_KEY);
    } catch {
      // best effort: an empty state object is harmless
    }
    return;
  }
  await env.BUCKET.put(HOST_SYNC_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
}

/**
 * Start (or resume) the mirror state of one host source. When the source
 * published a new signature, records whose md5 did not change are reused so a
 * version bump only downloads what actually changed.
 */
function prepareHostState(source, hostState, previousRecords) {
  const base = source.repo;
  const signature = hostSignature(source);
  const existing = hostState.sources[base];
  if (existing !== undefined && existing.signature === signature) {
    if (!Array.isArray(existing.pending)) existing.pending = [];
    if (!Array.isArray(existing.records)) existing.records = [];
    if (existing.failed === null || typeof existing.failed !== 'object') existing.failed = {};
    // Repair state written by an invocation that died mid-batch.
    const known = new Set([
      ...existing.pending.map((item) => String(item.file)),
      ...existing.records.map((record) => String(record.file)),
    ]);
    for (const item of source.host.files) {
      if (!known.has(item.file)) existing.pending.push(item);
    }
    return { state: existing, reused: 0 };
  }
  const pending = [];
  const records = [];
  for (const item of source.host.files) {
    const previous = previousRecords.get(item.file);
    if (previous !== undefined && String(previous.md5 || '').toLowerCase() === item.md5) {
      records.push(previous);
    } else {
      pending.push(item);
    }
  }
  const fresh = {
    signature,
    tag: source.tag || '',
    total: source.host.files.length,
    pending,
    records,
    failed: {},
  };
  hostState.sources[base] = fresh;
  return { state: fresh, reused: records.length };
}

/** Download one host SPK, store it in R2 and build its index record in memory. */
const PACKAGE_HTTP_METADATA = {
  contentType: 'application/octet-stream',
  cacheControl: 'public, max-age=2592000, immutable',
};

/**
 * Download one host SPK into R2. Files larger than one chunk are uploaded with
 * R2 multipart parts, so a 147 MB package never has to fit in the 128 MB Worker
 * memory; the tar scanner collects INFO/icons from each part on the way.
 */
async function syncHostPackage(env, item, options) {
  const file = item.file;
  const key = `${PACKAGES_PREFIX}${file}`;
  const chunkBytes = Number.isFinite(options.hostChunkBytes) ? options.hostChunkBytes : HOST_CHUNK_BYTES;
  const size = Number(item.size);
  const headers = requestHeaders(env);
  const scanner = new SpkTarScanner();
  const fetchRange = async (offset, end) => {
    const response = await fetch(item.url, {
      headers: { ...headers, Range: `bytes=${offset}-${end}` },
      redirect: 'follow',
    });
    if (response.status !== 206) throw new Error(`download ${file}: HTTP ${response.status}`);
    const chunk = new Uint8Array(await response.arrayBuffer());
    if (chunk.byteLength !== end - offset + 1) {
      throw new Error(`download ${file}: short range ${offset}-${end}`);
    }
    return chunk;
  };

  let finalSize = size;
  if (!Number.isFinite(size) || size <= 0 || size <= chunkBytes) {
    // Small (or unknown-size) file: one request, buffered (at most one chunk).
    const response = await fetch(item.url, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`download ${file}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    scanner.push(bytes);
    finalSize = bytes.byteLength;
    await putPackage(env, key, bytes, file);
  } else {
    const upload = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: { ...PACKAGE_HTTP_METADATA, contentDisposition: `attachment; filename="${file.replace(/["\\]/g, '_')}"` },
    });
    try {
      const uploaded = [];
      let offset = 0;
      let partNumber = 1;
      while (offset < size) {
        // Fetch (and then upload) a few parts concurrently: R2 part uploads are
        // latency bound, and this keeps a 147 MB package well inside the memory
        // limit because only a few 6 MiB parts are buffered at a time.
        const batch = [];
        while (batch.length < HOST_PART_CONCURRENCY && offset < size) {
          const end = Math.min(offset + chunkBytes, size) - 1;
          batch.push({ partNumber, offset, end });
          offset = end + 1;
          partNumber += 1;
        }
        const chunks = await Promise.all(batch.map((part) => fetchRange(part.offset, part.end)));
        for (let index = 0; index < batch.length; index += 1) scanner.push(chunks[index]);
        const parts = await Promise.all(batch.map((part, index) => upload.uploadPart(part.partNumber, chunks[index])));
        uploaded.push(...parts);
      }
      await upload.complete(uploaded);
    } catch (error) {
      try {
        await upload.abort();
      } catch {
        // abort is best effort
      }
      throw error;
    }
  }

  const md5 = /^[a-f0-9]{32}$/i.test(String(item.md5 || '')) ? item.md5 : null;
  if (md5 === null) throw new Error('host did not provide an md5');
  const parts = scanner.finish();
  return buildRecord(env, { file, parts, size: finalSize, md5 });
}

/** https://github.com/<repo>/releases/latest/download/<asset> (no API, follows redirects). */
export function latestAssetUrl(repo, asset) {
  return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(asset)}`;
}

export function base64ToBytes(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('empty base64 payload');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Optional bundle with locally uploaded packages. Its `generated_at` is part of
 * the sync marker, so uploading a new extra bundle triggers a re-sync even when
 * the GitHub release tag did not change.
 */
export async function readExtraBundle(env) {
  let object;
  try {
    object = await env.BUCKET.get(EXTRA_INDEX_KEY);
  } catch {
    return null;
  }
  if (object === null || object === undefined) return null;
  try {
    const bundle = JSON.parse(await object.text());
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.packages)) return null;
    return bundle;
  } catch {
    return null;
  }
}

function extraSignature(extra) {
  if (!extra) return 'none';
  return `${extra.generated_at || 'unknown'}:${extra.packages.length}`;
}

export async function readMarker(env) {
  const object = await env.BUCKET.get(MARKER_KEY);
  if (object === null || object === undefined) return null;
  return (await object.text()).trim();
}

/** The current sync lock, or null when absent/expired. */
async function readSyncLock(env) {
  try {
    const object = await env.BUCKET.get(SYNC_LOCK_KEY);
    if (object === null || object === undefined) return null;
    const parsed = JSON.parse(await object.text());
    const at = Number(parsed && parsed.at);
    if (!Number.isFinite(at) || Date.now() - at >= SYNC_LOCK_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Keep a long-running sync from losing its lock (best effort). */
async function touchSyncLock(env) {
  try {
    await env.BUCKET.put(SYNC_LOCK_KEY, JSON.stringify({ at: Date.now() }), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
  } catch {
    // lock refresh is best effort; the TTL still bounds a crashed run
  }
}

/** Delete every object under `prefix` whose basename is not in `keep`. */
async function prunePrefix(env, prefix, keep) {
  let deleted = 0;
  let cursor;
  for (;;) {
    const page = await env.BUCKET.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const entry of page.objects || []) {
      const name = entry.key.slice(prefix.length);
      if (!keep.has(name)) {
        await env.BUCKET.delete(entry.key);
        deleted += 1;
      }
    }
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  return deleted;
}

function validateBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object') throw new Error('bundle is not an object');
  if (Number(bundle.schema) < 2) throw new Error(`unsupported bundle schema: ${bundle.schema}`);
  if (!Array.isArray(bundle.packages)) throw new Error('bundle.packages must be an array');
  if (bundle.icons !== undefined && (bundle.icons === null || typeof bundle.icons !== 'object')) {
    throw new Error('bundle.icons must be an object');
  }
  if (typeof bundle.tag !== 'string' || bundle.tag.trim() === '') {
    throw new Error('bundle.tag is missing (CI must pass --tag)');
  }
}

async function downloadBundle(env, repo, assetName) {
  const response = await fetch(latestAssetUrl(repo, assetName), {
    headers: requestHeaders(env),
    redirect: 'follow',
  });
  if (response.status === 404) {
    const error = new Error(`latest release has no ${assetName} asset (is it still uploading?)`);
    error.code = 'NO_BUNDLE';
    throw error;
  }
  if (!response.ok) throw new Error(`download ${assetName}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BUNDLE_BYTES) throw new Error('index bundle is too large');
  const bundle = JSON.parse(text);
  validateBundle(bundle);
  return bundle;
}

/** Size of the asset in the latest release, or null when it does not exist. */
async function remoteSize(env, repo, file) {
  const response = await fetch(latestAssetUrl(repo, file), {
    method: 'HEAD',
    headers: requestHeaders(env),
    redirect: 'follow',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HEAD ${file}: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

function reposFromEnv(env, options) {
  const raw = options.repos !== undefined
    ? options.repos
    : (env.DSH_REPOS || env.DSH_REPO || DEFAULT_REPO);
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

async function readIndexObject(env) {
  try {
    const object = await env.BUCKET.get(INDEX_KEY);
    if (object === null || object === undefined) return null;
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

async function loadSource(env, repo, bundleAsset) {
  try {
    const bundle = await downloadBundle(env, repo, bundleAsset);
    return { repo, status: 'ok', bundle, tag: bundle.tag.trim() };
  } catch (error) {
    if (!error || error.code !== 'NO_BUNDLE') throw error;
    // No bundle: fall back to indexing the release's SPKs directly (the Worker
    // parses INFO/icons from R2 and takes md5 from the R2 ETag).
    try {
      const auto = await discoverRelease(env, repo);
      if (auto.files.length === 0) {
        return { repo, status: 'no-bundle', bundle: null, tag: null };
      }
      return { repo, status: 'auto', bundle: null, tag: auto.tag, auto };
    } catch (autoError) {
      return {
        repo,
        status: 'no-bundle',
        bundle: null,
        tag: null,
        autoError: String((autoError && autoError.message) || autoError),
      };
    }
  }
}

function sourceSignature(source) {
  if (source.status === 'auto') return `${source.repo}@${source.tag}@auto(${source.auto.files.join('|')})`;
  if (source.status === 'host') return hostSignature(source);
  return `${source.repo}@${source.tag || source.status}`;
}

async function putPackage(env, key, body, file) {
  await env.BUCKET.put(key, body, {
    // Links carry ?v=<md5 prefix>, so a rebuilt same-version asset gets a new
    // URL and long-lived edge caching stays safe.
    httpMetadata: {
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=2592000, immutable',
      contentDisposition: `attachment; filename="${file.replace(/["\\]/g, '_')}"`,
    },
  });
}

/**
 * Sync every configured source into R2.
 *
 * GitHub sources come from `DSH_REPOS` (comma separated) or `options.repos`.
 * Each must publish an `sspks-index.json` release asset; repositories without
 * one are indexed from their release's SPKs directly (status `auto`).
 * Non-GitHub sources come from `SPK_HOSTS` (comma separated DSM Package Center
 * endpoints) and are mirrored the same way (status `host`).
 * Packages are merged by package name and the first source wins, then locally
 * uploaded "extra" packages fill the gaps.
 *
 * @param {object} env     worker env (BUCKET, optional GH_TOKEN / DSH_REPOS / SPK_HOSTS)
 * @param {{repos?: string|string[], hosts?: string|string[], bundleAsset?: string,
 *          force?: boolean, trigger?: string, hostChunkBytes?: number}} [options]
 * @returns {Promise<object>} summary
 */
export async function syncFromGithub(env, options = {}) {
  const bundleAsset = String(options.bundleAsset || env.BUNDLE_ASSET || DEFAULT_BUNDLE_ASSET).trim();
  const repos = reposFromEnv(env, options);
  const hosts = hostsFromEnv(env, options);
  const summary = {
    status: 'unknown',
    repo: repos[0] || hosts[0] || null,
    repos,
    hosts,
    sources: [],
    tag: null,
    uploaded: 0,
    skipped: 0,
    deleted: 0,
    missing: [],
    failed: [],
  };

  const sources = [];
  for (const repo of repos) {
    sources.push(await loadSource(env, repo, bundleAsset));
  }
  for (const base of hosts) {
    sources.push(await loadHostSource(env, base));
  }
  summary.sources = sources.map((source) => ({
    repo: source.repo,
    status: source.status,
    tag: source.tag,
    packages: source.bundle ? source.bundle.packages.length : 0,
    files: source.auto ? source.auto.files.length : (source.host ? source.host.files.length : 0),
    error: source.autoError || null,
  }));
  summary.tag = (sources.find((source) => source.tag) || {}).tag || null;

  const okSources = sources.filter((source) => source.status === 'ok'
    || source.status === 'auto'
    || source.status === 'host');
  if (okSources.length === 0) {
    // Nothing to sync from. Fail instead of publishing an empty index: a release
    // that is still uploading its bundle must not wipe the current one.
    throw new Error(
      `no source published ${bundleAsset} (${sources.map((source) => `${source.repo}: ${source.status}`).join(', ')})`,
    );
  }

  const extra = await readExtraBundle(env);
  const signature = sources.map(sourceSignature).join('|');
  const markerValue = `${signature}|${extraSignature(extra)}`;

  if (!options.force) {
    const marker = await readMarker(env);
    if (marker === markerValue) {
      summary.status = 'up-to-date';
      await recordLastSync(env, summary, options.trigger);
      return summary;
    }
  }

  // Serialise sync runs: with ~300 MB of assets a run can outlive the 5 minute
  // cron interval, and overlapping runs would mirror the same files twice.
  if (!options.skipLock) {
    const held = await readSyncLock(env);
    if (held !== null) {
      summary.status = 'busy';
      summary.error = 'another sync is already running';
      await recordLastSync(env, summary, options.trigger);
      return summary;
    }
    await env.BUCKET.put(SYNC_LOCK_KEY, JSON.stringify({ at: Date.now(), trigger: options.trigger || 'cron' }), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
  }

  try {
  // Mirror host sources in bounded batches (see HOST_BATCH_FILES): a source with
  // hundreds of packages cannot finish inside one invocation, so progress is
  // persisted in R2 and the run returns `partial` until the mirror is complete.
  const hostState = await readHostState(env);
  const previousIndexForHosts = await readIndexObject(env);
  const previousRecords = new Map();
  for (const record of (previousIndexForHosts && Array.isArray(previousIndexForHosts.packages)
    ? previousIndexForHosts.packages : [])) {
    if (record && record.file) previousRecords.set(String(record.file), record);
  }
  let hostBudget = Number.isFinite(options.hostBatchFiles)
    ? Math.max(1, options.hostBatchFiles)
    : HOST_BATCH_FILES;
  let hostPending = 0;
  let hostTotal = 0;
  let hostDone = 0;
  for (const source of sources) {
    if (source.status !== 'host') continue;
    const prepared = prepareHostState(source, hostState, previousRecords);
    const entry = prepared.state;
    if (prepared.reused > 0) summary.skipped += prepared.reused;
    let savedSince = 0;
    while (entry.pending.length > 0 && hostBudget > 0) {
      const item = entry.pending[0];
      hostBudget -= 1;
      try {
        const record = await syncHostPackage(env, item, options);
        entry.pending.shift();
        entry.records.push({ ...record, source: source.repo });
        summary.uploaded += 1;
      } catch (error) {
        const message = (error && error.message) || String(error);
        entry.pending.shift();
        const attempts = Number((entry.failed || {})[item.file] || 0) + 1;
        if (!entry.failed) entry.failed = {};
        entry.failed[item.file] = attempts;
        if (attempts >= HOST_MAX_ATTEMPTS) {
          summary.failed.push(`${item.file} (${message})`);
        } else {
          entry.pending.push(item);
        }
      }
      // Persist progress regularly: an invocation that dies must not lose much
      // work, while saving after every single file costs an R2 round trip each.
      savedSince += 1;
      if (savedSince >= 3) {
        await writeHostState(env, hostState);
        savedSince = 0;
      }
      if (!options.skipLock) await touchSyncLock(env);
    }
    await writeHostState(env, hostState);
    source.host.records = entry.records;
    hostTotal += entry.total;
    hostDone += entry.records.length;
    hostPending += entry.pending.length;
  }
  if (hostPending > 0) {
    summary.status = 'partial';
    summary.progress = { done: hostDone, total: hostTotal, pending: hostPending };
    await recordLastSync(env, summary, options.trigger);
    return summary;
  }

  // Icons first (tiny, and the index below references them). First source wins
  // on duplicate icon names; the extra bundle fills the rest.
  const iconNames = new Set();
  const iconUploads = [];
  for (const source of sources) {
    if (!source.bundle) continue;
    const icons = source.bundle.icons && typeof source.bundle.icons === 'object' ? source.bundle.icons : {};
    for (const [key, encoded] of Object.entries(icons)) {
      if (!SAFE_KEY.test(key) || !key.startsWith('icons/')) continue;
      const name = key.slice('icons/'.length);
      if (iconNames.has(name)) continue;
      iconNames.add(name);
      iconUploads.push([key, encoded]);
    }
  }
  const extraIcons = extra && extra.icons && typeof extra.icons === 'object' ? extra.icons : {};
  for (const [key, encoded] of Object.entries(extraIcons)) {
    if (!SAFE_KEY.test(key) || !key.startsWith('icons/')) continue;
    const name = key.slice('icons/'.length);
    if (iconNames.has(name)) continue;
    iconNames.add(name);
    iconUploads.push([key, encoded]);
  }
  for (const [key, encoded] of iconUploads) {
    await env.BUCKET.put(`spk/${key}`, base64ToBytes(encoded), {
      // Icons are content-addressed by SPK filename and never rewritten in place.
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    });
    summary.uploaded += 1;
  }

  // Package blobs, streamed straight from each source's release CDN to R2.
  const packageFiles = new Set();
  const keptPackages = [];
  const claimed = new Set();

  // A source without a bundle (e.g. mid-release, index asset not uploaded yet)
  // keeps its previous records so pruning cannot delete a still-valid package.
  const missingSources = sources.filter((source) => source.status === 'no-bundle');
  if (missingSources.length > 0) {
    const previousIndex = await readIndexObject(env);
    const previousPackages = previousIndex && Array.isArray(previousIndex.packages) ? previousIndex.packages : [];
    for (const source of missingSources) {
      // Group by package name so every architecture of a carried package is
      // kept (a package owns all of its arch records).
      const carried = new Map();
      for (const record of previousPackages) {
        if (!record || record.source !== source.repo) continue;
        const name = String(record.package || '');
        if (name === '') continue;
        if (!carried.has(name)) carried.set(name, []);
        carried.get(name).push(record);
      }
      for (const [name, records] of carried) {
        if (claimed.has(name)) continue;
        claimed.add(name);
        for (const record of records) {
          packageFiles.add(String(record.file));
          keptPackages.push(record);
          for (const thumbnail of (Array.isArray(record.thumbnail) ? record.thumbnail : [])) {
            const icon = String(thumbnail).startsWith('icons/') ? String(thumbnail).slice('icons/'.length) : null;
            if (icon !== null) iconNames.add(icon);
          }
          summary.carried = (summary.carried || 0) + 1;
        }
      }
    }
  }
  for (const source of sources) {
    if (source.status === 'ok') {
      // Merge per package name so one source owns every arch of a package.
      const groups = new Map();
      for (const record of source.bundle.packages) {
        const name = record && typeof record === 'object' ? String(record.package || '') : '';
        if (name === '') {
          summary.missing.push(String((record && record.file) || '(missing package name)'));
          continue;
        }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(record);
      }
      for (const [name, records] of groups) {
        if (claimed.has(name)) continue;
        claimed.add(name);
        for (const record of records) {
          const file = String(record.file || '');
          if (!SAFE_FILE.test(file)) {
            summary.missing.push(file || '(invalid file name)');
            continue;
          }
          const size = await remoteSize(env, source.repo, file);
          if (size === null) {
            summary.missing.push(file);
            continue;
          }
          packageFiles.add(file);
          keptPackages.push({ ...record, source: source.repo });

          const key = `${PACKAGES_PREFIX}${file}`;
          const existing = await env.BUCKET.head(key);
          // `force` also rewrites objects (e.g. to refresh cache metadata).
          if (!options.force && existing !== null && existing !== undefined
              && size !== undefined && existing.size === size) {
            summary.skipped += 1;
            continue;
          }
          const download = await fetch(latestAssetUrl(source.repo, file), {
            headers: requestHeaders(env),
            redirect: 'follow',
          });
          if (!download.ok) throw new Error(`download ${file}: HTTP ${download.status}`);
          await putPackage(env, key, download.body, file);
          summary.uploaded += 1;
        }
      }
      continue;
    }
    if (source.status === 'host') {
      const records = Array.isArray(source.host.records) ? source.host.records : [];
      const hostGroups = new Map();
      for (const record of records) {
        const name = String(record.package);
        if (!hostGroups.has(name)) hostGroups.set(name, []);
        hostGroups.get(name).push(record);
        for (const path of [...record.thumbnail, ...record.snapshot]) {
          if (String(path).startsWith('icons/')) iconNames.add(String(path).slice('icons/'.length));
        }
        if (Array.isArray(record.thumbnail)
          && record.thumbnail.some((path) => String(path).startsWith('icons/_default_'))) {
          await ensureDefaultIcons(env);
          iconNames.add('_default_72.png');
          iconNames.add('_default_120.png');
        }
      }
      for (const [name, recordsForName] of hostGroups) {
        if (claimed.has(name)) continue;
        claimed.add(name);
        for (const record of recordsForName) {
          packageFiles.add(record.file);
          keptPackages.push(record);
        }
      }
      continue;
    }
    if (source.status !== 'auto') continue;

    // Bundle-less source: stream each SPK into R2, then read it back with range
    // requests to build the record (INFO, icons, md5 from the ETag).
    const autoRecords = [];
    for (const file of source.auto.files) {
      const size = await assetSize(env, source.repo, source.tag, file);
      if (size === null) {
        summary.missing.push(file);
        continue;
      }
      const key = `${PACKAGES_PREFIX}${file}`;
      const existing = await env.BUCKET.head(key);
      if (!options.force && existing !== null && existing !== undefined
          && size !== undefined && existing.size === size) {
        summary.skipped += 1;
      } else {
        const download = await fetch(latestAssetUrl(source.repo, file), {
          headers: requestHeaders(env),
          redirect: 'follow',
        });
        if (!download.ok) throw new Error(`download ${file}: HTTP ${download.status}`);
        await putPackage(env, key, download.body, file);
        summary.uploaded += 1;
      }
      const head = await env.BUCKET.head(key);
      if (head === null || head === undefined) {
        summary.missing.push(file);
        continue;
      }
      const md5 = md5FromEtag(head.httpEtag);
      if (md5 === null) {
        summary.missing.push(`${file} (etag is not an md5)`);
        continue;
      }
      try {
        const parts = await readSpkParts(env, key);
        const record = await buildRecord(env, { file, parts, size: head.size, md5 });
        autoRecords.push({ ...record, source: source.repo });
        for (const path of [...record.thumbnail, ...record.snapshot]) {
          if (String(path).startsWith('icons/')) iconNames.add(String(path).slice('icons/'.length));
        }
        if (record.thumbnail.some((path) => String(path).startsWith('icons/_default_'))) {
          await ensureDefaultIcons(env);
          iconNames.add('_default_72.png');
          iconNames.add('_default_120.png');
        }
      } catch (error) {
        summary.missing.push(`${file} (${(error && error.message) || error})`);
      }
    }
    const autoGroups = new Map();
    for (const record of autoRecords) {
      const name = String(record.package);
      if (!autoGroups.has(name)) autoGroups.set(name, []);
      autoGroups.get(name).push(record);
    }
    for (const [name, records] of autoGroups) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      for (const record of records) {
        packageFiles.add(record.file);
        keptPackages.push(record);
      }
    }
  }

  // Extra packages: blobs were uploaded by tools/add-extra.py, so just verify
  // they exist and keep them in the index. Release packages win on name clashes.
  for (const record of (extra ? extra.packages : [])) {
    const file = record && typeof record === 'object' ? String(record.file || '') : '';
    if (!SAFE_FILE.test(file)) continue;
    if (claimed.has(String(record.package))) continue;
    const head = await env.BUCKET.head(`${PACKAGES_PREFIX}${file}`);
    if (head === null || head === undefined) {
      summary.missing.push(`${file} (extra)`);
      continue;
    }
    packageFiles.add(file);
    keptPackages.push(record);
    claimed.add(String(record.package));
  }

  // Publish the index last so a client never sees metadata for a missing blob.
  const index = {
    schema: 1,
    generated_at: sources.map((source) => (source.bundle ? source.bundle.generated_at : null)).find(Boolean) || null,
    base_url: null,
    defaults: (sources.map((source) => (source.bundle ? source.bundle.defaults : null)).find((value) => value && typeof value === 'object')) || {},
    packages: keptPackages,
    repo: summary.repo,
    tag: summary.tag,
    sources: sources.map((source) => ({ repo: source.repo, tag: source.tag, status: source.status })),
  };
  await env.BUCKET.put(INDEX_KEY, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });

  // Remove objects from older releases (the index never points at them).
  summary.deleted += await prunePrefix(env, PACKAGES_PREFIX, packageFiles);
  summary.deleted += await prunePrefix(env, ICONS_PREFIX, iconNames);

  // Marker last. With missing assets (e.g. the second arch is still uploading)
  // the marker is NOT written, so the next cron tick retries and completes the
  // index once the Release has every SPK.
  if (summary.missing.length === 0) {
    await env.BUCKET.put(MARKER_KEY, markerValue, {
      httpMetadata: { contentType: 'text/plain', cacheControl: 'no-store' },
    });
    summary.status = 'synced';
    for (const source of sources) {
      if (source.status === 'host') delete hostState.sources[source.repo];
    }
    await writeHostState(env, hostState);
  } else {
    summary.status = 'partial';
  }
  await recordLastSync(env, summary, options.trigger);
  return summary;
  } finally {
    if (!options.skipLock) {
      try {
        await env.BUCKET.delete(SYNC_LOCK_KEY);
      } catch {
        // a failed unlock must not mask the sync result
      }
    }
  }
}

/** Observable state for /health and for checking that the cron actually ran. */
export async function recordLastSync(env, summary, trigger = 'cron') {
  const record = {
    at: new Date().toISOString(),
    trigger,
    status: summary.status,
    tag: summary.tag ?? null,
    repo: summary.repo ?? null,
    uploaded: summary.uploaded ?? 0,
    skipped: summary.skipped ?? 0,
    deleted: summary.deleted ?? 0,
    missing: summary.missing ?? [],
    sources: summary.sources ?? [],
    carried: summary.carried ?? 0,
    progress: summary.progress ?? null,
    failed: summary.failed ?? null,
    error: summary.error ?? null,
  };
  await env.BUCKET.put(LAST_SYNC_KEY, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  return record;
}

export async function readLastSync(env) {
  const object = await env.BUCKET.get(LAST_SYNC_KEY);
  if (object === null || object === undefined) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}
