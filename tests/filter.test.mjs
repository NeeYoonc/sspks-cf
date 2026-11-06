// Port of the PHP regression tests (tests/dsm_version_test.php,
// tests/package_dsm_selection_test.php) plus coverage for the R2 index filter.
//
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareDsmVersions,
  comparePackageVersions,
  isDsm7Package,
  isUnsignedInt32,
  isValidDsmVersion,
  selectPackages,
} from '../src/filter.js';

/** Minimal index record, mirroring the shape produced by tools/index.py. */
export function record(overrides = {}) {
  return {
    file: 'Some-1.0-1.spk',
    package: 'Some',
    version: '1.0-1',
    displayname: 'Some',
    description: 'desc',
    os_min_ver: '7.2-64570',
    os_max_ver: '',
    arch: ['x86_64'],
    exclude_arch: [],
    model: [],
    exclude_model: [],
    beta: false,
    official: false,
    run_as_root: false,
    qinst: true,
    qstart: true,
    qupgrade: true,
    silent_install: false,
    silent_uninstall: false,
    silent_upgrade: false,
    auto_upgrade_from: '',
    install_dep_packages: '',
    install_dep_services: '',
    install_conflict_packages: '',
    maintainer: 'Test',
    maintainer_url: '',
    distributor: '',
    distributor_url: '',
    support_url: '',
    changelog: '',
    filesize: 10,
    md5: '0123456789abcdef0123456789abcdef',
    thumbnail: ['icons/_default_72.png', 'icons/_default_120.png'],
    snapshot: [],
    ...overrides,
  };
}

function query(overrides = {}) {
  return {
    arch: 'apollolake',
    unique: 'synology_apollolake_ds918+',
    channel: 'stable',
    firmwareVersion: '7.2-69057',
    ...overrides,
  };
}

const names = (selected) => selected.map((item) => item.package);

test('isUnsignedInt32 accepts 0..2147483647 and rejects overflow', () => {
  for (const value of ['0', '000', '1', '2147483647', '0002147483647']) {
    assert.equal(isUnsignedInt32(value), true, value);
  }
  for (const value of ['2147483648', '9999999999', '4294967296']) {
    assert.equal(isUnsignedInt32(value), false, value);
  }
});

test('isValidDsmVersion matches the PHP test vectors', () => {
  for (const version of ['7.0-40000', '7.2-69057', '7.2.1-69057', '7.2.2-72806']) {
    assert.equal(isValidDsmVersion(version), true, version);
  }
  for (const version of ['7.2.1', '7.2.1.0-69057', '7.2.-69057', '7.2.1_69057',
    '7.2.2147483648-69057', '7.2.1-2147483648', '2147483648.2.1-69057']) {
    assert.equal(isValidDsmVersion(version), false, version);
  }
});

test('compareDsmVersions ignores the micro version and compares the build', () => {
  const cases = [
    ['7.2.1-69057', '7.2-69057', 0],
    ['7.2.1-69057', '7.2-64570', 1],
    ['7.2.1-69057', '7.2.2-72806', -1],
    ['7.2.1-69057', '7.3-86009', -1],
    ['7.2.1-69057', '7.1-99999', 1],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(compareDsmVersions(left, right), expected, `${left} vs ${right}`);
    assert.equal(compareDsmVersions(right, left), expected === 0 ? 0 : -expected, `${right} vs ${left}`);
  }
  assert.throws(() => compareDsmVersions('7.2', '7.2-69057'));
});

test('comparePackageVersions orders numerically, not lexically', () => {
  assert.equal(comparePackageVersions('1.0-1', '1.0-2'), -1);
  assert.equal(comparePackageVersions('2.0-1', '1.9-9'), 1);
  assert.equal(comparePackageVersions('1.0', '1.0-0'), 0);
  assert.equal(comparePackageVersions('1.0-1', '1.0-1'), 0);
});

test('isDsm7Package rejects missing and pre-DSM 7 versions', () => {
  assert.equal(isDsm7Package(record({ os_min_ver: '7.0-40000' })), true);
  assert.equal(isDsm7Package(record({ os_min_ver: '6.2.4-25556' })), false);
  assert.equal(isDsm7Package(record({ os_min_ver: '' })), false);
});

test('firmware window filters os_min_ver and os_max_ver', () => {
  const records = [
    record({ package: 'Min72', os_min_ver: '7.2-64570' }),
    record({ package: 'Min71', os_min_ver: '7.1-42661' }),
    record({ package: 'Range', os_min_ver: '7.2.1-69057', os_max_ver: '7.2.2-72806' }),
    record({ package: 'OldMax', os_min_ver: '7.1-42661', os_max_ver: '7.1-42962' }),
  ];
  assert.deepEqual(names(selectPackages(records, query({ firmwareVersion: '7.1-42962' }))), ['Min71', 'OldMax']);
  assert.deepEqual(names(selectPackages(records, query({ firmwareVersion: '7.2-69057' }))), ['Min72', 'Min71', 'Range']);
  assert.deepEqual(names(selectPackages(records, query({ firmwareVersion: '7.2-72806' }))), ['Min72', 'Min71', 'Range']);
  assert.deepEqual(names(selectPackages(records, query({ firmwareVersion: '7.2-72807' }))), ['Min72', 'Min71']);
  assert.deepEqual(names(selectPackages(records, query({ firmwareVersion: '7.3-86009' }))), ['Min72', 'Min71']);
});

test('equal package versions prefer the highest minimum DSM version', () => {
  const older = record({ package: 'Same', version: '1.0-1', os_min_ver: '7.1-42661' });
  const newer = record({ package: 'Same', version: '1.0-1', os_min_ver: '7.2-64570' });

  const withFirmware = selectPackages([older, newer], query({ firmwareVersion: '7.2-69057' }));
  assert.equal(withFirmware.length, 1);
  assert.equal(withFirmware[0].os_min_ver, '7.2-64570');

  const reverse = selectPackages([newer, older], query({ firmwareVersion: '7.2-69057' }));
  assert.equal(reverse[0].os_min_ver, '7.2-64570');

  // Browser requests (no firmware version) keep the first record, like PHP.
  const browser = selectPackages([older, newer], query({ firmwareVersion: null }));
  assert.equal(browser[0].os_min_ver, '7.1-42661');
});

test('higher package version wins over the input order', () => {
  const v1 = record({ package: 'Up', version: '1.0-1' });
  const v2 = record({ package: 'Up', version: '2.0-1' });
  assert.equal(selectPackages([v1, v2], query()).length, 1);
  assert.equal(selectPackages([v1, v2], query())[0].version, '2.0-1');
  assert.equal(selectPackages([v2, v1], query())[0].version, '2.0-1');
});

test('stable channel hides beta packages, beta channel keeps them', () => {
  const stablePkg = record({ package: 'Stable' });
  const betaPkg = record({ package: 'Beta', beta: true });
  assert.deepEqual(names(selectPackages([stablePkg, betaPkg], query())), ['Stable']);
  assert.deepEqual(names(selectPackages([stablePkg, betaPkg], query({ channel: 'beta' }))), ['Stable', 'Beta']);
});

test('architecture filtering uses the architecture family and noarch', () => {
  const specific = record({ package: 'Family', arch: ['x86_64'] });
  const exact = record({ package: 'Exact', arch: ['apollolake'] });
  const noarch = record({ package: 'NoArch', arch: ['noarch'] });
  const excluded = record({ package: 'Excluded', arch: ['x86_64'], exclude_arch: ['apollolake'] });
  const armPkg = record({ package: 'Arm', arch: ['armada37xx'] });

  assert.deepEqual(
    names(selectPackages([specific, exact, noarch, excluded, armPkg], query())),
    ['Family', 'Exact', 'NoArch'],
  );
});

test('model filtering honours include and exclude lists', () => {
  // Synology's INFO `model` / `exclude_model` fields use the full
  // `synology_<arch>_<model>` identifier, which is exactly what Package Center
  // sends as `unique`.
  const all = record({ package: 'AllModels' });
  const listed = record({ package: 'Listed', model: ['synology_apollolake_ds918+', 'synology_apollolake_ds920+'] });
  const other = record({ package: 'OtherModel', model: ['synology_apollolake_ds423+'] });
  const excluded = record({
    package: 'ExcludedModel',
    model: ['synology_apollolake_ds918+'],
    exclude_model: ['synology_apollolake_ds918+'],
  });

  assert.deepEqual(names(selectPackages([all, listed, other, excluded], query())), ['AllModels', 'Listed']);
  assert.deepEqual(
    names(selectPackages([all, listed, other], query({ unique: 'synology_apollolake_ds423+' }))),
    ['AllModels', 'OtherModel'],
  );
});

test('non-DSM 7 packages never match', () => {
  const dsm6 = record({ package: 'DSM6', os_min_ver: '6.2.4-25556' });
  assert.deepEqual(names(selectPackages([dsm6], query())), []);
});
