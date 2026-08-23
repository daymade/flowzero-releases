import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReleaseAssetIdentity, SCHEMA } from './release-asset-identity.mjs';

const roles = [
  ['Flowzero-arm64.dmg', 101, '1'],
  ['Flowzero-arm64.zip', 102, '2'],
  ['Flowzero-Setup.exe', 103, '3'],
  ['Flowzero-full.nupkg', 104, '4'],
  ['RELEASES', 105, '5'],
  ['mac-update-integrity.json', 106, '6'],
];

const release = {
  tag_name: 'v0.1.2-beta.7',
  draft: true,
  immutable: false,
  assets: roles.map(([name, size, digit]) => ({
    name,
    size,
    state: 'uploaded',
    digest: `sha256:${digit.repeat(64)}`,
  })),
};

test('builds a deterministic exact release asset identity', () => {
  const identity = buildReleaseAssetIdentity(release, {
    expectedTag: release.tag_name,
    expectedDraft: true,
    expectedImmutable: false,
  });

  assert.equal(identity.schema, SCHEMA);
  assert.equal(identity.assets.length, 6);
  assert.equal(identity.immutable, false);
  assert.match(identity.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(identity.assets.map((asset) => asset.name), roles.map(([name]) => name).sort());
});

test('rejects a release whose immutability does not match the lifecycle phase', () => {
  assert.throws(
    () => buildReleaseAssetIdentity(release, { expectedImmutable: true }),
    /immutable state mismatch/,
  );
  assert.equal(
    buildReleaseAssetIdentity({ ...release, draft: false, immutable: true }, {
      expectedDraft: false,
      expectedImmutable: true,
    }).immutable,
    true,
  );
});

test('rejects missing, extra, duplicate, pending, and digestless assets', () => {
  assert.throws(
    () => buildReleaseAssetIdentity({ ...release, assets: release.assets.slice(1) }),
    /exactly one asset/,
  );
  assert.throws(
    () => buildReleaseAssetIdentity({
      ...release,
      assets: [...release.assets, {
        name: 'extra.txt', size: 1, state: 'uploaded', digest: `sha256:${'7'.repeat(64)}`,
      }],
    }),
    /exactly one asset/,
  );
  assert.throws(
    () => buildReleaseAssetIdentity({ ...release, assets: [...release.assets, release.assets[0]] }),
    /Duplicate release asset/,
  );
  assert.throws(
    () => buildReleaseAssetIdentity({
      ...release,
      assets: release.assets.map((asset, index) => index === 0 ? { ...asset, state: 'new' } : asset),
    }),
    /not uploaded/,
  );
  assert.throws(
    () => buildReleaseAssetIdentity({
      ...release,
      assets: release.assets.map((asset, index) => index === 0 ? { ...asset, digest: null } : asset),
    }),
    /missing a SHA-256 digest/,
  );
});

test('changes the fingerprint for any same-size digest replacement', () => {
  const original = buildReleaseAssetIdentity(release);
  const replaced = buildReleaseAssetIdentity({
    ...release,
    assets: release.assets.map((asset, index) => index === 0
      ? { ...asset, digest: `sha256:${'f'.repeat(64)}` }
      : asset),
  });
  assert.notEqual(replaced.fingerprint, original.fingerprint);
});
