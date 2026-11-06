// In-memory R2 bucket used by the Worker tests (no wrangler / miniflare needed).

import { createHash } from 'node:crypto';

export class MockBucket {
  constructor() {
    this.objects = new Map();
  }

  /** Accepts Uint8Array / ArrayBuffer / string / ReadableStream. */
  put(key, value, options = {}) {
    const contentType = typeof options === 'string'
      ? options
      : (options?.httpMetadata?.contentType || 'application/octet-stream');
    if (value && typeof value.getReader === 'function') {
      return (async () => {
        this.objects.set(key, { bytes: await toBytes(value), contentType });
      })();
    }
    this.objects.set(key, { bytes: toBytesSync(value), contentType });
    return undefined;
  }

  async get(key, options) {
    const entry = this.objects.get(key);
    if (entry === undefined) return null;
    let bytes = entry.bytes;
    if (options && options.range) {
      const offset = options.range.offset ?? 0;
      const length = options.range.length ?? (bytes.byteLength - offset);
      bytes = entry.bytes.subarray(offset, offset + length);
    }
    return this.#object(entry, bytes);
  }

  async head(key) {
    const entry = this.objects.get(key);
    if (entry === undefined) return null;
    return {
      size: entry.bytes.byteLength,
      // R2 exposes the MD5 as ETag for single-part uploads; the bundle-less
      // indexer relies on that.
      httpEtag: `"${md5Hex(entry.bytes)}"`,
      httpMetadata: { contentType: entry.contentType },
    };
  }

  async delete(key) {
    return this.objects.delete(key);
  }

  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? keys.indexOf(cursor) + 1 : 0;
    const page = keys.slice(start, start + limit);
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key).bytes.byteLength })),
      truncated: start + limit < keys.length,
      cursor: page.length > 0 ? page[page.length - 1] : undefined,
    };
  }

  createMultipartUpload(key, options = {}) {
    const bucket = this;
    const contentType = options?.httpMetadata?.contentType || 'application/octet-stream';
    const parts = new Map();
    return {
      key,
      async uploadPart(partNumber, value) {
        const bytes = await toBytes(value);
        parts.set(Number(partNumber), bytes);
        return { partNumber: Number(partNumber), etag: md5Hex(bytes) };
      },
      async complete(uploadedParts) {
        const ordered = [...parts.entries()].sort((left, right) => left[0] - right[0]).map(([, bytes]) => bytes);
        const total = ordered.reduce((sum, bytes) => sum + bytes.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const bytes of ordered) {
          merged.set(bytes, offset);
          offset += bytes.byteLength;
        }
        bucket.objects.set(key, { bytes: merged, contentType });
        return { key, size: total, etag: md5Hex(merged) };
      },
      async abort() {
        parts.clear();
      },
    };
  }

  #object(entry, bytes) {
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength,
      httpEtag: `"${md5Hex(bytes)}"`,
      httpMetadata: { contentType: entry.contentType },
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(entry.bytes),
    };
  }
}

function md5Hex(bytes) {
  return createHash('md5').update(Buffer.from(bytes)).digest('hex');
}

function toBytesSync(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('unsupported bucket value');
}

async function toBytes(value) {
  if (!(value && typeof value.getReader === 'function')) return toBytesSync(value);
  const reader = value.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}


/** Minimal Cache API stand-in for the Worker's edge-cache code path. */
export class MockCache {
  constructor() {
    this.entries = new Map();
  }

  async match(key) {
    const entry = this.entries.get(key.url);
    if (entry === undefined) return null;
    return new Response(entry.body.slice(), { status: 200, headers: entry.headers });
  }

  async put(key, response) {
    const body = new Uint8Array(await response.arrayBuffer());
    this.entries.set(key.url, { body, headers: Object.fromEntries(response.headers) });
  }
}


/** Minimal D1 stand-in for src/stats.js (only the two queries it issues). */
export class MockDB {
  constructor() {
    this.rows = new Map(); // "package|day" -> { package, file, day, count, updated_at }
    this.calls = [];
  }

  prepare(sql) {
    const db = this;
    const statement = {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async run() {
        db.calls.push({ sql, args: this.args });
        if (sql.startsWith('INSERT INTO downloads')) {
          const [packageName, file, day, updatedAt] = this.args;
          const key = `${packageName}|${day}`;
          const row = db.rows.get(key) || { package: packageName, file, day, count: 0, updated_at: updatedAt };
          row.count += 1;
          row.file = file;
          row.updated_at = updatedAt;
          db.rows.set(key, row);
        }
        return { success: true };
      },
      async all() {
        db.calls.push({ sql, args: this.args });
        const since = this.args[0];
        const grouped = new Map();
        for (const row of db.rows.values()) {
          const entry = grouped.get(row.package) || { total: 0, recent: 0 };
          entry.total += row.count;
          if (row.day >= since) entry.recent += row.count;
          grouped.set(row.package, entry);
        }
        return {
          results: [...grouped.entries()].map(([packageName, value]) => ({
            package: packageName,
            total: value.total,
            recent: value.recent,
          })),
        };
      },
    };
    return statement;
  }
}
