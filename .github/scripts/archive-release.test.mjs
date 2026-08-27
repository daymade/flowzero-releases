import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertImmutableReleasePolicy,
  assertReleaseIdentity,
  getRelease,
  getReleaseById,
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

test('archive resume finds an authenticated draft when the tag endpoint hides it', () => {
  const draft = { id: 42, tag_name: 'v1.2.3-beta.4', draft: true };
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    if (args[1].includes('/releases/tags/')) {
      return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    return { status: 0, stdout: JSON.stringify([draft]), stderr: '' };
  };

  assert.deepEqual(getRelease('daymade/flowzero-releases', draft.tag_name, { runCommand }), draft);
  assert.equal(calls[1][1], 'repos/daymade/flowzero-releases/releases?per_page=100');
});

test('archive refreshes an existing draft by immutable release ID', () => {
  const draft = { id: 42, tag_name: 'v1.2.3-beta.4', draft: true };
  const runCommand = (_command, args) => {
    assert.equal(args[1], 'repos/daymade/flowzero-releases/releases/42');
    return { status: 0, stdout: JSON.stringify(draft), stderr: '' };
  };

  assert.deepEqual(getReleaseById('daymade/flowzero-releases', 42, { runCommand }), draft);
});
