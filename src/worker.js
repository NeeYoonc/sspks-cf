// Cloudflare Worker that turns a static index in R2 into a Synology DSM 7
// Package Center source.
//
// Routes
//   GET /?unique=synology_<arch>_<model>&arch=...&major=..&minor=..&build=..
//        &package_update_channel=stable|beta&language=xx      → Package Center JSON
//   GET /packages/<file>.spk                                 → SPK download (R2)
//   GET /icons/<key>.png                                     → package icon (R2)
//   GET /                                                    → HTML package list
//   GET /health                                              → index status
//   GET /sync   (header x-sync-token)                        → manual release sync
//
// Object layout in the bucket (produced by tools/index.py, refreshed by the
// scheduled handler pulling the latest dsh-nas release):
//   spk/index.json
//   spk/icons/<...>.png
//   spk/packages/<file>.spk
//   spk/.synced-release

import { encodePackages } from './response.js';
import { selectPackages } from './filter.js';
import { renderIndex } from './html.js';
import { isKnownArchitecture } from './models.js';
import { latestAssetUrl, readLastSync, recordLastSync, syncFromGithub } from './sync.js';
import { applyDownloadCounts, readDownloadCounts, recordDownload } from './stats.js';

const INDEX_KEY = 'spk/index.json';
const INDEX_TTL_MS = 60_000; // 1 minute: the cron sync runs every 5 minutes
const ICON_CACHE_LIMIT = 256;
const DEFAULT_ICON_72 = 'icons/_default_72.png';
const DEFAULT_ICON_120 = 'icons/_default_120.png';
const DEFAULT_REPO = 'NeeYoonc/dsh-nas';

/** Per-binding caches: isolates are reused for many requests. */
const indexCacheByEnv = new WeakMap();
/** Icons are immutable per key; a bounded map keeps hot icons in memory. */
const iconCacheByEnv = new WeakMap();

function indexCacheFor(env) {
  let state = indexCacheByEnv.get(env);
  if (state === undefined) {
    state = { at: 0, value: null };
    indexCacheByEnv.set(env, state);
  }
  return state;
}

function edgeCacheFor(env) {
  if (env && env.CACHE) return env.CACHE;
  if (typeof caches !== 'undefined' && caches.default) return caches.default;
  return null;
}

function iconCacheFor(env) {
  let state = iconCacheByEnv.get(env);
  if (state === undefined) {
    state = new Map();
    iconCacheByEnv.set(env, state);
  }
  return state;
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function textResponse(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function notFound() {
  return textResponse(404, 'Not Found\n');
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function normaliseBase(value) {
  const trimmed = String(value || '').trim();
  return trimmed === '' ? '' : trimmed.replace(/\/+$/, '') + '/';
}

function baseUrlFor(request, env) {
  const configured = normaliseBase(env.BASE_URL);
  if (configured !== '') return configured;
  return new URL(request.url).origin + '/';
}

async function loadIndex(env, { fresh = false } = {}) {
  const cache = indexCacheFor(env);
  const now = Date.now();
  if (!fresh && cache.value !== null && now - cache.at < INDEX_TTL_MS) {
    return cache.value;
  }
  let object;
  try {
    object = await env.BUCKET.get(INDEX_KEY);
  } catch {
    return cache.value;
  }
  if (object === null || object === undefined) return null;
  try {
    const parsed = JSON.parse(await object.text());
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.packages)) {
      return null;
    }
    cache.value = parsed;
    cache.at = now;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Package Center request validation — port of SynologyHandler::handle()
// ---------------------------------------------------------------------------

function queryValue(searchParams, name, fallback = '') {
  return searchParams.has(name) ? searchParams.get(name) : fallback;
}

function parsePackageCenterQuery(searchParams) {
  let unique = queryValue(searchParams, 'unique');
  const arch = queryValue(searchParams, 'arch').trim();
  const major = queryValue(searchParams, 'major').trim();
  const minor = queryValue(searchParams, 'minor').trim();
  const build = queryValue(searchParams, 'build').trim();
  const channel = queryValue(searchParams, 'package_update_channel', 'stable').trim();
  const language = queryValue(searchParams, 'language').trim();

  // $_GET decodes `+` to a space; the model name in `unique` may legitimately
  // contain a plus sign (DS918+), so restore it like the PHP handler does.
  unique = unique.replace(/ /g, '+').trim();

  if (unique.length > 200
    || !/^synology_[a-z0-9_]+_[a-z0-9+._-]+$/i.test(unique)
    || arch.length > 64
    || !/^[a-z0-9_]+$/i.test(arch)
    || !unique.toLowerCase().startsWith(`synology_${arch.toLowerCase()}_`)
    || !/^\d{1,2}$/.test(major)
    || Number(major) < 7
    || !/^\d{1,3}$/.test(minor)
    || !/^\d{1,10}$/.test(build)
    || (build.replace(/^0+/, '').length === 10 && build.replace(/^0+/, '') > '2147483647')
    || (channel !== 'stable' && channel !== 'beta')
    || (language !== '' && !/^[a-z]{3}$/i.test(language))) {
    return null;
  }

  const normalizedArch = arch.toLowerCase();
  if (!isKnownArchitecture(normalizedArch)) return null;

  return {
    unique: unique.toLowerCase(),
    arch: normalizedArch,
    channel,
    language: language.toLowerCase(),
    firmwareVersion: `${major}.${minor}-${build}`,
  };
}

async function handlePackageCenter(request, env, url) {
  const query = parsePackageCenterQuery(url.searchParams);
  if (query === null) {
    return jsonResponse(400, { error: 'Invalid Package Center request' }, { 'Cache-Control': 'no-store' });
  }

  const index = await loadIndex(env);
  if (index === null) {
    // Keep the payload shape DSM understands; the status code still signals a
    // server-side problem to humans and monitoring.
    return jsonResponse(503, '{"packages":[]}', { 'Cache-Control': 'no-store' });
  }

  const baseUrl = baseUrlFor(request, env);
  // SPK downloads can live on an R2 custom domain (edge-cached, no Worker hop);
  // icons/metadata stay on the Worker origin.
  const packageBaseUrl = normaliseBase(env.SPK_BASE_URL) || baseUrl;
  const defaults = index.defaults && typeof index.defaults === 'object' ? index.defaults : {};

  let records = selectPackages(index.packages, query);
  try {
    records = applyDownloadCounts(records, await readDownloadCounts(env));
  } catch (error) {
    console.error('[sspks-cf] download counters unavailable', error && error.message ? error.message : error);
  }

  // DSM 7 Package Center does not use the `beta` field.
  const body = encodePackages(records, {
    language: query.language,
    baseUrl,
    packageBaseUrl,
    defaults,
    hideKeys: ['beta'],
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ---------------------------------------------------------------------------
// Object serving (spk + icons) with ETag, HEAD and single-range support
// ---------------------------------------------------------------------------

function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  return ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag || candidate.trim() === '*');
}

function objectHeaders(size, etag, { contentType, cacheControl, contentDisposition }) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  };
  if (etag) headers.ETag = etag;
  if (contentDisposition) headers['Content-Disposition'] = contentDisposition;
  return headers;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (match === null) return null; // not a single byte range → ignore
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  let end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function serveObject(request, env, key, options) {
  if (request.method === 'HEAD') {
    const head = await env.BUCKET.head(key);
    if (head === null || head === undefined) return notFound();
    const etag = head.httpEtag || '';
    return new Response(null, { status: 200, headers: objectHeaders(head.size, etag, options) });
  }

  const rangeHeader = request.headers.get('range');
  if (rangeHeader !== null && rangeHeader.trim() !== '') {
    const head = await env.BUCKET.head(key);
    if (head === null || head === undefined) return notFound();
    const range = parseRange(rangeHeader, head.size);
    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    if (range !== null) {
      const object = await env.BUCKET.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
      if (object === null || object === undefined) return notFound();
      const headers = objectHeaders(range.end - range.start + 1, head.httpEtag, options);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${head.size}`;
      return new Response(object.body, { status: 206, headers });
    }
  }

  const object = await env.BUCKET.get(key);
  if (object === null || object === undefined) return notFound();
  const etag = object.httpEtag || '';
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(object.body, { status: 200, headers: objectHeaders(object.size, etag, options) });
}

/**
 * Fallback while R2 is still being filled (or if an object went missing):
 * proxy the release asset straight from GitHub. Keep it for GET only; DSM
 * downloads with GET and never asks for ranges against this fallback.
 */
async function proxyPackageFromGithub(request, env, name) {
  if (request.method !== 'GET') return notFound();
  const index = await loadIndex(env);
  // Only indexes produced by the release sync know which release to fall back to.
  if (!index || !index.tag) return notFound();
  const record = Array.isArray(index.packages)
    ? index.packages.find((item) => item && item.file === name)
    : null;
  const repo = String((record && record.source) || index.repo || env.DSH_REPO || DEFAULT_REPO);

  const headers = { 'User-Agent': 'sspks-cf-worker' };
  const token = String(env.GH_TOKEN || '').trim();
  if (token !== '') headers.Authorization = `Bearer ${token}`;

  const upstream = await fetch(latestAssetUrl(repo, name), { headers, redirect: 'follow' });
  if (!upstream.ok) return notFound();

  const responseHeaders = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(name),
  };
  const length = upstream.headers.get('content-length');
  if (length !== null) responseHeaders['Content-Length'] = length;
  return new Response(upstream.body, { status: 200, headers: responseHeaders });
}

/**
 * Count one download (fire-and-forget). Keyed by package name so a version bump
 * keeps the counter on the same package.
 */
async function countSpkDownload(env, ctx, file) {
  if (!env || !env.DB) return;
  const task = (async () => {
    const index = await loadIndex(env);
    const record = index && Array.isArray(index.packages)
      ? index.packages.find((item) => item && item.file === file)
      : null;
    const packageName = record && record.package ? String(record.package) : file.replace(/\.spk$/i, '');
    await recordDownload(env, packageName, file);
  })().catch((error) => {
    console.error('[sspks-cf] download counter failed', error && error.message ? error.message : error);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

async function handleSpk(request, env, ctx, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound();
  }
  // Legacy links used "<file>.spk.bin" while the cacheable-extension trick was in
  // place; strip the suffix so those links keep working.
  if (/\.spk\.bin$/i.test(name)) name = name.slice(0, -'.bin'.length);
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..') || !/\.spk$/i.test(name)) {
    return notFound();
  }

  const key = `spk/packages/${name}`;
  const options = {
    contentType: 'application/octet-stream',
    cacheControl: 'public, max-age=2592000, immutable',
    contentDisposition: contentDisposition(name),
  };

  // Edge cache via the Cache API: keeps the public URL a plain ".spk" (no Cache
  // Rule / dashboard step needed). Range requests stay on the R2 path so resume
  // works exactly as before.
  const cache = edgeCacheFor(env);
  const cacheable = cache !== null && request.method === 'GET' && !request.headers.has('range');
  const cacheKey = cacheable ? new Request(request.url, { method: 'GET' }) : null;

  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit !== undefined && hit !== null) {
      const headers = new Headers(hit.headers);
      headers.set('x-cache', 'HIT');
      await countSpkDownload(env, ctx, name);
      return new Response(hit.body, { status: 200, headers });
    }
  }

  const response = await serveObject(request, env, key, options);
  if (response.status === 404) {
    const proxied = await proxyPackageFromGithub(request, env, name);
    if (proxied.status === 200 && request.method === 'GET') await countSpkDownload(env, ctx, name);
    return proxied;
  }
  if (response.status === 200 && request.method === 'GET') await countSpkDownload(env, ctx, name);
  if (!cacheable || response.status !== 200) return response;

  // Serve the client from R2 while filling the edge cache from a second read in
  // the background (avoids tee-buffering a 171 MB body in the isolate).
  const headers = new Headers(response.headers);
  headers.set('x-cache', 'MISS');
  headers.set('Cache-Control', 'public, max-age=2592000, immutable');
  const clientResponse = new Response(response.body, { status: 200, headers });

  const fill = (async () => {
    const object = await env.BUCKET.get(key);
    if (object === null || object === undefined) return;
    await cache.put(cacheKey, new Response(object.body, {
      status: 200,
      headers: objectHeaders(object.size, object.httpEtag || '', options),
    }));
  })();
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(fill.catch(() => {}));
  } else {
    await fill.catch(() => {});
  }
  return clientResponse;
}

async function handleIcon(request, env, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound();
  }
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return notFound();
  }

  const iconCache = iconCacheFor(env);
  const cached = iconCache.get(name);
  if (cached !== undefined) {
    return new Response(request.method === 'HEAD' ? null : cached.bytes, {
      status: 200,
      headers: objectHeaders(cached.bytes.byteLength, '', {
        contentType: cached.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      }),
    });
  }

  const object = await env.BUCKET.get(`spk/icons/${name}`);
  if (object === null || object === undefined) return notFound();
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType || 'image/png';

  if (iconCache.size >= ICON_CACHE_LIMIT) {
    const oldest = iconCache.keys().next();
    if (!oldest.done) iconCache.delete(oldest.value);
  }
  iconCache.set(name, { bytes, contentType });

  return new Response(request.method === 'HEAD' ? null : bytes, {
    status: 200,
    headers: objectHeaders(bytes.byteLength, '', {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    }),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function handle(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse(405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/' || path === '/index.php') {
    if (url.searchParams.has('unique')) return handlePackageCenter(request, env, url);
    const index = await loadIndex(env);
    if (index === null) {
      return textResponse(503, '索引尚未上传：请先运行 python tools/index.py --upload\n', { 'Cache-Control': 'no-store' });
    }
    let landingRecords = index.packages;
    try {
      landingRecords = applyDownloadCounts(landingRecords, await readDownloadCounts(env));
    } catch (error) {
      console.error('[sspks-cf] download counters unavailable', error && error.message ? error.message : error);
    }
    const composed = { ...index };
    // Fill in default icons so cards without an extracted icon still render.
    composed.packages = landingRecords.map((record) => {
      if (Array.isArray(record.thumbnail) && record.thumbnail.length >= 2) return record;
      return { ...record, thumbnail: [DEFAULT_ICON_72, DEFAULT_ICON_120] };
    });
    return htmlResponse(renderIndex(composed, baseUrlFor(request, env), { name: env.SITE_NAME }));
  }

  if (path === '/health') {
    const index = await loadIndex(env, { fresh: true });
    if (index === null) {
      return jsonResponse(503, { ok: false, error: 'index missing' }, { 'Cache-Control': 'no-store' });
    }
    const lastSync = await readLastSync(env);
    return jsonResponse(
      200,
      {
        ok: true,
        packages: index.packages.length,
        generated_at: index.generated_at ?? null,
        release: index.tag ?? null,
        repo: index.repo ?? null,
        sources: index.sources ?? null,
        last_sync: lastSync,
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  if (path === '/sync' || path === '/sync/') {
    const provided = request.headers.get('x-sync-token') || url.searchParams.get('token') || '';
    if (!env.SYNC_TOKEN || provided === '' || !constantTimeEqual(provided, env.SYNC_TOKEN)) {
      return jsonResponse(403, { error: 'forbidden' }, { 'Cache-Control': 'no-store' });
    }
    try {
      const force = url.searchParams.get('force') === '1' || request.headers.get('x-sync-force') === '1';
      const summary = await syncFromGithub(env, { force, trigger: 'manual' });
      indexCacheFor(env).value = null;
      return jsonResponse(200, summary, { 'Cache-Control': 'no-store' });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error('[sspks-cf] manual sync failed', message);
      return jsonResponse(500, { status: 'error', error: message }, { 'Cache-Control': 'no-store' });
    }
  }

  if (path === '/robots.txt') {
    return textResponse(200, 'User-agent: *\nDisallow: /\n', { 'Cache-Control': 'public, max-age=86400' });
  }

  if (path === '/favicon.ico') {
    return new Response(null, { status: 204 });
  }

  if (path.startsWith('/packages/')) {
    return handleSpk(request, env, ctx, path.slice('/packages/'.length));
  }

  if (path.startsWith('/icons/')) {
    return handleIcon(request, env, path.slice('/icons/'.length));
  }

  return notFound();
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('[sspks-cf] request failed', error && error.stack ? error.stack : error);
      return textResponse(500, 'Internal Server Error\n');
    }
  },

  // Cron Trigger: pull the latest dsh-nas release into R2 (see src/sync.js).
  async scheduled(event, env) {
    try {
      const summary = await syncFromGithub(env, { trigger: 'cron' });
      indexCacheFor(env).value = null;
      console.log('[sspks-cf] scheduled sync', JSON.stringify(summary));
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error('[sspks-cf] scheduled sync failed', message);
      try {
        await recordLastSync(env, { status: 'error', tag: null, repo: env.DSH_REPO || null, error: message }, 'cron');
      } catch {
        // observability write failure must not mask the original error
      }
    }
  },
};
