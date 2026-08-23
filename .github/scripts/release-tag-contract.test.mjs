import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChannelReleaseTag, parseProjectReleaseTag } from './release-tag-contract.mjs';

test('accepts only canonical stable and beta project tags', () => {
  assert.deepEqual(parseProjectReleaseTag('v0.1.2'), {
    tag: 'v0.1.2',
    channel: 'stable',
    version: '0.1.2',
    parts: [0, 1, 2],
  });
  assert.deepEqual(parseChannelReleaseTag('v0.1.2-beta.8', 'beta').parts, [0, 1, 2, 8]);
  for (const tag of [
    'v01.2.3',
    'v1.02.3',
    'v1.2.03',
    'v1.2.3-beta.01',
    'v1.2.3-rc.1',
    'release-not-semver',
  ]) {
    assert.throws(() => parseProjectReleaseTag(tag), /must match canonical/u);
  }
  assert.throws(
    () => parseChannelReleaseTag('v1.2.3', 'beta'),
    /does not match the beta channel contract/u,
  );
});
