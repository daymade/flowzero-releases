import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY_PATH,
  assertReleaseTagAllowed,
  parseReleaseTombstones
} from './check-release-tombstone.mjs';

test('canonical tombstone policy is valid and blocks every withdrawn tag', () => {
  const policy = parseReleaseTombstones(
    fs.readFileSync(DEFAULT_POLICY_PATH, 'utf8'),
    DEFAULT_POLICY_PATH
  );

  for (const release of policy.releases) {
    assert.throws(
      () => assertReleaseTagAllowed(policy, release.tag),
      /permanently withdrawn/
    );
  }
});

test('a new version remains publishable', () => {
  const policy = parseReleaseTombstones(
    fs.readFileSync(DEFAULT_POLICY_PATH, 'utf8'),
    DEFAULT_POLICY_PATH
  );

  assert.doesNotThrow(() => {
    assertReleaseTagAllowed(policy, 'v99.99.99-beta.1');
  });
});

test('duplicate tombstones fail closed', () => {
  const raw = JSON.stringify({
    schema: 'flowzero.withdrawn_release_tombstones.v1',
    releases: [
      {
        tag: 'v1.0.0-beta.1',
        withdrawn_on: '2026-07-17',
        reason: 'internal_test_release_withdrawn'
      },
      {
        tag: 'v1.0.0-beta.1',
        withdrawn_on: '2026-07-17',
        reason: 'internal_test_release_withdrawn'
      }
    ]
  });

  assert.throws(
    () => parseReleaseTombstones(raw, '<duplicate-fixture>'),
    /Duplicate release tombstone tag/
  );
});
