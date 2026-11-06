// Port of SSpkS\Package\PackageFilter + the DSM/package version helpers from
// SSpkS\Package\Package (GPL-3.0, jdel/sspks via tbc0309/sspks-imnks).
//
// The upstream PHP implementation lives in a web server that owns a SQLite
// index. Here the index is a static JSON document produced by tools/index.py,
// so all filtering happens in the Worker at request time.

import { familyOf } from './models.js';

/** PHP `isUnsignedInt32()`: 0 <= value <= 2147483647, leading zeroes allowed. */
export function isUnsignedInt32(value) {
  const normalised = String(value).replace(/^0+/, '');
  if (normalised === '') return true;
  return normalised.length < 10 || (normalised.length === 10 && normalised <= '2147483647');
}

/**
 * PHP `Package::isValidDsmVersion()`: `7`, `7.2` or `7.2.1` followed by `-<build>`.
 * Every numeric part must fit an unsigned 32 bit integer.
 */
export function isValidDsmVersion(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?-(\d+)$/.exec(version);
  if (match === null) return false;
  return [match[1], match[2], match[3], match[4]]
    .every((part) => part === undefined || part === '' || isUnsignedInt32(part));
}

/**
 * PHP `Package::compareDsmVersions()`.
 * Package Center only sends major/minor/build, so the optional micro version is
 * ignored and the build number identifies revisions within a release line.
 * Returns -1, 0 or 1. Throws for invalid input, exactly like the PHP version.
 */
export function compareDsmVersions(left, right) {
  const normalise = (version) => {
    if (!isValidDsmVersion(version)) {
      throw new Error(`Invalid DSM version: ${version}`);
    }
    const [release, build] = version.split('-');
    const parts = release.split('.');
    return [Number(parts[0]), Number(parts[1]), Number(build)];
  };
  const a = normalise(left);
  const b = normalise(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

/** PHP `Package::comparePackageVersions()`: split on `.`, `_` or `-`, pad, compare. */
export function comparePackageVersions(left, right) {
  const parse = (value) => String(value).split(/[._-]/).map((part) => {
    const digits = /^\d+/.exec(part);
    return digits === null ? 0 : Number(digits[0]);
  });
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = index < a.length ? a[index] : 0;
    const bv = index < b.length ? b[index] : 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/** PHP `Package::parseBool()`. Accepts raw INFO strings and JSON booleans. */
export function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
}

/** PHP `PackageFilter::normaliseList()`: whitespace separated string or array. */
export function normaliseList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item)).filter((item) => item.length > 0))];
  }
  if (typeof value !== 'string' || value.trim() === '') return [];
  return [...new Set(value.trim().split(/\s+/).filter((item) => item.length > 0))];
}

/** PHP `PackageFilter::isDsm7Package()`. */
export function isDsm7Package(record) {
  const minimumVersion = String(record.os_min_ver ?? '').trim();
  return minimumVersion !== ''
    && minimumVersion.startsWith('7.')
    && compareDsmVersions(minimumVersion, '7.0-40000') >= 0;
}

function matchesArchitecture(record, filterArch) {
  const excluded = normaliseList(record.exclude_arch).map((item) => item.toLowerCase());
  if (excluded.some((arch) => filterArch.includes(arch))) return false;

  const architectures = normaliseList(record.arch).map((item) => item.toLowerCase());
  return architectures.includes('noarch') || architectures.some((arch) => filterArch.includes(arch));
}

function matchesModel(record, filterModel) {
  const excludedModels = normaliseList(record.exclude_model).map((item) => item.toLowerCase());
  if (excludedModels.includes(filterModel)) return false;

  const models = normaliseList(record.model).map((item) => item.toLowerCase());
  return models.length === 0 || models.includes(filterModel);
}

function matchesOsVersion(record, filterOsVersion) {
  if (filterOsVersion === null) return true;

  const minimumVersion = String(record.os_min_ver ?? '').trim();
  if (minimumVersion === ''
    || compareDsmVersions(minimumVersion, '7.0-40000') < 0
    || compareDsmVersions(minimumVersion, filterOsVersion) > 0) {
    return false;
  }

  const maximumVersion = String(record.os_max_ver ?? '').trim();
  return maximumVersion === '' || compareDsmVersions(maximumVersion, filterOsVersion) >= 0;
}

/** PHP `PackageFilter::isPreferredPackage()`. */
export function isPreferredPackage(candidate, current, filterOsVersion) {
  const versionComparison = comparePackageVersions(candidate.version, current.version);
  if (versionComparison !== 0) return versionComparison > 0;

  // Equal package versions: prefer the highest minimum DSM version, but only
  // when the client told us which DSM version it runs. Browsers do not.
  return filterOsVersion !== null
    && compareDsmVersions(String(candidate.os_min_ver ?? ''), String(current.os_min_ver ?? '')) > 0;
}

/**
 * Build the package list for one Package Center request.
 *
 * @param {object[]} records   index.json packages array
 * @param {{arch: string, unique: string, channel: 'stable'|'beta', firmwareVersion: string}} query
 * @returns {object[]} matching records, newest version per package name
 */
export function selectPackages(records, query) {
  const { arch, unique, channel, firmwareVersion } = query;
  const filterArch = [...new Set([arch, familyOf(arch)])];
  const filterModel = unique.toLowerCase();
  const filterOsVersion = firmwareVersion === null ? null : firmwareVersion;

  // The PHP implementation iterates `ORDER BY id DESC`; the JSON index keeps
  // filesystem scan order, which is stable and equally arbitrary. Deduplication
  // below is order independent for the selected version.
  const selected = new Map();
  for (const record of records) {
    if (!isDsm7Package(record)) continue;
    if (channel === 'stable' && parseBool(record.beta)) continue;
    if (!matchesArchitecture(record, filterArch)) continue;
    if (!matchesModel(record, filterModel)) continue;
    if (!matchesOsVersion(record, filterOsVersion)) continue;

    const name = String(record.package);
    const current = selected.get(name);
    if (current === undefined || isPreferredPackage(record, current, filterOsVersion)) {
      selected.set(name, record);
    }
  }
  return [...selected.values()];
}
