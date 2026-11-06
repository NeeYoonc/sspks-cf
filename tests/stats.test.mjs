// Tests for the D1-backed download counters.
//
// Run: node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDownloadCounts,
  readDownloadCounts,
  recordDownload,
  resetCountsCache,
} from '../src/stats.js';
import { MockDB } from './mock_env.mjs';

afterEach(() => resetCountsCache());

test('recordDownload increments per package and readDownloadCounts aggregates', async () => {
  const db = new MockDB();
  const env = { DB: db };

  assert.equal(await recordDownload(env, 'DeepSeekHarness-NAS', 'Pkg-1.0-1.spk'), true);
  assert.equal(await recordDownload(env, 'DeepSeekHarness-NAS', 'Pkg-1.0-1.spk'), true);
  assert.equal(await recordDownload(env, 'OtherPkg', 'Other-1.0-1.spk'), true);

  const counts = await readDownloadCounts(env);
  assert.deepEqual(counts.get('DeepSeekHarness-NAS'), { total: 2, recent: 2 });
  assert.deepEqual(counts.get('OtherPkg'), { total: 1, recent: 1 });
  assert.equal(counts.size, 2);
});

test('counters survive a version bump because they are keyed by package name', async () => {
  const db = new MockDB();
  const env = { DB: db };
  await recordDownload(env, 'DeepSeekHarness-NAS', 'Pkg-0.2.2-rc.1.spk');
  await recordDownload(env, 'DeepSeekHarness-NAS', 'Pkg-0.2.3.spk');
  const counts = await readDownloadCounts(env);
  assert.equal(counts.get('DeepSeekHarness-NAS').total, 2);
});

test('reads are cached per isolate and invalidated by a new download', async () => {
  const db = new MockDB();
  const env = { DB: db };
  await recordDownload(env, 'Pkg', 'Pkg-1.0-1.spk');

  await readDownloadCounts(env);
  const selectsAfterFirst = db.calls.filter((call) => call.sql.startsWith('SELECT')).length;
  await readDownloadCounts(env); // served from the in-isolate cache
  assert.equal(db.calls.filter((call) => call.sql.startsWith('SELECT')).length, selectsAfterFirst);

  await recordDownload(env, 'Pkg', 'Pkg-1.0-1.spk');
  const counts = await readDownloadCounts(env);
  assert.equal(counts.get('Pkg').total, 2, 'cache must be invalidated after a write');
});

test('applyDownloadCounts merges counters into records without mutating them', () => {
  const records = [
    { package: 'A', file: 'A-1.0-1.spk' },
    { package: 'B', file: 'B-1.0-1.spk' },
  ];
  const merged = applyDownloadCounts(records, new Map([
    ['A', { total: 7, recent: 3 }],
  ]));
  assert.deepEqual(merged[0], { package: 'A', file: 'A-1.0-1.spk', download_count: 7, recent_download_count: 3 });
  assert.deepEqual(merged[1], { package: 'B', file: 'B-1.0-1.spk' });
  assert.equal(records[0].download_count, undefined, 'input records must not be mutated');
});

test('missing DB binding degrades gracefully', async () => {
  assert.equal(await readDownloadCounts({}), null);
  assert.equal(await recordDownload({}, 'Pkg', 'Pkg-1.0-1.spk'), false);
  assert.deepEqual(applyDownloadCounts([{ package: 'A' }], null), [{ package: 'A' }]);
});
