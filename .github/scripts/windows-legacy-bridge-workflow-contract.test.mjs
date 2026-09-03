import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const holdWorkflow = await readFile(
  new URL('../workflows/qualify-windows-legacy-bridge.yml', import.meta.url),
  'utf8',
);
const releaseWorkflow = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const mirrorScript = await readFile(new URL('./mirror-windows-legacy-bridge.mjs', import.meta.url), 'utf8');
const contractScript = await readFile(new URL('./windows-legacy-bridge-contract.mjs', import.meta.url), 'utf8');
const promoteScript = await readFile(new URL('./promote-platform-channel.mjs', import.meta.url), 'utf8');

function jobBlock(workflow, name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing workflow job: ${name}`);
  const tail = workflow.slice(start + marker.length);
  const next = tail.search(/^  [a-z0-9-]+:\n/mu);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + marker.length + next);
}

test('qualification hold has an explicit Windows-only DAG and pinned external actions', () => {
  const uses = [...holdWorkflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const value of uses.filter((entry) => !entry.startsWith('./'))) {
    assert.match(value, /^[^@]+@[a-f0-9]{40}$/u, `un-pinned hold action: ${value}`);
  }
  assert.match(holdWorkflow, /types: \[windows_legacy_bridge_qualification\]/u);
  assert.match(holdWorkflow, /operation: 'legacy_bridge'|windows-legacy-bridge-contract\.mjs build-intent/u);
  assert.match(holdWorkflow, /--bridge-version/u);
  assert.match(holdWorkflow, /windows-2025/u);
  assert.doesNotMatch(holdWorkflow, /macos-arm64/u);
  assert.match(jobBlock(holdWorkflow, 'prepare-hold-intent'), /needs: powershell-signing-evidence-preflight/u);
  assert.match(jobBlock(holdWorkflow, 'build-bridge'), /needs: prepare-hold-intent/u);
  assert.match(jobBlock(holdWorkflow, 'accept-bridge'), /needs: \[prepare-hold-intent, build-bridge\]/u);
  assert.match(jobBlock(holdWorkflow, 'mirror-to-hold'), /needs: \[prepare-hold-intent, build-bridge, accept-bridge\]/u);
  assert.match(
    jobBlock(holdWorkflow, 'mirror-to-hold'),
    /group: flowzero-promote-\$\{\{ needs\.prepare-hold-intent\.outputs\.channel \}\}-windows-x64/u,
  );
});

test('manual hold inputs reach shell only through environment variables', () => {
  const runBlocks = [...holdWorkflow.matchAll(/^\s{8}run: [>|]-?\n((?:\s{10,}.*\n)*)/gmu)]
    .map((match) => match[1]);
  assert.ok(runBlocks.length > 0);
  for (const block of runBlocks) {
    assert.doesNotMatch(block, /\$\{\{\s*inputs\./u);
  }
  for (const name of [
    'INPUT_SOURCE_HEAD_SHA',
    'INPUT_BRIDGE_VERSION',
    'INPUT_AFFECTED_VERSIONS_JSON',
    'INPUT_TARGET_VERSION',
    'INPUT_TARGET_FEED_URL',
    'INPUT_TARGET_SETUP_URL',
    'INPUT_WINDOWS_SIGNING_POLICY',
    'INPUT_TRANSACTION_ID',
  ]) {
    assert.match(holdWorkflow, new RegExp(`${name}: \\$\\{\\{ inputs\\.`, 'u'));
  }
});

test('invalid shared source fails before any immutable tag reservation write', () => {
  const prepare = jobBlock(holdWorkflow, 'prepare-hold-intent');
  const sourceValidation = prepare.indexOf('windows-legacy-bridge-contract.mjs validate-shared-source');
  const mainAncestryValidation = prepare.indexOf('compare/${QUALIFIED_SOURCE_HEAD_SHA}...main');
  const signingPreflight = prepare.indexOf('Require Windows signing configuration before reserving immutable tags');
  const reservationWrite = prepare.indexOf('windows-legacy-bridge-reservation.mjs reserve-intent');
  assert.ok(sourceValidation >= 0, 'missing pre-reservation shared-source validation');
  assert.ok(mainAncestryValidation >= 0, 'missing pre-reservation private-main ancestry validation');
  assert.ok(signingPreflight >= 0, 'missing pre-reservation signing configuration gate');
  assert.ok(reservationWrite >= 0, 'missing immutable tag reservation');
  assert.ok(sourceValidation < reservationWrite, 'source validation occurs after immutable reservation');
  assert.ok(mainAncestryValidation < reservationWrite, 'main ancestry validation occurs after immutable reservation');
  assert.ok(signingPreflight < reservationWrite, 'signing configuration is checked after immutable reservation');
  assert.equal(
    (prepare.match(/windows-legacy-bridge-reservation\.mjs reserve-intent/gu) || []).length,
    1,
    'qualification must have exactly one reservation write boundary',
  );
  assert.match(prepare, /ref: \$\{\{ steps\.requested-identity\.outputs\.head_sha \}\}/u);
  assert.match(prepare, /--intent "\$RUNNER_TEMP\/legacy-bridge-intent\/intent\.json"/u);
  assert.match(holdWorkflow, /windows_signing_policy:[\s\S]*default: unsigned[\s\S]*- unsigned[\s\S]*- authenticode/u);
  assert.match(
    prepare.slice(signingPreflight, reservationWrite),
    /if: steps\.requested-identity\.outputs\.windows_signing_policy == 'authenticode'/u,
  );
  assert.match(prepare, /WINDOWS_CERT_PFX_PRESENT: \$\{\{ secrets\.WINDOWS_CERT_PFX != '' \}\}/u);
  assert.match(prepare, /WINDOWS_CERT_PASSWORD_PRESENT: \$\{\{ secrets\.WINDOWS_CERT_PASSWORD != '' \}\}/u);
  assert.doesNotMatch(
    prepare.slice(signingPreflight, reservationWrite),
    /WINDOWS_CERT_PFX:|WINDOWS_CERT_PASSWORD:/u,
  );
});

test('hold workflow delegates build and verification to exactly the canonical source entrypoints', () => {
  assert.equal((holdWorkflow.match(/pnpm run release:build:windows-legacy-bridge:ci --/gu) || []).length, 1);
  assert.equal((holdWorkflow.match(/pnpm run release:verify:windows-legacy-bridge:ci --/gu) || []).length, 2);
  const preflight = jobBlock(holdWorkflow, 'powershell-signing-evidence-preflight');
  assert.match(preflight, /runs-on: windows-2025/u);
  assert.match(preflight, /before any immutable reservation/u);
  assert.match(preflight, /repository: daymade\/flowzero/u);
  assert.match(
    preflight,
    /ref: \$\{\{ github\.event\.client_payload\.intent\.source\.head_sha \|\| inputs\.head_sha \}\}/u,
  );
  assert.match(preflight, /--mode powershell-signing-probe/u);
  assert.doesNotMatch(
    preflight,
    /reserve-intent|WINDOWS_CERT_PFX|WINDOWS_CERT_PASSWORD|continue-on-error|^\s+if:/mu,
  );
  const prepare = jobBlock(holdWorkflow, 'prepare-hold-intent');
  assert.doesNotMatch(prepare, /^    if:|continue-on-error:/mu);
  assert.match(holdWorkflow, /missing canonical bridge build script/u);
  assert.match(holdWorkflow, /missing canonical bridge verification script/u);
  assert.match(holdWorkflow, /validate-candidate/u);
  assert.match(holdWorkflow, /validate-verification/u);
  assert.match(holdWorkflow, /FLOWZERO_LEGACY_BRIDGE_TARGET_VERSION/u);
  assert.match(holdWorkflow, /FLOWZERO_LEGACY_BRIDGE_TARGET_FEED_URL/u);
  assert.match(holdWorkflow, /FLOWZERO_LEGACY_BRIDGE_TARGET_SETUP_URL/u);
  assert.match(holdWorkflow, /needs\.prepare-hold-intent\.outputs\.windows_signing_policy == 'authenticode'/u);
});

test('qualification builds the bridge from the exact source shared with the planned target', () => {
  const build = jobBlock(holdWorkflow, 'build-bridge');
  assert.match(build, /git rev-parse HEAD/u);
  assert.match(build, /windows-legacy-bridge-contract\.mjs validate-shared-source/u);
  assert.match(build, /--checked-out-head-sha "\$actualHead"/u);
  assert.match(build, /--source-package-version "\$packageVersion"/u);
  assert.doesNotMatch(build, /packageVersion -ne/u);
});

test('bridge build and acceptance resolve pnpm from the exact private source package', () => {
  for (const jobName of ['build-bridge', 'accept-bridge']) {
    const job = jobBlock(holdWorkflow, jobName);
    const setupPnpm = job.indexOf('- name: Setup pnpm');
    const setupNode = job.indexOf('- name: Setup Node.js');
    assert.ok(setupPnpm >= 0, `${jobName} is missing Setup pnpm`);
    assert.ok(setupNode > setupPnpm, `${jobName} Setup Node.js must follow Setup pnpm`);
    assert.match(
      job.slice(setupPnpm, setupNode),
      /package_json_file: flowzero\/package\.json/u,
      `${jobName} must resolve pnpm from the exact checked-out source`,
    );
  }
});

test('qualification hold has no promotion, canary, archive, or normal release namespace escape', () => {
  for (const forbidden of [
    'promote-update-channel',
    'promote-platform-channel.mjs',
    'verify-channel-canary.mjs',
    'archive-release.mjs',
    'release-platform-checkpoint.mjs',
    'generate-platform-channel-manifest.mjs',
  ]) {
    assert.doesNotMatch(holdWorkflow, new RegExp(forbidden.replace('.', '\\.'), 'u'));
  }
  assert.doesNotMatch(mirrorScript, /putCurrentJson|promotePlatform|archiveRelease/u);
  assert.match(mirrorScript, /legacy-bridges/u);
  assert.match(mirrorScript, /assertCurrentPointerUnchanged\(currentBefore, currentAfterAssets\)/u);
  assert.match(mirrorScript, /assertCurrentPointerUnchanged\(currentBefore, currentAfterCheckpoint\)/u);
  assert.ok(
    mirrorScript.indexOf('assertCurrentPointerUnchanged(currentBefore, currentAfterCheckpoint)')
      < mirrorScript.indexOf('atomicWriteJson(holdPath, finalState.hold)'),
    'hold can be published before the final current.json proof',
  );
  assert.match(mirrorScript, /channels\/\$\{candidate\.candidate\.bridge\.channel\}\/platforms\/windows-x64\/current\.json/u);
});

test('hold and binding schemas are explicit and content-addressed', () => {
  for (const schema of [
    'flowzero.windows_legacy_bridge_intent.v1',
    'flowzero.windows_legacy_bridge_candidate.v1',
    'flowzero.windows_legacy_bridge_verification.v1',
    'flowzero.windows_legacy_bridge_checkpoint.v1',
    'flowzero.windows_legacy_bridge_hold.v1',
    'flowzero.windows_legacy_bridge_compatibility_binding.v1',
    'flowzero.windows_legacy_bridge_two_hop_acceptance.v1',
  ]) {
    assert.match(contractScript, new RegExp(schema.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(contractScript, /binding_id: contentId\(binding\)/u);
  assert.match(contractScript, /hold_id: contentId\(hold\)/u);
  assert.match(contractScript, /checkpoint_id: contentId\(checkpoint\)/u);
});

test('normal Windows release fails closed on declared compatibility and promotes with one current CAS', () => {
  const mirror = jobBlock(releaseWorkflow, 'mirror-windows');
  const promote = jobBlock(releaseWorkflow, 'promote-windows');
  assert.match(mirror, /validate-windows-legacy-bridge-promotion\.mjs/u);
  assert.match(mirror, /compatibility-binding\.json/u);
  assert.match(mirror, /bridge-hold\.json/u);
  assert.match(promote, /compatibility-binding:/u);
  assert.match(promote, /bridge-hold:/u);
  assert.match(promoteScript, /assertWindowsLegacyBridgePromotionReady/u);
  assert.match(releaseWorkflow, /--windows-legacy-bridge-hold-id/u);
  assert.match(releaseWorkflow, /--windows-legacy-bridge-tag/u);
  assert.match(releaseWorkflow, /--windows-legacy-bridge-affected-version/u);
  const acceptance = jobBlock(releaseWorkflow, 'accept-windows');
  assert.match(acceptance, /materialize-windows-legacy-bridge\.mjs/u);
  assert.match(acceptance, /release:verify:windows-legacy-bridge:ci --[\s\S]*--mode two-hop/u);
  assert.match(acceptance, /--candidate-source-sha "\$\{\{ needs\.prepare\.outputs\.head_sha \}\}"/u);
  assert.match(acceptance, /--verifier-source-sha "\$\{\{ needs\.prepare\.outputs\.head_sha \}\}"/u);
  assert.match(acceptance, /windows-legacy-bridge-contract\.mjs build-binding/u);
  assert.equal((promoteScript.match(/putCurrentJson\(env, currentKey,/gu) || []).length, 1);
});
