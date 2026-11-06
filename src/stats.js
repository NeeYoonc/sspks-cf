// Download counters backed by D1 (see migrations/0001_downloads.sql).
//
// Counters are keyed by package name + UTC day, so a version bump (new SPK file
// name) keeps accumulating on the same package. Reads are cached per isolate for
// a minute to keep the Package Center path cheap.

const CACHE_TTL_MS = 60_000;
const RECENT_DAYS = 30;

let countsCache = { at: 0, value: null };

export function resetCountsCache() {
  countsCache = { at: 0, value: null };
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {object} env worker env (DB binding optional)
 * @returns {Promise<Map<string, {total: number, recent: number}>|null>}
 */
export async function readDownloadCounts(env) {
  if (!env || !env.DB) return null;
  const now = Date.now();
  if (countsCache.value !== null && now - countsCache.at < CACHE_TTL_MS) {
    return countsCache.value;
  }
  const since = new Date(now - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    'SELECT package, SUM(count) AS total, '
    + 'SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS recent '
    + 'FROM downloads GROUP BY package',
  ).bind(since).all();

  const counts = new Map();
  for (const row of (result && result.results) || []) {
    counts.set(String(row.package), {
      total: Number(row.total) || 0,
      recent: Number(row.recent) || 0,
    });
  }
  countsCache = { at: now, value: counts };
  return counts;
}

/** Increment one download. Safe to call from ctx.waitUntil(). */
export async function recordDownload(env, packageName, file) {
  if (!env || !env.DB || !packageName) return false;
  const now = new Date();
  await env.DB.prepare(
    'INSERT INTO downloads (package, file, day, count, updated_at) VALUES (?, ?, ?, 1, ?) '
    + 'ON CONFLICT(package, day) DO UPDATE SET count = count + 1, '
    + 'file = excluded.file, updated_at = excluded.updated_at',
  ).bind(packageName, file, utcDay(now), now.toISOString()).run();
  countsCache = { at: 0, value: null };
  return true;
}

/** Merge counters into index records (mutates nothing, returns new records). */
export function applyDownloadCounts(records, counts) {
  if (!counts || counts.size === 0) return records;
  return records.map((record) => {
    const hit = counts.get(String(record.package));
    if (!hit) return record;
    return { ...record, download_count: hit.total, recent_download_count: hit.recent };
  });
}
