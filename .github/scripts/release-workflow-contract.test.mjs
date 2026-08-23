import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('prepare rejects non-channel tags before any build can start', async () => {
  const workflow = await readFile(
    new URL('../workflows/release.yml', import.meta.url),
    'utf8',
  );
  const tombstoneGate = workflow.indexOf('- name: Reject permanently withdrawn versions');
  const channelGate = workflow.indexOf('- name: Validate release channel contract');
  const workflowContracts = workflow.indexOf('- name: Verify release workflow contracts');
  const firstBuild = workflow.indexOf('  build-macos:');
  assert.ok(tombstoneGate >= 0);
  assert.ok(channelGate > tombstoneGate);
  assert.ok(workflowContracts > channelGate);
  assert.ok(firstBuild > workflowContracts);
  assert.match(
    workflow.slice(channelGate, workflowContracts),
    /assert-channel-version-forward\.mjs[\s\S]*--channel "\$RELEASE_CHANNEL"[\s\S]*--target-tag "\$RELEASE_TAG"/u,
  );

  const validator = new URL('./assert-channel-version-forward.mjs', import.meta.url);
  const validBeta = spawnSync(process.execPath, [
    validator.pathname,
    '--channel', 'beta',
    '--target-tag', 'v1.2.3-beta.8',
    '--allow-downgrade', 'false',
  ], { encoding: 'utf8' });
  assert.equal(validBeta.status, 0, validBeta.stderr);
  const invalidCandidate = spawnSync(process.execPath, [
    validator.pathname,
    '--channel', 'beta',
    '--target-tag', 'v1.2.3-rc.1',
    '--allow-downgrade', 'false',
  ], { encoding: 'utf8' });
  assert.notEqual(invalidCandidate.status, 0);
  assert.match(invalidCandidate.stderr, /must match canonical/u);
});

test('no-release checks every GitHub Releases page before clearing a channel', async () => {
  const action = await readFile(
    new URL('../actions/promote-update-channel/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(action, /gh api --paginate --slurp[\s\S]*releases\?per_page=100/u);
  assert.match(action, /select-published-release-tag\.mjs/u);
  assert.doesNotMatch(
    action,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100"/u,
  );
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
  assert.match(publish, /--expected-immutable false/u);
  assert.match(publish, /--expected-immutable true/u);
  assert.match(publish, /gh release verify "\$RELEASE_TAG"/u);
  assert.match(publish, /GitHub release asset identity changed while publishing/u);

  const promotion = await readFile(
    new URL('../actions/promote-update-channel/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(promotion, /Published GitHub asset does not match immutable R2 evidence/u);
  assert.match(promotion, /GitHub release asset identity changed during channel promotion/u);
  assert.match(promotion, /release-asset-identity\.mjs/u);
  assert.match(promotion, /--expected-immutable true/u);
  assert.match(promotion, /gh release verify "\$RELEASE_TAG"/u);

  const immutablePrecheck = workflow.indexOf('- name: Require GitHub immutable releases');
  const createDraft = workflow.indexOf('- name: Create Release (draft)');
  assert.ok(immutablePrecheck >= 0);
  assert.ok(createDraft > immutablePrecheck);
  assert.match(workflow.slice(immutablePrecheck, createDraft), /X-GitHub-Api-Version: 2026-03-10/u);
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
  const preRelease = { id: 777, tag_name: tag, draft: true, immutable: false, assets };
  const postRelease = { ...preRelease, draft: false, immutable: true };
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
if (args[0] === 'release' && args[1] === 'verify') process.exit(0);
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
      RELEASE_ID: '777',
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
  assert.match(
    release,
    /group: flowzero-update-channel-\$\{\{ contains\(github\.event\.client_payload\.version \|\| inputs\.version, '-'\) && 'beta' \|\| 'stable' \}\}[\s\S]*cancel-in-progress: false/u,
  );
  for (const workflow of [mirror, initialize]) {
    assert.match(workflow, /group: flowzero-update-channel-\$\{\{ inputs\.channel \}\}[\s\S]*cancel-in-progress: false/u);
  }
  for (const workflow of [release, mirror, initialize]) {
    assert.match(workflow, /group: flowzero-update-channel-[^\n]+\n\s+queue: max\n\s+cancel-in-progress: false/u);
  }
});

test('channel ordering is checked before immutable writes in standard and manual release paths', async () => {
  const [release, mirror] = await Promise.all([
    readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8'),
    readFile(new URL('../workflows/mirror-published-release.yml', import.meta.url), 'utf8'),
  ]);
  const standardPreflight = release.indexOf('- name: Reject channel downgrade before immutable writes');
  const standardMirror = release.indexOf('uses: ./.github/actions/mirror-release-assets');
  const createDraft = release.indexOf('- name: Create Release (draft)');
  assert.ok(standardPreflight >= 0);
  assert.ok(standardMirror > standardPreflight);
  assert.ok(createDraft > standardMirror);
  assert.match(
    release.slice(standardPreflight, standardMirror),
    /--current-manifest "\$CURRENT_MANIFEST"[\s\S]*--allow-downgrade false/u,
  );

  const manualTagGate = mirror.indexOf('- name: Validate release tag and channel contract');
  const manualPreflight = mirror.indexOf('- name: Validate current channel ordering before mirror');
  const manualDownload = mirror.indexOf('- name: Download the published release manifest');
  const manualMirror = mirror.indexOf('uses: ./.github/actions/mirror-release-assets');
  assert.ok(manualTagGate >= 0);
  assert.ok(manualPreflight > manualTagGate);
  assert.ok(manualDownload > manualPreflight);
  assert.ok(manualMirror > manualDownload);
  assert.match(
    mirror.slice(manualPreflight, manualDownload),
    /--current-manifest "\$CURRENT_MANIFEST"[\s\S]*--allow-downgrade "\$ALLOW_DOWNGRADE"/u,
  );
});

test('manual dispatch always executes privileged release infrastructure from main', async () => {
  const workflow = await readFile(
    new URL('../workflows/release.yml', import.meta.url),
    'utf8',
  );
  for (const [jobName, nextJobName] of [
    ['  create-release-draft:', '  verify-draft-macos:'],
    ['  verify-draft-macos:', '  verify-draft-windows:'],
    ['  promote-update-channel:', null],
  ]) {
    const start = workflow.indexOf(jobName);
    const end = nextJobName ? workflow.indexOf(nextJobName, start + jobName.length) : workflow.length;
    assert.ok(start >= 0 && end > start, `missing job block: ${jobName}`);
    assert.match(
      workflow.slice(start, end),
      /- name: Checkout release infrastructure\n\s+uses: actions\/checkout@v7\n\s+with:\n\s+ref: main\n\s+persist-credentials: false/u,
    );
  }
  const checkoutVersions = [...workflow.matchAll(/actions\/checkout@(v\d+)/gu)]
    .map((match) => match[1]);
  assert.ok(checkoutVersions.length > 0);
  assert.deepEqual([...new Set(checkoutVersions)], ['v7']);
});

test('channel CAS requires contemporaneous full public bytes from both mirrors', async () => {
  const [action, release, mirror] = await Promise.all([
    readFile(new URL('../actions/promote-update-channel/action.yml', import.meta.url), 'utf8'),
    readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8'),
    readFile(new URL('../workflows/mirror-published-release.yml', import.meta.url), 'utf8'),
  ]);
  const immutableReadback = action.indexOf('"$IMMUTABLE_URL"');
  const r2Readback = action.lastIndexOf('${R2_PUBLIC_BASE_URL%/}/releases/$RELEASE_TAG/$ASSET_NAME');
  const ossReadback = action.lastIndexOf('${ALIYUN_OSS_PUBLIC_BASE_URL%/}/releases/$RELEASE_TAG/$ASSET_NAME');
  const currentPut = action.indexOf('--key "$CURRENT_KEY"', ossReadback);
  assert.ok(immutableReadback >= 0);
  assert.ok(r2Readback > immutableReadback);
  assert.ok(r2Readback >= 0);
  assert.ok(ossReadback > r2Readback);
  assert.ok(currentPut > ossReadback);
  assert.doesNotMatch(
    action.slice(ossReadback, currentPut),
    /gh release download|generate-update-channel-manifest|--key "\$IMMUTABLE_KEY"/u,
  );
  assert.match(action, /Published GitHub asset does not match public R2 bytes/u);
  assert.match(action, /Published GitHub asset does not match public OSS bytes/u);
  assert.match(release, /Promote verified release[\s\S]*ALIYUN_OSS_PUBLIC_BASE_URL:/u);
  assert.match(mirror, /Promote mirrored release[\s\S]*ALIYUN_OSS_PUBLIC_BASE_URL:/u);
});

test('the real promotion shell rejects mirror mutation and keeps no_release independent from asset verification', async () => {
  const action = await readFile(
    new URL('../actions/promote-update-channel/action.yml', import.meta.url),
    'utf8',
  );
  const promoteScript = extractRunBlock(action, 'Generate and promote channel snapshot');
  const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  const tag = 'v0.1.2-beta.8';
  const version = tag.slice(1);
  const names = {
    dmg: `Flowzero-darwin-arm64-${version}.dmg`,
    zip: `Flowzero-darwin-arm64-${version}.zip`,
    setup: `Flowzero-${version}-Setup.exe`,
    nupkg: `Flowzero-${version}-full.nupkg`,
    releases: 'RELEASES',
    macIntegrity: 'mac-update-integrity.json',
  };
  const hash = (algorithm, value, encoding = 'hex') => (
    createHash(algorithm).update(value).digest(encoding)
  );

  async function runCase(mutateOrigin, channelState = 'published') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tinkle_flowzero-promote-cas-'));
    const assetRoot = path.join(root, 'tinkle_assets');
    const r2PublicRoot = path.join(root, 'tinkle_r2-public');
    const ossPublicRoot = path.join(root, 'tinkle_oss-public');
    const storeRoot = path.join(root, 'tinkle_store');
    const casLog = path.join(root, 'tinkle_cas.log');
    const mutationLog = path.join(root, 'tinkle_mutation.log');
    const releasePath = path.join(root, 'tinkle_release.json');
    const ledgerPath = path.join(root, 'tinkle_ledger.json');
    const fakeGhPath = path.join(root, 'tinkle_fake_gh.cjs');
    const fakeAwsPath = path.join(root, 'tinkle_fake_aws.cjs');
    const fakeCurlPath = path.join(root, 'tinkle_fake_curl.cjs');
    const bashEnvPath = path.join(root, 'tinkle_fake_commands.sh');

    try {
      await Promise.all([
        mkdir(assetRoot, { recursive: true }),
        mkdir(r2PublicRoot, { recursive: true }),
        mkdir(ossPublicRoot, { recursive: true }),
        mkdir(storeRoot, { recursive: true }),
      ]);
      const rawAssets = new Map([
        [names.dmg, Buffer.from('dmg-bytes')],
        [names.zip, Buffer.from('zip-bytes')],
        [names.setup, Buffer.from('setup-bytes')],
        [names.nupkg, Buffer.from('nupkg-bytes')],
      ]);
      const nupkg = rawAssets.get(names.nupkg);
      rawAssets.set(
        names.releases,
        Buffer.from(`${hash('sha1', nupkg)} ${names.nupkg} ${nupkg.length}\n`),
      );
      rawAssets.set(
        names.macIntegrity,
        Buffer.from(`${JSON.stringify({
          schema: 'flowzero.macos_update_integrity.v1',
          version,
          file: {
            name: names.zip,
            size: rawAssets.get(names.zip).length,
            sha512: hash('sha512', rawAssets.get(names.zip), 'base64'),
            sha256: hash('sha256', rawAssets.get(names.zip)),
          },
          dmg: {
            name: names.dmg,
            size: rawAssets.get(names.dmg).length,
            sha256: hash('sha256', rawAssets.get(names.dmg)),
          },
        }, null, 2)}\n`),
      );

      for (const [name, bytes] of rawAssets) {
        await Promise.all([
          writeFile(path.join(assetRoot, name), bytes),
          writeFile(path.join(r2PublicRoot, name), bytes),
          writeFile(path.join(ossPublicRoot, name), bytes),
        ]);
      }
      const contentTypes = {
        [names.dmg]: 'application/x-apple-diskimage',
        [names.zip]: 'application/zip',
        [names.setup]: 'application/vnd.microsoft.portable-executable',
        [names.nupkg]: 'application/octet-stream',
        [names.releases]: 'text/plain',
        [names.macIntegrity]: 'application/json',
      };
      const assets = [...rawAssets].map(([name, bytes]) => ({
        name,
        size: bytes.length,
        state: 'uploaded',
        digest: `sha256:${hash('sha256', bytes)}`,
        content_type: contentTypes[name],
      }));
      await writeFile(releasePath, JSON.stringify({
        id: 808,
        tag_name: tag,
        draft: false,
        prerelease: true,
        immutable: true,
        published_at: '2026-08-24T00:00:00Z',
        assets,
      }), 'utf8');
      await writeFile(ledgerPath, JSON.stringify(Object.fromEntries(assets.map((asset) => [
        asset.name,
        { size: asset.size, sha256: asset.digest.slice('sha256:'.length) },
      ]))), 'utf8');

      await writeFile(fakeGhPath, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'verify') process.exit(0);
if (args[0] === 'release' && args[1] === 'download') {
  const pattern = args[args.indexOf('--pattern') + 1];
  const outputDir = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(path.join(process.env.TINKLE_ASSET_ROOT, pattern), path.join(outputDir, pattern));
  process.exit(0);
}
if (args[0] === 'api' && process.env.CHANNEL_STATE === 'no_release') {
  process.stdout.write('[[]]');
  process.exit(0);
}
if (args[0] === 'api') {
  process.stdout.write(fs.readFileSync(process.env.TINKLE_RELEASE_JSON));
  process.exit(0);
}
process.exit(90);
`, 'utf8');
      await writeFile(fakeAwsPath, `
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const key = flag('--key');
const storePath = (objectKey) => path.join(process.env.TINKLE_STORE, ...objectKey.split('/'));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
if (args[0] !== 's3api') process.exit(91);
if (args[1] === 'list-objects-v2') {
  process.stdout.write(JSON.stringify({ Contents: [] }));
  process.exit(0);
}
if (args[1] === 'head-object') {
  if (key.startsWith('releases/')) {
    const ledger = JSON.parse(fs.readFileSync(process.env.TINKLE_LEDGER, 'utf8'));
    const item = ledger[path.basename(key)];
    if (!item) process.exit(92);
    process.stdout.write(String(item.size) + '\\t' + item.sha256 + '\\n');
    process.exit(0);
  }
  const target = storePath(key);
  if (!fs.existsSync(target)) process.exit(255);
  const bytes = fs.readFileSync(target);
  if (args.includes('--query')) process.stdout.write(String(bytes.length) + '\\t' + digest(bytes) + '\\n');
  else process.stdout.write(JSON.stringify({ ContentLength: bytes.length, Metadata: { sha256: digest(bytes) }, ETag: '"fixture"' }));
  process.exit(0);
}
if (args[1] === 'put-object') {
  if (key === 'channels/beta/current.json') fs.appendFileSync(process.env.TINKLE_CAS_LOG, 'CAS\\n');
  const target = storePath(key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(flag('--body'), target);
  process.stdout.write('{}');
  process.exit(0);
}
process.exit(93);
`, 'utf8');
      await writeFile(fakeCurlPath, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const urlArg = args.find((value) => /^https?:\\/\\//u.test(value));
if (!urlArg) process.exit(95);
const url = new URL(urlArg);
const key = decodeURIComponent(url.pathname.replace(/^\\/+/, ''));
const outputIndex = args.indexOf('--output');
if (key.startsWith('channels/beta/releases/') || key === 'channels/beta/states/no-release.json') {
  const origin = process.env.TINKLE_MUTATE_ORIGIN;
  if (origin === 'r2' || origin === 'oss') {
    const root = origin === 'r2' ? process.env.TINKLE_R2_PUBLIC : process.env.TINKLE_OSS_PUBLIC;
    fs.writeFileSync(path.join(root, process.env.TINKLE_DMG_NAME), 'CORRUPTED-AFTER-IMMUTABLE-READBACK');
    fs.writeFileSync(process.env.TINKLE_MUTATION_LOG, origin);
  }
  process.stdout.write(fs.readFileSync(path.join(process.env.TINKLE_STORE, ...key.split('/'))));
  process.exit(0);
}
if (key.startsWith('releases/')) {
  const root = url.hostname === 'oss.example' ? process.env.TINKLE_OSS_PUBLIC : process.env.TINKLE_R2_PUBLIC;
  const source = path.join(root, path.basename(key));
  if (outputIndex >= 0) fs.copyFileSync(source, args[outputIndex + 1]);
  else process.stdout.write(fs.readFileSync(source));
  process.exit(0);
}
if (key === 'channels/beta/current.json') {
  process.stdout.write(fs.readFileSync(path.join(process.env.TINKLE_STORE, ...key.split('/'))));
  process.exit(0);
}
process.exit(96);
`, 'utf8');
      await writeFile(bashEnvPath, `
stat() {
  if [[ "$1" == '-c' && "$2" == '%s' ]]; then
    node -e 'console.log(require("node:fs").statSync(process.argv[1]).size)' "$3"
  else
    command stat "$@"
  fi
}
sha256sum() {
  if [[ "$1" == '--check' ]]; then
    node -e '
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const expected = fs.readFileSync(process.argv[1], "utf8").trim().split(/\\s+/u)[0];
      const actual = crypto.createHash("sha256").update(fs.readFileSync(0)).digest("hex");
      if (actual !== expected) process.exit(1);
      process.stdout.write("-: OK\\n");
    ' "$2"
  else
    command sha256sum "$@"
  fi
}
gh() { node "$TINKLE_FAKE_GH" "$@"; }
aws() { node "$TINKLE_FAKE_AWS" "$@"; }
curl() { node "$TINKLE_FAKE_CURL" "$@"; }
`, 'utf8');

      const result = spawnSync('bash', ['-c', promoteScript], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASH_ENV: bashEnvPath,
          GH_TOKEN: 'fixture-token',
          AWS_ACCESS_KEY_ID: 'fixture-access',
          AWS_SECRET_ACCESS_KEY: 'fixture-secret',
          AWS_DEFAULT_REGION: 'auto',
          R2_ENDPOINT: 'https://fixture.r2.example',
          R2_BUCKET: 'fixture-bucket',
          R2_PUBLIC_BASE_URL: 'https://r2.example',
          ALIYUN_OSS_PUBLIC_BASE_URL: 'https://oss.example',
          GITHUB_REPOSITORY: 'daymade/flowzero-releases',
          GITHUB_ACTION_PATH: path.join(repoRoot, '.github', 'actions', 'promote-update-channel'),
          RUNNER_TEMP: root,
          RELEASE_TAG: channelState === 'published' ? tag : '',
          CHANNEL_STATE: channelState,
          UPDATE_CHANNEL: 'beta',
          ALLOW_DOWNGRADE: 'false',
          TINKLE_ASSET_ROOT: assetRoot,
          TINKLE_RELEASE_JSON: releasePath,
          TINKLE_LEDGER: ledgerPath,
          TINKLE_STORE: storeRoot,
          TINKLE_R2_PUBLIC: r2PublicRoot,
          TINKLE_OSS_PUBLIC: ossPublicRoot,
          TINKLE_CAS_LOG: casLog,
          TINKLE_MUTATION_LOG: mutationLog,
          TINKLE_MUTATE_ORIGIN: mutateOrigin,
          TINKLE_DMG_NAME: names.dmg,
          TINKLE_FAKE_GH: fakeGhPath,
          TINKLE_FAKE_AWS: fakeAwsPath,
          TINKLE_FAKE_CURL: fakeCurlPath,
        },
      });
      const readOptional = async (filePath) => readFile(filePath, 'utf8').catch((error) => (
        error.code === 'ENOENT' ? '' : Promise.reject(error)
      ));
      const cas = await readOptional(casLog);
      if (channelState === 'no_release') {
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(cas, 'CAS\n');
        assert.doesNotMatch(
          `${result.stdout}\n${result.stderr}`,
          /release-asset-identity|jq: error/iu,
        );
      } else if (mutateOrigin === 'none') {
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(cas, 'CAS\n');
      } else {
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(await readFile(mutationLog, 'utf8'), mutateOrigin);
        assert.equal(cas, '', `current.json CAS occurred after ${mutateOrigin} mutation`);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          new RegExp(`public ${mutateOrigin.toUpperCase()} bytes immediately before channel CAS`, 'u'),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  for (const mutateOrigin of ['none', 'r2', 'oss']) {
    await runCase(mutateOrigin);
  }
  await runCase('none', 'no_release');
});

test('immutable channel snapshots are conditional while current.json remains the sole mutable pointer', async () => {
  const action = await readFile(
    new URL('../actions/promote-update-channel/action.yml', import.meta.url),
    'utf8',
  );

  assert.match(action, /--key "\$IMMUTABLE_KEY"[\s\S]*--if-none-match '\*'/);
  assert.match(action, /Immutable channel snapshot conflict after concurrent write/);
  assert.match(action, /--key "\$CURRENT_KEY"[\s\S]*"\$\{CURRENT_CONDITION_ARGS\[@\]\}"/u);
  assert.match(action, /CURRENT_CONDITION_ARGS\+=\(--if-match "\$CURRENT_ETAG"\)/u);
  assert.match(action, /CURRENT_CONDITION_ARGS\+=\(--if-none-match '\*'\)/u);
});
