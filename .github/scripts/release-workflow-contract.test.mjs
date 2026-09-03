import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const workerDeployWorkflow = await readFile(
  new URL('../workflows/deploy-release-download-worker.yml', import.meta.url),
  'utf8',
);
const betaUpdateServiceRecoveryWorkflow = await readFile(
  new URL('../workflows/deploy-beta-update-service-recovery.yml', import.meta.url),
  'utf8',
);
const mirrorAction = await readFile(new URL('../actions/mirror-release-assets/action.yml', import.meta.url), 'utf8');
const promoteAction = await readFile(new URL('../actions/promote-update-channel/action.yml', import.meta.url), 'utf8');
const mirrorScript = await readFile(new URL('./mirror-release-assets.mjs', import.meta.url), 'utf8');
const promoteScript = await readFile(new URL('./promote-platform-channel.mjs', import.meta.url), 'utf8');
const archiveScript = await readFile(new URL('./archive-release.mjs', import.meta.url), 'utf8');
const assembleArchiveScript = await readFile(
  new URL('./assemble-release-archive.mjs', import.meta.url),
  'utf8',
);
const rehydrateArchiveScript = await readFile(
  new URL('./rehydrate-platform-archive.mjs', import.meta.url),
  'utf8',
);
const claimScript = await readFile(new URL('./claim-release-transaction.mjs', import.meta.url), 'utf8');
const resumeMirrorWorkflow = await readFile(
  new URL('../workflows/resume-platform-mirror.yml', import.meta.url),
  'utf8',
);
const reverifyMacBusinessWorkflow = await readFile(
  new URL('../workflows/reverify-macos-business.yml', import.meta.url),
  'utf8',
);
const operatorWorkflows = await Promise.all([
  'mirror-published-release.yml',
  'resume-platform-mirror.yml',
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

test('the public recovery lane deploys one exact private update-server SHA without weakening canaries', () => {
  const uses = [...betaUpdateServiceRecoveryWorkflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const value of uses) {
    assert.match(value, /^[^@]+@[a-f0-9]{40}$/u, `un-pinned update-service recovery action: ${value}`);
  }
  assert.match(betaUpdateServiceRecoveryWorkflow, /workflow_dispatch:/u);
  assert.doesNotMatch(betaUpdateServiceRecoveryWorkflow, /^\s+push:/mu);
  assert.match(betaUpdateServiceRecoveryWorkflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /update_server_sha:[\s\S]*?required: true/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /beta_verification_mode:[\s\S]*?required: true/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /repository: daymade\/flowzero-update-server/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /token: \$\{\{ secrets\.FLOWZERO_REPO_TOKEN \}\}/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /ref: \$\{\{ inputs\.update_server_sha \}\}/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /git\/ref\/heads\/main/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /test "\$UPDATE_SERVER_SHA" = "\$main_sha"/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /select\(\.status == "queued" or \.status == "in_progress"\)/u);
  assert.equal(
    [...betaUpdateServiceRecoveryWorkflow.matchAll(/gh variable get FLOWZERO_UPDATE_DEPLOYMENT_LANE --repo daymade\/flowzero-update-server/gu)].length,
    2,
  );
  assert.match(betaUpdateServiceRecoveryWorkflow, /test "\$lane" = 'public_recovery'/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /FLOWZERO_BETA_PUSH_POLICY/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /test "\$policy" = 'manual_pre_target'/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /FLOWZERO_UPDATE_DEPLOYMENT_LEASE/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /owner="run:\$\{GITHUB_RUN_ID\}:attempt:\$\{GITHUB_RUN_ATTEMPT\}"/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /steps\.lease\.outputs\.acquired == 'true'/u);
  const leaseReleaseStart = betaUpdateServiceRecoveryWorkflow.indexOf(
    '      - name: Release the private deployment lease',
  );
  const leaseReleaseEnd = betaUpdateServiceRecoveryWorkflow.indexOf(
    '\n        env:',
    leaseReleaseStart,
  );
  assert.ok(leaseReleaseStart >= 0 && leaseReleaseEnd > leaseReleaseStart);
  const leaseReleaseStep = betaUpdateServiceRecoveryWorkflow.slice(
    leaseReleaseStart,
    leaseReleaseEnd,
  );
  assert.match(
    leaseReleaseStep,
    /test "\$\(gh variable get FLOWZERO_UPDATE_DEPLOYMENT_LEASE --repo daymade\/flowzero-update-server\)" = "\$owner"[\s\S]*gh variable set FLOWZERO_UPDATE_DEPLOYMENT_LEASE[\s\S]*--body none[\s\S]*released=false[\s\S]*for delay in 1 2 4 8; do[\s\S]*if current="\$\(gh variable get FLOWZERO_UPDATE_DEPLOYMENT_LEASE --repo daymade\/flowzero-update-server\)"; then[\s\S]*if \[\[ "\$current" = 'none' \]\]; then[\s\S]*released=true[\s\S]*break[\s\S]*fi[\s\S]*test "\$current" = "\$owner"[\s\S]*fi[\s\S]*sleep "\$delay"[\s\S]*done[\s\S]*if \[\[ "\$released" != 'true' \]\]; then[\s\S]*deployment lease release did not converge to none[\s\S]*exit 1/u,
  );
  assert.doesNotMatch(
    betaUpdateServiceRecoveryWorkflow,
    /gh variable get FLOWZERO_UPDATE_DEPLOYMENT_LEASE[^\n]*\|\|\s*true/u,
  );
  assert.match(betaUpdateServiceRecoveryWorkflow, /npm test/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /vercel@50\.37\.3/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /npm run deploy:check/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /scripts\/deploy-production\.cjs --channel beta/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /scripts\/verify-production-deployment\.cjs/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /--verification-mode "\$BETA_VERIFICATION_MODE"/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /--windows-legacy-bridge-target-version/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /secrets\.VERCEL_TOKEN/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /vars\.FLOWZERO_BETA_WINDOWS_LEGACY_BRIDGE_MANIFEST_URL/u);
  assert.match(betaUpdateServiceRecoveryWorkflow, /vars\.FLOWZERO_BETA_WINDOWS_LEGACY_BRIDGE_TARGET_VERSION/u);
  assert.doesNotMatch(betaUpdateServiceRecoveryWorkflow, /continue-on-error:/u);
});

test('source qualification runs once and platform builds consume the exact qualified SHA', () => {
  const qualification = jobBlock('qualify-source');
  const macBuild = jobBlock('build-macos');
  const windowsBuild = jobBlock('build-windows');
  assert.match(qualification, /pnpm run lint/u);
  assert.match(qualification, /pnpm run test:source:ci/u);
  assert.match(qualification, /pnpm run license:source:ci/u);
  assert.match(qualification, /lfs: false/u);
  assert.doesNotMatch(qualification, /lfs: true/u);
  assert.doesNotMatch(qualification, /pnpm run verify:media-runtime/u);
  assert.doesNotMatch(qualification, /build-meeting-e2e-fixtures\.cjs/u);
  assert.doesNotMatch(macBuild, /pnpm run test:source:ci/u);
  assert.doesNotMatch(windowsBuild, /pnpm run test:source:ci/u);
  assert.match(macBuild, /pnpm run test:native-media:ci/u);
  assert.match(windowsBuild, /pnpm run test:native-media:ci/u);
  assert.match(macBuild, /lfs: true/u);
  assert.match(windowsBuild, /lfs: true/u);
  assert.match(macBuild, /pnpm run release:build:ci/u);
  assert.match(windowsBuild, /pnpm run release:build:ci/u);
  for (const block of [qualification, macBuild, windowsBuild]) {
    assert.match(block, /ref: \$\{\{ needs\.prepare\.outputs\.head_sha \}\}/u);
  }
});

test('every downstream release job is gated by the durable transaction owner claim', () => {
  for (const name of [
    'qualify-source',
    'build-macos',
    'finalize-macos',
    'accept-macos-fixture',
    'accept-macos-live-stepfun',
    'accept-macos',
    'build-windows',
    'accept-windows',
    'mirror-macos',
    'mirror-windows',
    'promote-macos',
    'promote-windows',
    'canary-macos',
    'canary-windows',
    'archive-release',
  ]) {
    assert.match(
      jobBlock(name),
      /needs\.prepare\.outputs\.is_owner == 'true'/u,
      `${name} can run without owning the durable release transaction`,
    );
  }
});

test('Windows defaults to explicit unsigned delivery and gates certificate use behind Authenticode', () => {
  const prepare = jobBlock('prepare');
  const windowsBuild = jobBlock('build-windows');
  const windowsAcceptance = jobBlock('accept-windows');
  const signingPreflight = prepare.indexOf('Require Windows signing configuration before durable reservation');
  const bridgeReservation = prepare.indexOf('windows-legacy-bridge-reservation.mjs assert-transaction');
  const ownerClaim = prepare.indexOf('claim-release-transaction.mjs');
  assert.ok(signingPreflight >= 0, 'missing pre-reservation Windows signing gate');
  assert.ok(bridgeReservation > signingPreflight, 'bridge reservation precedes Windows signing gate');
  assert.ok(ownerClaim > signingPreflight, 'release owner claim precedes Windows signing gate');
  const preflight = prepare.slice(signingPreflight, bridgeReservation);
  assert.match(workflow, /windows_signing_policy:[\s\S]*default: unsigned[\s\S]*- unsigned[\s\S]*- authenticode/u);
  assert.match(
    preflight,
    /if: steps\.transaction\.outputs\.windows_requested == 'true' && steps\.transaction\.outputs\.windows_signing_policy == 'authenticode'/u,
  );
  assert.match(preflight, /WINDOWS_CERT_PFX_PRESENT: \$\{\{ secrets\.WINDOWS_CERT_PFX != '' \}\}/u);
  assert.match(preflight, /WINDOWS_CERT_PASSWORD_PRESENT: \$\{\{ secrets\.WINDOWS_CERT_PASSWORD != '' \}\}/u);
  assert.doesNotMatch(preflight, /WINDOWS_CERT_PFX:|WINDOWS_CERT_PASSWORD:/u);
  assert.match(windowsBuild, /--windows-signing-policy "\$\{\{ needs\.prepare\.outputs\.windows_signing_policy \}\}"/u);
  assert.match(windowsBuild, /needs\.prepare\.outputs\.windows_signing_policy == 'authenticode'/u);
  assert.match(
    jobBlock('mirror-windows'),
    /artifact-ids: \$\{\{ needs\.prepare\.outputs\.transaction_artifact_id \}\}[\s\S]*--transaction "\$RUNNER_TEMP\/windows-transaction\/release-transaction\.json"/u,
  );
  assert.match(
    windowsAcceptance,
    /--candidate-manifest "\$env:RUNNER_TEMP\/windows-final\/evidence\/candidate\.json"/u,
  );
});

test('macOS and Windows have independent build, mirror, promotion, and canary DAGs', () => {
  const macFixtureAcceptance = jobBlock('accept-macos-fixture');
  const macLiveAcceptance = jobBlock('accept-macos-live-stepfun');
  const macAcceptance = jobBlock('accept-macos');
  const macMirror = jobBlock('mirror-macos');
  const windowsMirror = jobBlock('mirror-windows');
  const macPromote = jobBlock('promote-macos');
  const windowsPromote = jobBlock('promote-windows');
  assert.match(macFixtureAcceptance, /needs: \[prepare, finalize-macos\]/u);
  assert.match(macLiveAcceptance, /needs: \[prepare, finalize-macos\]/u);
  assert.match(
    macAcceptance,
    /needs: \[prepare, accept-macos-fixture, accept-macos-live-stepfun\]/u,
  );
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
  const fixtureAcceptance = jobBlock('accept-macos-fixture');
  const liveAcceptance = jobBlock('accept-macos-live-stepfun');
  const acceptance = jobBlock('accept-macos');
  const mirror = jobBlock('mirror-macos');
  assert.match(fixtureAcceptance, /build-meeting-e2e-fixtures\.cjs/u);
  assert.match(fixtureAcceptance, /--suite macos-voice-context/u);
  assert.doesNotMatch(fixtureAcceptance, /--suite macos-live-stepfun-timeline/u);
  assert.match(liveAcceptance, /build-meeting-e2e-fixtures\.cjs/u);
  assert.match(liveAcceptance, /--suite macos-live-stepfun-timeline/u);
  assert.match(liveAcceptance, /id: live-stepfun/u);
  assert.match(liveAcceptance, /--failure-output "\$RUNNER_TEMP\/mac-verification\/live-stepfun-timeline\.failure\.json"/u);
  assert.match(liveAcceptance, /always\(\) && steps\.live-stepfun\.outcome == 'failure'/u);
  assert.match(liveAcceptance, /macos-live-stepfun-diagnostic-/u);
  assert.match(liveAcceptance, /live-stepfun-timeline\.failure\.json[\s\S]*if-no-files-found: error/u);
  assert.doesNotMatch(liveAcceptance, /--suite macos-voice-context/u);
  assert.match(
    liveAcceptance,
    /FLOWZERO_VERIFY_STEPFUN_API_KEY: \$\{\{ secrets\.FLOWZERO_STEPFUN_API_KEY \}\}/u,
  );
  assert.match(fixtureAcceptance, /--subject-file[\s\S]*\.dmg/u);
  assert.match(liveAcceptance, /--subject-file[\s\S]*\.dmg/u);
  assert.match(
    acceptance,
    /needs: \[prepare, accept-macos-fixture, accept-macos-live-stepfun\]/u,
  );
  assert.match(
    acceptance,
    /artifact-ids: \$\{\{ needs\.accept-macos-fixture\.outputs\.verification_artifact_id \}\}/u,
  );
  assert.match(
    acceptance,
    /artifact-ids: \$\{\{ needs\.accept-macos-live-stepfun\.outputs\.verification_artifact_id \}\}/u,
  );
  assert.match(acceptance, /verification\.json/u);
  assert.match(acceptance, /live-stepfun-timeline\.json/u);
  assert.doesNotMatch(acceptance, /--suite|pnpm install|actions\/checkout/u);
  assert.equal(
    (mirror.match(/--verification "\$RUNNER_TEMP\/mac-verification\//gu) || []).length,
    4,
  );
  assert.equal(
    (mirror.match(/live-stepfun-timeline\.json/gu) || []).length,
    2,
  );
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
  assert.doesNotMatch(mirrorScript, /'--content-md5'/u);
  assert.match(mirrorScript, /etag === asset\.md5Hex/u);
  assert.match(promoteAction, /mirrored-checkpoint/u);
  assert.match(promoteScript, /currentKey = `\$\{baseKey\}\/current\.json`/u);
  assert.match(promoteScript, /--if-match/u);
  assert.match(promoteScript, /--if-none-match/u);
  assert.doesNotMatch(promoteScript, /gh release download/u);
  assert.doesNotMatch(promoteScript, /curl[\s\S]*--output[^\n]*(?!\/dev\/null)/u);
  assert.match(promoteScript, /checkpoints\/\$\{manifest\.tag\}\.json/u);
});

test('a failed mirror resumes from exact accepted artifacts without rebuilding', () => {
  const uses = [...resumeMirrorWorkflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  for (const value of uses.filter((entry) => !entry.startsWith('./'))) {
    assert.match(value, /^[^@]+@[a-f0-9]{40}$/u, `un-pinned recovery action: ${value}`);
  }
  assert.match(resumeMirrorWorkflow, /ref: \$\{\{ inputs\.toolkit_sha \}\}/u);
  assert.match(resumeMirrorWorkflow, /process\.env\.GITHUB_REF!==['"]refs\/heads\/main['"]/u);
  assert.match(resumeMirrorWorkflow, /ref: \$\{\{ github\.sha \}\}[\s\S]*fetch-depth: 0/u);
  assert.match(resumeMirrorWorkflow, /assert-recovery-toolkit-on-main\.mjs/u);
  assert.ok(
    resumeMirrorWorkflow.indexOf('assert-recovery-toolkit-on-main.mjs')
      < resumeMirrorWorkflow.indexOf('Checkout exact approved recovery toolkit'),
    'untrusted recovery toolkit can execute before main-ancestry verification',
  );
  assert.match(resumeMirrorWorkflow, /artifact-ids: \$\{\{ inputs\.candidate_artifact_id \}\}/u);
  assert.match(resumeMirrorWorkflow, /artifact-ids: \$\{\{ inputs\.verification_artifact_id \}\}/u);
  assert.equal((resumeMirrorWorkflow.match(/run-id: \$\{\{ inputs\.source_run_id \}\}/gu) || []).length, 1);
  assert.match(
    resumeMirrorWorkflow,
    /run-id: \$\{\{ inputs\.verification_run_id \|\| inputs\.source_run_id \}\}/u,
  );
  assert.match(resumeMirrorWorkflow, /--verification-run-id/u);
  const provenanceCommandStart = resumeMirrorWorkflow.indexOf(
    'node .github/scripts/verify-actions-artifact-provenance.mjs'
  );
  const provenanceCommandEnd = resumeMirrorWorkflow.indexOf(
    '--output "$RUNNER_TEMP/state/actions-provenance.json"',
    provenanceCommandStart
  );
  const recoveryCommandStart = resumeMirrorWorkflow.indexOf(
    'node .github/scripts/validate-platform-artifact-recovery.mjs'
  );
  const recoveryCommandEnd = resumeMirrorWorkflow.indexOf(
    '--output "$RUNNER_TEMP/state/recovery-input.json"',
    recoveryCommandStart
  );
  assert.ok(provenanceCommandStart >= 0 && provenanceCommandEnd > provenanceCommandStart);
  assert.ok(recoveryCommandStart >= 0 && recoveryCommandEnd > recoveryCommandStart);
  assert.doesNotMatch(
    resumeMirrorWorkflow.slice(provenanceCommandStart, provenanceCommandEnd),
    /--actions-provenance/u,
  );
  assert.match(
    resumeMirrorWorkflow.slice(recoveryCommandStart, recoveryCommandEnd),
    /--actions-provenance "\$RUNNER_TEMP\/state\/actions-provenance\.json"/u,
  );
  assert.match(resumeMirrorWorkflow, /verify-actions-artifact-provenance\.mjs/u);
  assert.match(resumeMirrorWorkflow, /actions\/artifacts\/\$\{\{ inputs\.candidate_artifact_id \}\}/u);
  assert.match(resumeMirrorWorkflow, /actions\/artifacts\/\$\{\{ inputs\.verification_artifact_id \}\}/u);
  assert.match(resumeMirrorWorkflow, /actions\/runs\/\$\{\{ inputs\.verification_run_id \|\| inputs\.source_run_id \}\}/u);
  assert.equal((resumeMirrorWorkflow.match(/github-token: \$\{\{ github\.token \}\}/gu) || []).length, 2);
  assert.match(resumeMirrorWorkflow, /validate-platform-artifact-recovery\.mjs/u);
  assert.equal((resumeMirrorWorkflow.match(/--transaction "\$RUNNER_TEMP\/platform-final\/evidence\/release-transaction\.json"/gu) || []).length, 3);
  assert.match(resumeMirrorWorkflow, /macos_voice_context_v2/u);
  assert.match(resumeMirrorWorkflow, /live-stepfun-timeline\.json/u);
  assert.match(resumeMirrorWorkflow, /--phase build_created/u);
  assert.match(resumeMirrorWorkflow, /--phase platform_verified/u);
  assert.match(resumeMirrorWorkflow, /uses: \.\/\.github\/actions\/mirror-release-assets/u);
  assert.match(resumeMirrorWorkflow, /--phase mirrored/u);
  assert.match(resumeMirrorWorkflow, /uses: \.\/\.github\/actions\/promote-update-channel/u);
  assert.match(resumeMirrorWorkflow, /verify-channel-canary\.mjs/u);
  assert.match(resumeMirrorWorkflow, /--output "\$RUNNER_TEMP\/state\/canary-receipt\.json"/u);
  assert.match(
    resumeMirrorWorkflow,
    /Preserve recovered mirror, promotion, and canary state[\s\S]*if: \$\{\{ always\(\) \}\}/u,
  );
  assert.doesNotMatch(
    resumeMirrorWorkflow,
    /pnpm install|release:build:ci|electron-forge|notarytool|release-notarize-ci/u,
  );
});

test('current platform recovery preserves immutable transactions and complete Mac receipts', () => {
  const macMirror = jobBlock('mirror-macos');
  assert.equal((macMirror.match(/--transaction "\$RUNNER_TEMP\/mac-final\/evidence\/release-transaction\.json"/gu) || []).length, 3);
  assert.match(workflow, /Bind immutable release transaction into the Mac candidate artifact/u);
  assert.match(assembleArchiveScript, /live-stepfun-timeline\.json/u);
  assert.match(assembleArchiveScript, /verifications: verificationPaths\.map/u);
  assert.match(rehydrateArchiveScript, /live-stepfun-timeline\.json/u);
  assert.match(operatorWorkflows[3], /verification_args=\(--verification/u);
  assert.match(operatorWorkflows[3], /rehydrated\/evidence\/live-stepfun-timeline\.json/u);
});

test('a verifier-only macOS correction reuses one immutable candidate and emits a combined receipt set', () => {
  const uses = [...reverifyMacBusinessWorkflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  for (const value of uses) {
    assert.match(value, /^[^@]+@[a-f0-9]{40}$/u, `un-pinned reverification action: ${value}`);
  }
  assert.match(reverifyMacBusinessWorkflow, /workflow_dispatch:/u);
  assert.match(reverifyMacBusinessWorkflow, /environment: beta-release/u);
  assert.match(reverifyMacBusinessWorkflow, /process\.env\.GITHUB_REF!==['"]refs\/heads\/main['"]/u);
  assert.match(reverifyMacBusinessWorkflow, /candidate_source_sha:/u);
  assert.match(reverifyMacBusinessWorkflow, /verifier_source_sha:/u);
  assert.match(reverifyMacBusinessWorkflow, /git merge-base --is-ancestor/u);
  assert.match(reverifyMacBusinessWorkflow, /CLAUDE\.md\|scripts\/packaged-meeting-ui-smoke\.cjs/u);
  assert.match(reverifyMacBusinessWorkflow, /scripts\/run-packaged-smoke\.cjs/u);
  assert.match(reverifyMacBusinessWorkflow, /docs\/updates\/UPDATE_SERVER\.md/u);
  assert.match(reverifyMacBusinessWorkflow, /verifier-only recovery changed product or unrelated file/u);
  assert.match(reverifyMacBusinessWorkflow, /repository: daymade\/flowzero-releases[\s\S]*ref: \$\{\{ github\.sha \}\}[\s\S]*path: \.release-toolkit/u);
  assert.match(reverifyMacBusinessWorkflow, /artifact-ids: \$\{\{ inputs\.candidate_artifact_id \}\}/u);
  assert.match(reverifyMacBusinessWorkflow, /artifact-ids: \$\{\{ inputs\.fixture_verification_artifact_id \}\}/u);
  assert.equal((reverifyMacBusinessWorkflow.match(/run-id: \$\{\{ inputs\.source_run_id \}\}/gu) || []).length, 2);
  assert.match(reverifyMacBusinessWorkflow, /--suite macos-live-stepfun-timeline/u);
  assert.match(reverifyMacBusinessWorkflow, /id: live-stepfun/u);
  assert.match(reverifyMacBusinessWorkflow, /--failure-output "\$RUNNER_TEMP\/reverified\/live-stepfun-timeline\.failure\.json"/u);
  assert.match(reverifyMacBusinessWorkflow, /always\(\) && steps\.live-stepfun\.outcome == 'failure'/u);
  assert.match(reverifyMacBusinessWorkflow, /macos-live-stepfun-diagnostic-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(reverifyMacBusinessWorkflow, /live-stepfun-timeline\.failure\.json[\s\S]*if-no-files-found: error/u);
  assert.match(reverifyMacBusinessWorkflow, /--head-sha "\$\{\{ inputs\.candidate_source_sha \}\}"/u);
  assert.match(reverifyMacBusinessWorkflow, /--verifier-head-sha "\$\{\{ inputs\.verifier_source_sha \}\}"/u);
  assert.match(reverifyMacBusinessWorkflow, /--candidate-manifest "\$RUNNER_TEMP\/mac-final\/evidence\/candidate\.json"/u);
  assert.match(reverifyMacBusinessWorkflow, /FLOWZERO_VERIFY_STEPFUN_API_KEY: \$\{\{ secrets\.FLOWZERO_STEPFUN_API_KEY \}\}/u);
  assert.match(reverifyMacBusinessWorkflow, /fixture-verification\/verification\.json/u);
  assert.match(reverifyMacBusinessWorkflow, /reverified\/live-stepfun-timeline\.json/u);
  assert.match(reverifyMacBusinessWorkflow, /deterministic fixture receipt verifier identity mismatch/u);
  assert.match(reverifyMacBusinessWorkflow, /live StepFun receipt verifier identity mismatch/u);
  assert.match(reverifyMacBusinessWorkflow, /release-platform-checkpoint\.mjs \\\n+\s+--phase build_created/u);
  assert.match(reverifyMacBusinessWorkflow, /release-platform-checkpoint\.mjs \\\n+\s+--phase platform_verified[\s\S]*--verification "\$RUNNER_TEMP\/fixture-verification\/verification\.json"[\s\S]*--verification "\$RUNNER_TEMP\/reverified\/live-stepfun-timeline\.json"/u);
  assert.match(reverifyMacBusinessWorkflow, /macos-business-reverification-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.doesNotMatch(reverifyMacBusinessWorkflow, /release:build:ci|release:notarize:ci|forge:/u);
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
  assert.match(archive, /permissions:[\s\S]*attestations: read/u);
  assert.doesNotMatch(jobBlock('build-macos'), /contents: write/u);
  assert.doesNotMatch(jobBlock('accept-macos-fixture'), /contents: write/u);
  assert.doesNotMatch(jobBlock('accept-macos-live-stepfun'), /contents: write/u);
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
  assert.match(
    workflow,
    /run-name: release \$\{\{ github\.event\.client_payload\.intent\.release\.version \|\| inputs\.version \}\} \$\{\{ github\.event\.client_payload\.intent\.transaction_id \|\| inputs\.transaction_id \}\}/u,
  );
  assert.match(workflow, /head_sha:/u);
  assert.match(workflow, /transaction_id:/u);
  assert.match(workflow, /platforms:/u);
  assert.match(workflow, /variant:/u);
  assert.match(
    workflow,
    /group: release-version-\$\{\{ github\.event\.client_payload\.intent\.release\.version \|\| inputs\.version \}\}/u,
  );
  assert.match(workflow, /queue: max/u);
  assert.match(workflow, /claim-release-transaction\.mjs/u);
  assert.match(claimScript, /--if-none-match/u);
  assert.match(workflow, /secrets\.R2_ACCESS_KEY_ID/u);
  assert.match(workflow, /steps\.claim\.outputs\.is_owner/u);
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
    assert.match(source, /queue: max/u);
  }
  assert.match(operatorWorkflows[2], /checkpoints\/\$\{\{ inputs\.tag \}\}\.json/u);
  assert.match(operatorWorkflows[3], /rehydrate-platform-archive\.mjs/u);
  assert.equal((operatorWorkflows[3].match(/--transaction "\$RUNNER_TEMP\/rehydrated\/evidence\/release-transaction\.json"/gu) || []).length, 3);
  assert.match(operatorWorkflows[4], /withdraw-platform-channel\.mjs/u);
  for (const name of ['promote-macos', 'promote-windows']) {
    assert.match(jobBlock(name), /cancel-in-progress: false/u);
    assert.match(jobBlock(name), /queue: max/u);
  }
});
