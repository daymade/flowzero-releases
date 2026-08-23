import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release mirrors use atomic create-only writes for immutable asset keys', async () => {
  const action = await readFile(
    new URL('../actions/mirror-release-assets/action.yml', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(action, /aws s3 cp/);
  assert.doesNotMatch(action, /"\$OSSUTIL_BIN" cp/);
  assert.match(action, /aws s3api put-object[\s\S]*--if-none-match '\*'/);
  assert.match(action, /"\$OSSUTIL_BIN" api put-object[\s\S]*--forbid-overwrite true/);
  assert.match(action, /R2 immutable object conflict after concurrent write/);
  assert.match(action, /OSS immutable object conflict after concurrent write/);
});

test('macOS draft assets are hash-bound and notarization state is checked before mounting', async () => {
  const workflow = await readFile(
    new URL('../workflows/release.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /mac_integrity_sha256: \$\{\{ steps\.mac_release_digests\.outputs\.mac_integrity_sha256 \}\}/);
  assert.match(workflow, /EXPECTED_DMG_SHA256: \$\{\{ needs\.create-release-draft\.outputs\.mac_dmg_sha256 \}\}/);
  assert.match(workflow, /--manifest "\$INTEGRITY_FILE"/);

  const restoreStep = workflow.indexOf('- name: Restore and verify submitted DMG before mount');
  const stateVerification = workflow.indexOf('release:notarize:ci verify-submission', restoreStep);
  const extractStep = workflow.indexOf('- name: Extract verified submitted app bundle', restoreStep);
  const firstMountAfterRestore = workflow.indexOf('hdiutil attach', restoreStep);
  assert.ok(restoreStep >= 0);
  assert.ok(stateVerification > restoreStep);
  assert.ok(extractStep > stateVerification);
  assert.ok(firstMountAfterRestore > extractStep);
});

test('immutable channel snapshots are conditional while current.json remains the sole mutable pointer', async () => {
  const action = await readFile(
    new URL('../actions/promote-update-channel/action.yml', import.meta.url),
    'utf8',
  );

  assert.match(action, /--key "\$IMMUTABLE_KEY"[\s\S]*--if-none-match '\*'/);
  assert.match(action, /Immutable channel snapshot conflict after concurrent write/);
  assert.match(action, /aws s3 cp[\s\S]*"s3:\/\/\$R2_BUCKET\/\$CURRENT_KEY"/);
});
