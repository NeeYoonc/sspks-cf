// Minimal landing page. The Workers build deliberately has no admin UI — the
// index is produced offline by tools/index.py — but a human-readable package
// list is still useful for checking a deployment.

import { comparePackageVersions, isDsm7Package } from './filter.js';

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function latestByName(records) {
  const latest = new Map();
  for (const record of records) {
    if (!isDsm7Package(record)) continue;
    const name = String(record.package);
    const current = latest.get(name);
    if (current === undefined || comparePackageVersions(record.version, current.version) > 0) {
      latest.set(name, record);
    }
  }
  return [...latest.values()].sort((left, right) => String(left.package).localeCompare(String(right.package)));
}

function archBadges(record) {
  const architectures = Array.isArray(record.arch) ? record.arch : [];
  return architectures
    .map((arch) => `<span class="badge">${escapeHtml(arch)}</span>`)
    .join('');
}

function card(record, baseUrl) {
  const name = escapeHtml(record.displayname || record.package);
  const description = escapeHtml(record.description_chs || record.description || '');
  const version = escapeHtml(record.version);
  const link = `${baseUrl}packages/${encodeURIComponent(record.file)}`;
  const icon = Array.isArray(record.thumbnail) && record.thumbnail.length > 0
    ? `${baseUrl}${String(record.thumbnail[0]).split('/').map(encodeURIComponent).join('/')}`
    : '';
  const beta = record.beta ? '<span class="badge badge-beta">beta</span>' : '';
  const official = record.official ? '<span class="badge badge-official">官方签名</span>' : '';
  const downloads = Number(record.download_count) > 0
    ? `<span class="downloads">${Number(record.download_count).toLocaleString('zh-CN')} 次下载</span>`
    : '';
  // Lowercase haystack for the client-side search box (name, description,
  // version, architectures and file name all match).
  const searchText = [
    record.package,
    record.displayname,
    record.description_chs || record.description,
    record.version,
    ...(Array.isArray(record.arch) ? record.arch : []),
    record.file,
  ].filter(Boolean).join(' ').toLowerCase();

  return `<article class="card" data-search="${escapeHtml(searchText)}">
  <div class="card-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" width="72" height="72" loading="lazy">` : ''}</div>
  <div class="card-body">
    <h3>${name} <span class="version">${version}</span> ${beta}${official}</h3>
    <p>${description}</p>
    <div class="meta">${archBadges(record)}<span class="size">${formatSize(record.filesize)}</span>${downloads}</div>
    <a class="download" href="${escapeHtml(link)}" download>下载 .spk</a>
  </div>
</article>`;
}

/**
 * Render the landing page.
 * @param {{packages: object[], generated_at?: string, defaults?: object}} index
 * @param {string} baseUrl absolute URL ending in `/`
 * @param {{name?: string}} options
 */
export function renderIndex(index, baseUrl, options = {}) {
  const siteName = options.name || 'SPK 套件源';
  const records = latestByName(Array.isArray(index.packages) ? index.packages : []);
  const total = records.length;

  const cards = records.length > 0
    ? records.map((record) => card(record, baseUrl)).join('\n')
    : '<p class="empty">索引里还没有套件。把 .spk 放进 packages/ 后重新运行 <code>python tools/index.py</code>。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(siteName)}</title>
<style>
:root { color-scheme: light dark; --bg:#f7f8fa; --card:#fff; --text:#1d2433; --muted:#667085; --line:#e4e7ec; --accent:#0f766e; }
@media (prefers-color-scheme: dark) { :root { --bg:#101418; --card:#171d24; --text:#e6e9ef; --muted:#93a0b4; --line:#25303b; --accent:#2dd4bf; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
.search { display:flex; gap:10px; align-items:center; margin: 0 0 20px; }
.search input { flex:1; min-width:0; padding:10px 14px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--text); font:inherit; outline:none; }
.search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15,118,110,.15); }
.search .hits { color:var(--muted); font-size:12px; white-space:nowrap; }
.card[hidden] { display:none; }
.source { background: var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:24px; }
.source code { display:block; margin-top:6px; padding:8px 10px; background: rgba(127,127,127,.12); border-radius:6px; word-break:break-all; font-size:13px; }
.grid { display:grid; gap:14px; grid-template-columns: repeat(auto-fill,minmax(300px,1fr)); }
.card { display:flex; gap:14px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
.card-icon img { border-radius:10px; display:block; }
.card-body { min-width:0; }
.card h3 { margin:0 0 6px; font-size:15px; }
.card .version { color:var(--muted); font-weight:400; font-size:13px; }
.card p { margin:0 0 10px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.meta { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:10px; }
.badge { font-size:11px; padding:1px 7px; border-radius:999px; background: rgba(127,127,127,.15); color:var(--muted); }
.badge-beta { color:#b45309; background: rgba(180,83,9,.12); }
.badge-official { color:var(--accent); background: rgba(15,118,110,.12); }
.size, .downloads { font-size:12px; color:var(--muted); }
.download { font-size:13px; color:var(--accent); text-decoration:none; }
.download:hover { text-decoration:underline; }
.footer { margin-top:32px; color:var(--muted); font-size:12px; }
.empty { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(siteName)}</h1>
  <p class="sub">共 ${total} 个套件</p>
  <div class="search">
    <input id="q" type="search" placeholder="搜索套件（名称 / 描述 / 版本）" autocomplete="off" spellcheck="false" aria-label="搜索套件">
    <span class="hits" id="hits"></span>
  </div>
  <div class="source">
    <strong>群晖套件中心 → 设置 → 套件来源 → 新增</strong>
    <span style="color:var(--muted);font-size:13px">（名称任意，位置填下面这个地址）</span>
    <code>${escapeHtml(baseUrl)}</code>
  </div>
  <div class="grid">
${cards}
  </div>
  <p class="empty" id="no-match" hidden>没有匹配的套件。</p>
  <p class="footer">静态索引由 tools/index.py 生成，文件存放在 R2；本页面仅用于部署自检。DSM 7 套件中心请直接使用上面的来源地址。</p>
</main>
<script>
(() => {
  const input = document.getElementById('q');
  const cards = Array.from(document.querySelectorAll('.card'));
  const hits = document.getElementById('hits');
  const noMatch = document.getElementById('no-match');
  const total = cards.length;
  const apply = () => {
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const card of cards) {
      const haystack = card.getAttribute('data-search') || '';
      const match = terms.every((term) => haystack.includes(term));
      card.hidden = !match;
      if (match) shown += 1;
    }
    if (hits) hits.textContent = terms.length === 0 ? '' : shown + ' / ' + total;
    if (noMatch) noMatch.hidden = shown !== 0 || terms.length === 0;
  };
  input.addEventListener('input', apply);
  apply();
})();
</script>
</body>
</html>`;
}
