import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertImmutableReleasePolicy,
  assertReleaseIdentity,
  verifyReleaseAssets,
} from './archive-release.mjs';

const manifest = {
  archive: {
    release: { tag: 'v1.2.3-beta.4', channel: 'beta' },
    release_infrastructure: { release_infrastructure_sha: 'a'.repeat(40) },
  },
};
const expected = [{ name: 'Flowzero.dmg', size: 100, sha256: 'b'.repeat(64) }];

test('archive publication requires the immutable state promised to operators', () => {
  assert.throws(() => assertImmutableReleasePolicy({ enabled: false }), /not enabled/u);
  assert.deepEqual(assertImmutableReleasePolicy({ enabled: true }), { enabled: true });
  const release = {
    tag_name: 'v1.2.3-beta.4',
    target_commitish: 'a'.repeat(40),
    prerelease: true,
    draft: false,
    immutable: false,
  };
  assert.throws(
    () => assertReleaseIdentity(release, manifest, { expectedDraft: false, expectedImmutable: true }),
    /immutable state mismatch/u,
  );
  assert.doesNotThrow(() => assertReleaseIdentity(
    { ...release, immutable: true },
    manifest,
    { expectedDraft: false, expectedImmutable: true },
  ));
});

test('archive assets must be uploaded and match their frozen size and digest', () => {
  const release = {
    assets: [{
      name: 'Flowzero.dmg',
      state: 'uploaded',
      size: 100,
      digest: `sha256:${'b'.repeat(64)}`,
    }],
  };
  assert.match(verifyReleaseAssets(release, expected), /^[a-f0-9]{64}$/u);
  assert.throws(
    () => verifyReleaseAssets({
      assets: [{ ...release.assets[0], state: 'new' }],
    }, expected),
    /not uploaded/u,
  );
});
