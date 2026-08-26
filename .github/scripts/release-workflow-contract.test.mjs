import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const workerDeployWorkflow = await readFile(
  new URL('../workflows/deploy-release-download-worker.yml', import.meta.url),
  'utf8',
);
const mirrorAction = await readFile(new URL('../actions/mirror-release-assets/action.yml', import.meta.url), 'utf8');
const promoteAction = await readFile(new URL('../actions/promote-update-channel/action.yml', import.meta.url), 'utf8');
const mirrorScript = await readFile(new URL('./mirror-release-assets.mjs', import.meta.url), 'utf8');
const promoteScript = await readFile(new URL('./promote-platform-channel.mjs', import.meta.url), 'utf8');
const archiveScript = await readFile(new URL('./archive-release.mjs', import.meta.url), 'utf8');
const operatorWorkflows = await Promise.all([
  'mirror-published-release.yml',
  'restore-platform-channel.yml',
  'repair-published-platform.yml',
  'withdraw-platform-channel.yml',
  'initialize-empty-update-channel.yml',
].map((name) => readFile(new URL(`../workflows/${name}`, import.meta.url), 'utf8')));

function jobBlock(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing workflow job: ${name}`);
  const tail = workflow.slice(start + marker.length);
  const next = tail.search(/^  [a-z0-9-]+:\n/mu);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + marker.length + next);
}

test('all external actions are pinned to immutable full commit SHAs', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
  const external = uses.filter((value) => !value.startsWith('./'));
  assert.ok(external.length > 0);
  for (const value of external) {
    assert.match(value, /^[^@]+@[a-f0-9]{40}$/u, `un-pinned action: ${value}`);
  }
});

test('the download gateway has remote CD with exact credentials and two-route readback', () => {
  const uses = [...workerDeployWorkflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const value of uses) {
    assert.match(value, /^[^@]+@[a-f0-9]{40}$/u, `un-pinned gateway deploy action: ${value}`);
  }
  assert.match(workerDeployWorkflow, /workflow_dispatch:/u);
  assert.match(workerDeployWorkflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.match(workerDeployWorkflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workerDeployWorkflow, /version: 10\.28\.1/u);
  assert.match(workerDeployWorkflow, /workers\/release-download\/\*\*/u);
  assert.match(workerDeployWorkflow, /pnpm run deploy/u);
  assert.match(workerDeployWorkflow, /secrets\.CLOUDFLARE_API_KEY/u);
  assert.match(workerDeployWorkflow, /secrets\.CLOUDFLARE_EMAIL/u);
  assert.match(workerDeployWorkflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/u);
  assert.match(workerDeployWorkflow, /vars\.FLOWZERO_WORKER_DEV_ORIGIN/u);
  assert.match(workerDeployWorkflow, /vars\.FLOWZERO_DOWNLOAD_ORIGIN/u);
  assert.match(workerDeployWorkflow, /_health/u);
});

test('source qualification runs once and platform builds consume the exact qualified SHA', () => {
  const qualification = jobBlock('qualify-source');
  const macBuild = jobBlock('build-macos');
  const windowsBuild = jobBlock('build-windows');
  assert.match(qualification, /pnpm run lint/u);
  assert.match(qualification, /pnpm run test/u);
  assert.doesNotMatch(macBuild, /pnpm run test/u);
  assert.doesNotMatch(windowsBuild, /pnpm run test/u);
  for (const block of [qualification, macBuild, windowsBuild]) {
    assert.match(block, /ref: \$\{\{ needs\.prepare\.outputs\.head_sha \}\}/u);
  }
});

test('macOS and Windows have independent build, mirror, promotion, and canary DAGs', () => {
  const macMirror = jobBlock('mirror-macos');
  const windowsMirror = jobBlock('mirror-windows');
  const macPromote = jobBlock('promote-macos');
  const windowsPromote = jobBlock('promote-windows');
  assert.match(macMirror, /needs: \[prepare, finalize-macos, accept-macos\]/u);
  assert.doesNotMatch(macMirror, /build-windows|accept-windows/u);
  assert.match(windowsMirror, /needs: \[prepare, build-windows, accept-windows\]/u);
  assert.doesNotMatch(windowsMirror, /build-macos|accept-macos/u);
  assert.match(macPromote, /group: flowzero-promote-\$\{\{ needs\.prepare\.outputs\.channel \}\}-macos-arm64/u);
  assert.match(windowsPromote, /group: flowzero-promote-\$\{\{ needs\.prepare\.outputs\.channel \}\}-windows-x64/u);
  assert.match(jobBlock('canary-macos'), /verify-channel-canary\.mjs[\s\S]*--platform macos-arm64/u);
  assert.match(jobBlock('canary-windows'), /verify-channel-canary\.mjs[\s\S]*--platform windows-x64/u);
});

test('the release-blocking Mac verifier is the packaged local multi-speaker business journey', () => {
  const acceptance = jobBlock('accept-macos');
  const mirror = jobBlock('mirror-macos');
  assert.match(acceptance, /--suite macos-voice-context/u);
  assert.match(acceptance, /--subject-file[\s\S]*\.dmg/u);
  assert.match(mirror, /needs: \[prepare, finalize-macos, accept-macos\]/u);
  assert.doesNotMatch(workflow, /--suite macos-agent-runtime/u);
});

test('notarization resumes from an immutable artifact ID without reinstalling or invoking Forge', () => {
  const finalizer = jobBlock('finalize-macos');
  assert.match(finalizer, /artifact-ids: \$\{\{ needs\.build-macos\.outputs\.stage_artifact_id \}\}/u);
  assert.match(finalizer, /release-notarize-ci\.cjs resume/u);
  assert.match(finalizer, /release-finalize-macos\.cjs/u);
  assert.match(finalizer, /apple-notary-log\.json/u);
  assert.match(finalizer, /notarization-state\.json/u);
  assert.doesNotMatch(finalizer, /pnpm install|electron-forge|release:build:ci/u);
  assert.match(finalizer, /retention-days: 30/u);
  assert.doesNotMatch(workflow, /delete-artifact/u);
});

test('mirror and promotion are manifest-driven and never rediscover or fully redownload binaries', () => {
  assert.match(mirrorAction, /candidate-manifest/u);
  assert.match(mirrorAction, /mirror-release-assets\.mjs/u);
  assert.doesNotMatch(mirrorScript, /find\s+.*-type f/u);
  assert.doesNotMatch(mirrorScript, /s3api', 'get-object/u);
  assert.doesNotMatch(mirrorScript, /api', 'get-object/u);
  assert.match(mirrorScript, /--checksum-sha256/u);
  assert.match(mirrorScript, /--content-md5/u);
  assert.match(promoteAction, /mirrored-checkpoint/u);
  assert.match(promoteScript, /currentKey = `\$\{baseKey\}\/current\.json`/u);
  assert.match(promoteScript, /--if-match/u);
  assert.match(promoteScript, /--if-none-match/u);
  assert.doesNotMatch(promoteScript, /gh release download/u);
  assert.doesNotMatch(promoteScript, /curl[\s\S]*--output[^\n]*(?!\/dev\/null)/u);
  assert.match(promoteScript, /checkpoints\/\$\{manifest\.tag\}\.json/u);
});

test('GitHub archive is a presentation layer and does not gate platform promotion', () => {
  const archive = jobBlock('archive-release');
  const macPromote = jobBlock('promote-macos');
  const windowsPromote = jobBlock('promote-windows');
  assert.match(archive, /archive-release\.mjs/u);
  assert.match(archive, /needs: \[prepare, mirror-macos, mirror-windows, canary-macos, canary-windows\]/u);
  assert.doesNotMatch(macPromote, /archive-release/u);
  assert.doesNotMatch(windowsPromote, /archive-release/u);
  assert.match(archive, /permissions:[\s\S]*contents: write/u);
  assert.doesNotMatch(jobBlock('build-macos'), /contents: write/u);
  assert.doesNotMatch(jobBlock('accept-macos'), /contents: write/u);
});

test('ordering and current tombstone policy are checked before every external write boundary', () => {
  for (const name of ['mirror-macos', 'mirror-windows']) {
    const block = jobBlock(name);
    assert.ok(
      block.indexOf('assert-platform-release-forward.mjs') < block.indexOf('uses: ./.github/actions/mirror-release-assets'),
      `${name} does not reject downgrades before immutable mirror writes`,
    );
  }
  for (const source of [mirrorScript, promoteScript]) {
    assert.match(source, /assertCurrentReleaseTagAllowed/u);
  }
  assert.match(archiveScript, /assertCurrentReleaseTagAllowed/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /head_sha:/u);
  assert.match(workflow, /platforms:/u);
  assert.match(workflow, /variant:/u);
});

test('privileged jobs consume the release infrastructure SHA frozen at transaction start', () => {
  for (const name of [
    'mirror-macos',
    'mirror-windows',
    'promote-macos',
    'promote-windows',
    'archive-release',
  ]) {
    assert.match(
      jobBlock(name),
      /ref: \$\{\{ needs\.prepare\.outputs\.release_infra_sha \}\}/u,
      `${name} does not pin release infrastructure`,
    );
  }
});

test('every operator path shares the same non-cancelling per-platform writer lock', () => {
  for (const source of operatorWorkflows) {
    assert.match(source, /group: flowzero-promote-\$\{\{ inputs\.channel \}\}-\$\{\{ inputs\.platform \}\}/u);
    assert.match(source, /cancel-in-progress: false/u);
  }
  assert.match(operatorWorkflows[1], /checkpoints\/\$\{\{ inputs\.tag \}\}\.json/u);
  assert.match(operatorWorkflows[2], /rehydrate-platform-archive\.mjs/u);
  assert.match(operatorWorkflows[3], /withdraw-platform-channel\.mjs/u);
});
