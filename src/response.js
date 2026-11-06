// Package Center JSON encoding — a port of SSpkS\Output\JsonOutput and
// SSpkS\Output\UrlFixer (GPL-3.0, jdel/sspks via tbc0309/sspks-imnks).
//
// The wire format is what DSM 7's Package Center expects from a third-party
// package source; field order is kept identical to the PHP implementation so
// responses can be diffed against it.

/** PHP `rawurlencode()` per path segment, mirroring UrlFixer::encodePath(). */
function encodePath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** PHP `value()`: null and empty string fall back to the given default. */
function value(record, property, fallback = null) {
  const raw = record[property];
  return raw === null || raw === undefined || raw === '' ? fallback : raw;
}

function asNumber(record, property, fallback = 0) {
  const raw = record[property];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(record, property, fallback = false) {
  const raw = record[property];
  if (raw === undefined || raw === null) return fallback;
  return Boolean(raw);
}

function makeAbsolute(baseUrl, path) {
  return baseUrl + encodePath(String(path ?? '').replace(/^[/\\]+/, ''));
}

/**
 * Content-addressed query for package downloads: a stable `?v=<md5 prefix>`
 * suffix means a rebuilt asset (same file name, new bytes) gets a new URL, so
 * `immutable` edge caching can never serve a stale binary.
 */
function versionQuery(record) {
  const md5 = String(record.md5 ?? '');
  return /^[a-f0-9]{32}$/i.test(md5) ? `?v=${md5.slice(0, 12)}` : '';
}

function fixPaths(baseUrl, paths) {
  return (Array.isArray(paths) ? paths : []).map((path) => makeAbsolute(baseUrl, path));
}

function changelog(record, defaults) {
  const original = String(value(record, 'changelog', '')).trim();
  if (!defaults.changelog_ad_enabled) return original;
  const addition = String(defaults.changelog_ad ?? '').trim();
  if (addition === '') return original;
  return original === '' ? addition : `${original}<br><br>${addition}`;
}

function packageToObject(record, language, baseUrl, packageBaseUrl, defaults) {
  const localizedDisplayName = language === '' ? '' : `displayname_${language}`;
  const localizedDescription = language === '' ? '' : `description_${language}`;

  return {
    package: record.package,
    version: record.version,
    dname: localizedDisplayName === ''
      ? record.displayname
      : value(record, localizedDisplayName, record.displayname),
    desc: localizedDescription === ''
      ? record.description
      : value(record, localizedDescription, record.description),
    price: 0,
    download_count: asNumber(record, 'download_count', asNumber(defaults, 'download_count', 0)),
    recent_download_count: asNumber(record, 'recent_download_count', 0),
    link: makeAbsolute(packageBaseUrl, `packages/${record.file}`) + versionQuery(record),
    size: asNumber(record, 'filesize', 0),
    md5: String(value(record, 'md5', '')),
    thumbnail: fixPaths(baseUrl, record.thumbnail),
    snapshot: fixPaths(baseUrl, record.snapshot),
    qinst: asBool(record, 'qinst', true),
    qstart: asBool(record, 'qstart', true),
    qupgrade: asBool(record, 'qupgrade', true),
    depsers: value(record, 'install_dep_services'),
    deppkgs: value(record, 'install_dep_packages'),
    conflictpkgs: value(record, 'install_conflict_packages'),
    start: true,
    maintainer: value(record, 'maintainer', defaults.maintainer ?? ''),
    maintainer_url: value(record, 'maintainer_url', defaults.maintainer_url ?? ''),
    distributor: value(record, 'distributor', defaults.distributor ?? ''),
    distributor_url: value(record, 'distributor_url', defaults.distributor_url ?? ''),
    support_url: value(record, 'support_url', defaults.support_url ?? ''),
    changelog: changelog(record, defaults),
    thirdparty: true,
    category: 0,
    subcategory: 0,
    type: 0,
    silent_install: asBool(record, 'silent_install', false),
    silent_uninstall: asBool(record, 'silent_uninstall', false),
    silent_upgrade: asBool(record, 'silent_upgrade', false),
    auto_upgrade_from: value(record, 'auto_upgrade_from'),
    beta: asBool(record, 'beta', false),
  };
}

/**
 * Encode the Package Center response.
 *
 * @param {object[]} records selected records
 * @param {{language?: string, baseUrl: string, defaults?: object, hideKeys?: string[]}} options
 * @returns {string} JSON body
 */
export function encodePackages(records, options) {
  const { language = '', baseUrl, packageBaseUrl = null, defaults = {}, hideKeys = [] } = options;
  const normalizedLanguage = String(language).toLowerCase();

  const packages = records.map((record) => {
    const object = packageToObject(record, normalizedLanguage, baseUrl, packageBaseUrl || baseUrl, defaults);
    for (const key of hideKeys) delete object[key];
    return object;
  });

  return JSON.stringify({ packages });
}
