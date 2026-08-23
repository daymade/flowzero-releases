import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function extractRunBlock(workflow, stepName) {
  const lines = workflow.split('\n');
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.ok(nameIndex >= 0, `missing workflow step: ${stepName}`);
  const runIndex = lines.findIndex((line, index) => (
    index > nameIndex && /^\s+run: \|\s*$/u.test(line)
  ));
  assert.ok(runIndex > nameIndex, `missing run block: ${stepName}`);
  const runIndent = lines[runIndex].match(/^\s*/u)[0].length;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^\s*/u)[0].length;
    if (line.trim() && indent <= runIndent) break;
    body.push(line.length >= runIndent + 2 ? line.slice(runIndent + 2) : '');
  }
  return body.join('\n');
}

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
  const versioningProbe = action.indexOf('api get-bucket-versioning');
  const versioningGate = action.indexOf('assert-oss-bucket-unversioned.mjs');
  const firstAssetLoop = action.indexOf('for FILE in "${ASSET_FILES[@]}"');
  const firstPut = action.indexOf('api put-object');
  assert.ok(versioningProbe >= 0);
  assert.ok(versioningGate > versioningProbe);
  assert.ok(firstAssetLoop > versioningGate);
  assert.ok(firstPut > versioningGate);
});

test('artifact validation and digest freezing execute in independent shell scopes', async () => {
  const workflow = await readFile(
    new URL('../workflows/release.yml', import.meta.url),
    'utf8',
  );
  const validateScript = extractRunBlock(workflow, 'Validate final release artifact manifest');
  const freezeScript = extractRunBlock(
    workflow,
    'Freeze macOS release digests for downstream draft verification',
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'tinkle_flowzero-release-assets-'));
  const files = [
    ['artifacts/release-macos-arm64/Flowzero-arm64.dmg', 'dmg'],
    ['artifacts/release-macos-arm64/zip/darwin/arm64/Flowzero-arm64.zip', 'zip'],
    ['artifacts/release-windows-x64/Flowzero-Setup.exe', 'setup'],
    ['artifacts/release-windows-x64/Flowzero-full.nupkg', 'nupkg'],
    ['artifacts/release-windows-x64/RELEASES', 'releases'],
    ['artifacts/release-metadata/mac-update-integrity.json', '{"schema":"fixture"}'],
  ];
  try {
    for (const [relativePath, content] of files) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, 'utf8');
    }
    const outputPath = path.join(root, 'tinkle_github_output.txt');
    const validate = spawnSync('bash', ['-c', validateScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.equal(validate.status, 0, `${validate.stdout}\n${validate.stderr}`);

    const freeze = spawnSync('bash', ['-c', freezeScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.equal(freeze.status, 0, `${freeze.stdout}\n${freeze.stderr}`);
    const outputs = await readFile(outputPath, 'utf8');
    assert.match(outputs, /mac_integrity_sha256=[a-f0-9]{64}/u);
    assert.match(outputs, /mac_dmg_sha256=[a-f0-9]{64}/u);
    assert.match(outputs, /mac_zip_sha256=[a-f0-9]{64}/u);

    await writeFile(path.join(root, 'artifacts/tinkle_unexpected.txt'), 'unexpected', 'utf8');
    const rejected = spawnSync('bash', ['-c', validateScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Unexpected file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('publication and promotion rebind every GitHub asset to immutable R2 evidence', async () => {
  const workflow = await readFile(
    new URL('../workflows/release.yml', import.meta.url),
    'utf8',
  );
  const publish = extractRunBlock(workflow, 'Publish release (draft to live)');
  const preIdentity = publish.indexOf('--expected-draft true');
  const r2Evidence = publish.indexOf('aws s3api head-object');
  const patch = publish.indexOf('gh api --method PATCH');
  const postIdentity = publish.indexOf('--expected-draft false');
  assert.ok(preIdentity >= 0);
  assert.ok(r2Evidence > preIdentity);
  assert.ok(patch > r2Evidence);
  assert.ok(postIdentity > patch);
  assert.match(publish, /GitHub release asset identity changed while publishing/u);

  const promotion = await readFile(
    new URL('../actions/promote-update-channel/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(promotion, /Published GitHub asset does not match immutable R2 evidence/u);
  assert.match(promotion, /GitHub release asset identity changed during channel promotion/u);
  assert.match(promotion, /release-asset-identity\.mjs/u);
});

test('the real publish shell blocks an R2 mismatch before the GitHub PATCH', async () => {
  const workflow = await readFile(
    new URL('../workflows/release.yml', import.meta.url),
    'utf8',
  );
  const publishScript = extractRunBlock(workflow, 'Publish release (draft to live)');
  const root = await mkdtemp(path.join(os.tmpdir(), 'tinkle_flowzero-publish-contract-'));
  const tag = 'v0.1.2-beta.7';
  const roleNames = [
    'Flowzero-arm64.dmg',
    'Flowzero-arm64.zip',
    'Flowzero-Setup.exe',
    'Flowzero-full.nupkg',
    'RELEASES',
    'mac-update-integrity.json',
  ];
  const assets = roleNames.map((name, index) => ({
    name,
    size: 100 + index,
    state: 'uploaded',
    digest: `sha256:${String(index + 1).repeat(64)}`,
  }));
  const preRelease = { id: 777, tag_name: tag, draft: true, assets };
  const postRelease = { ...preRelease, draft: false };
  const prePath = path.join(root, 'tinkle_pre_release.json');
  const postPath = path.join(root, 'tinkle_post_release.json');
  const statePath = path.join(root, 'tinkle_release_state');
  const patchLogPath = path.join(root, 'tinkle_patch_log');
  const ledgerPath = path.join(root, 'tinkle_r2_ledger.json');
  const fakeGhPath = path.join(root, 'tinkle_fake_gh.cjs');
  const fakeAwsPath = path.join(root, 'tinkle_fake_aws.cjs');
  const bashEnvPath = path.join(root, 'tinkle_fake_commands.sh');
  try {
    await writeFile(prePath, JSON.stringify(preRelease), 'utf8');
    await writeFile(postPath, JSON.stringify(postRelease), 'utf8');
    await writeFile(ledgerPath, JSON.stringify(Object.fromEntries(assets.map((asset) => [
      asset.name,
      { size: asset.size, sha256: asset.digest.slice('sha256:'.length) },
    ]))), 'utf8');
    await writeFile(fakeGhPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api') process.exit(90);
if (args.includes('--method')) {
  fs.appendFileSync(process.env.TINKLE_PATCH_LOG, args.join(' ') + '\\n');
  fs.writeFileSync(process.env.TINKLE_RELEASE_STATE, 'live');
  process.stdout.write('{}\\n');
} else {
  const live = fs.existsSync(process.env.TINKLE_RELEASE_STATE);
  process.stdout.write(fs.readFileSync(live ? process.env.TINKLE_POST_RELEASE : process.env.TINKLE_PRE_RELEASE));
}
`, 'utf8');
    await writeFile(fakeAwsPath, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const keyIndex = args.indexOf('--key');
if (args[0] !== 's3api' || args[1] !== 'head-object' || keyIndex < 0) process.exit(91);
const name = path.basename(args[keyIndex + 1]);
const ledger = JSON.parse(fs.readFileSync(process.env.TINKLE_R2_LEDGER, 'utf8'));
const item = ledger[name];
if (!item) process.exit(92);
const sha256 = process.env.TINKLE_R2_MISMATCH === '1' && name === 'Flowzero-arm64.dmg'
  ? 'f'.repeat(64)
  : item.sha256;
process.stdout.write(String(item.size) + '\\t' + sha256 + '\\n');
`, 'utf8');
    await writeFile(bashEnvPath, `
gh() { node "$TINKLE_FAKE_GH" "$@"; }
aws() { node "$TINKLE_FAKE_AWS" "$@"; }
`, 'utf8');

    const baseEnv = {
      ...process.env,
      BASH_ENV: bashEnvPath,
      GH_TOKEN: 'fixture-token',
      RELEASE_TAG: tag,
      GITHUB_REPOSITORY: 'daymade/flowzero-releases',
      RUNNER_TEMP: root,
      AWS_ACCESS_KEY_ID: 'fixture-access',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
      AWS_DEFAULT_REGION: 'auto',
      R2_ENDPOINT: 'https://fixture.r2.example',
      R2_BUCKET: 'fixture-bucket',
      TINKLE_FAKE_GH: fakeGhPath,
      TINKLE_FAKE_AWS: fakeAwsPath,
      TINKLE_PRE_RELEASE: prePath,
      TINKLE_POST_RELEASE: postPath,
      TINKLE_RELEASE_STATE: statePath,
      TINKLE_PATCH_LOG: patchLogPath,
      TINKLE_R2_LEDGER: ledgerPath,
    };
    const success = spawnSync('bash', ['-c', publishScript], {
      cwd: path.resolve(new URL('../..', import.meta.url).pathname),
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
    assert.equal((await readFile(patchLogPath, 'utf8')).trim().split('\n').length, 1);

    await rm(statePath, { force: true });
    await rm(patchLogPath, { force: true });
    const mismatch = spawnSync('bash', ['-c', publishScript], {
      cwd: path.resolve(new URL('../..', import.meta.url).pathname),
      encoding: 'utf8',
      env: { ...baseEnv, TINKLE_R2_MISMATCH: '1' },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /no longer matches immutable R2/u);
    await assert.rejects(readFile(patchLogPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every channel writer uses the same non-cancelling concurrency group', async () => {
  const [release, mirror, initialize] = await Promise.all([
    readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8'),
    readFile(new URL('../workflows/mirror-published-release.yml', import.meta.url), 'utf8'),
    readFile(new URL('../workflows/initialize-empty-update-channel.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(release, /group: flowzero-update-channel-\$\{\{ needs\.prepare\.outputs\.channel \}\}[\s\S]*cancel-in-progress: false/u);
  for (const workflow of [mirror, initialize]) {
    assert.match(workflow, /group: flowzero-update-channel-\$\{\{ inputs\.channel \}\}[\s\S]*cancel-in-progress: false/u);
  }
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
