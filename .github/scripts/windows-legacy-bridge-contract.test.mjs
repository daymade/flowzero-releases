import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildManualReleaseIntent,
  canonicalJson,
  validateReleaseIntent,
} from './release-transaction.mjs';
import {
  LEGACY_BRIDGE_BINDING_SCHEMA,
  LEGACY_BRIDGE_CANDIDATE_SCHEMA,
  LEGACY_BRIDGE_HOLD_SCHEMA,
  LEGACY_BRIDGE_MIRROR_RECEIPT_SCHEMA,
  LEGACY_BRIDGE_PURPOSE,
  LEGACY_BRIDGE_TWO_HOP_ACCEPTANCE_SCHEMA,
  LEGACY_BRIDGE_VERIFICATION_SCHEMA,
  buildLegacyBridgeCompatibilityBinding,
  buildLegacyBridgeHold,
  buildLegacyBridgeIntent,
  validateLegacyBridgeCandidate,
  validateLegacyBridgeCompatibilityBinding,
  validateLegacyBridgeIntent,
  validateLegacyBridgeSharedSource,
} from './windows-legacy-bridge-contract.mjs';
import { assertCurrentPointerUnchanged, legacyBridgeNamespace } from './mirror-windows-legacy-bridge.mjs';
import { legacyBridgeHoldKey } from './promote-platform-channel.mjs';
import { assertWindowsLegacyBridgePromotionReady } from './validate-windows-legacy-bridge-promotion.mjs';
import { buildPlatformCheckpoint } from './release-platform-checkpoint.mjs';
import { buildPlatformChannelManifest } from './generate-platform-channel-manifest.mjs';
import {
  buildReleaseArchiveManifest,
  validateReleaseArchiveManifest,
} from './build-release-archive-manifest.mjs';
import {
  assertReleaseCandidateReservations,
  assertReleaseTransactionReservations,
  claimNormalReleaseTagArbitration,
  reservationKey,
  reserveLegacyBridgeIntent,
} from './windows-legacy-bridge-reservation.mjs';

const sourceSha = 'a'.repeat(40);
const infraSha = 'b'.repeat(40);
const digest = character => character.repeat(64);
const contentId = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const targetFeedUrl = 'https://updates-beta.flowzero.app/update/win32/0.1.3-beta.1?channel=beta&app_version=0.1.3-beta.1&update_strategy=squirrel';
const targetSetupUrl = 'https://updates-beta.flowzero.app/download/windows';

function bridgeCandidate(intent = bridgeIntent()) {
  const nupkg = 'Flowzero-0.1.3-beta1-full.nupkg';
  const candidate = {
    purpose: LEGACY_BRIDGE_PURPOSE,
    transaction_id: intent.transaction_id,
    platform: 'windows-x64',
    source: intent.source,
    bridge: intent.bridge,
    target: intent.target,
    affected_versions: intent.affected_versions,
    attempt: {
      release_infrastructure_sha: infraSha,
      workflow_run_id: '41',
      workflow_run_attempt: 1,
    },
    assets: [
      { role: 'windows_bridge_setup', name: 'Flowzero-0.1.3-beta.1-Setup.exe', size: 301, sha256: digest('1') },
      { role: 'windows_bridge_nupkg', name: nupkg, size: 201, sha256: digest('2'), sha1: 'd'.repeat(40) },
      { role: 'windows_bridge_releases', name: 'RELEASES', size: 101, sha256: digest('3') },
    ],
    update: { squirrel_releases: `${'d'.repeat(40)} ${nupkg} 201\n` },
  };
  return {
    schema: LEGACY_BRIDGE_CANDIDATE_SCHEMA,
    purpose: LEGACY_BRIDGE_PURPOSE,
    candidate_id: contentId(candidate),
    candidate,
  };
}

function bridgeIntent() {
  return buildLegacyBridgeIntent({
    sourceHeadSha: sourceSha,
    bridgeVersion: '0.1.3-beta.1',
    affectedVersions: ['0.1.2-beta.7'],
    targetVersion: '0.1.3-beta.2',
    targetFeedUrl,
    targetSetupUrl,
  });
}

function bridgeVerification(candidate = bridgeCandidate()) {
  return {
    schema: LEGACY_BRIDGE_VERIFICATION_SCHEMA,
    purpose: LEGACY_BRIDGE_PURPOSE,
    status: 'pass',
    platform: 'windows-x64',
    candidate_id: candidate.candidate_id,
    transaction_id: candidate.candidate.transaction_id,
    source_head_sha: candidate.candidate.source.head_sha,
    bridge_version: candidate.candidate.bridge.version,
    target_version: candidate.candidate.target.version,
    affected_versions: candidate.candidate.affected_versions,
    evidence: {
      current_pointer_writes: 0,
      target_routing: {
        embedded: true,
        version: candidate.candidate.target.version,
        feed_url: candidate.candidate.target.feed_url,
        setup_url: candidate.candidate.target.setup_url,
      },
      legacy_updater_routes: candidate.candidate.affected_versions.map((version) => ({
        from_version: version,
        to_version: candidate.candidate.bridge.version,
        status: 'pass',
        complete_payload: true,
        launch_verified: true,
        root_updater_replaced: true,
        zero_process_residue: true,
      })),
    },
    verified_at: '2026-09-02T00:00:00.000Z',
  };
}

function bridgeMirrorReceipt(candidate = bridgeCandidate()) {
  const namespace = legacyBridgeNamespace(candidate);
  return {
    schema: LEGACY_BRIDGE_MIRROR_RECEIPT_SCHEMA,
    candidate_id: candidate.candidate_id,
    transaction_id: candidate.candidate.transaction_id,
    platform: 'windows-x64',
    namespace,
    origins: ['r2', 'oss'].map((origin) => ({
      origin,
      objects: candidate.candidate.assets.map((asset) => ({
        name: asset.name,
        key: `${namespace}/assets/${asset.name}`,
        size: asset.size,
        sha256: asset.sha256,
        public_head: true,
        public_range: true,
      })),
    })),
    mirrored_at: '2026-09-02T00:00:00.000Z',
  };
}

function bridgeHold(candidate = bridgeCandidate()) {
  const snapshot = {
    key: 'channels/beta/platforms/windows-x64/current.json',
    state: 'present',
    etag: 'etag',
    size: 42,
    metadata_sha256: digest('4'),
    checksum_sha256: Buffer.from(digest('4'), 'hex').toString('base64'),
    body_sha256: digest('4'),
    readback_checksum_sha256: Buffer.from(digest('4'), 'hex').toString('base64'),
  };
  return buildLegacyBridgeHold({
    candidate,
    verification: bridgeVerification(candidate),
    mirrorReceipt: bridgeMirrorReceipt(candidate),
    currentPointer: {
      current_key: 'channels/beta/platforms/windows-x64/current.json',
      before: snapshot,
      after: structuredClone(snapshot),
      before_digest: contentId(snapshot),
      after_digest: contentId(snapshot),
      unchanged: true,
    },
  }).hold;
}

function targetCandidate(hold = bridgeHold()) {
  const nupkg = 'Flowzero-0.1.3-beta2-full.nupkg';
  const candidate = {
    transaction_id: `sha256:${digest('9')}`,
    platform: 'windows-x64',
    source: { repository: 'daymade/flowzero', head_sha: sourceSha },
    release: { version: '0.1.3-beta.2', tag: 'v0.1.3-beta.2', channel: 'beta', variant: 'standard' },
    attempt: { release_infrastructure_sha: infraSha, workflow_run_id: '42', workflow_run_attempt: 1 },
    assets: [
      { role: 'windows_setup', name: 'Flowzero-0.1.3-beta.2-Setup.exe', content_type: 'application/vnd.microsoft.portable-executable', size: 310, sha256: digest('5') },
      { role: 'windows_nupkg', name: nupkg, content_type: 'application/octet-stream', size: 210, sha256: digest('6'), sha1: 'e'.repeat(40) },
      { role: 'windows_releases', name: 'RELEASES', content_type: 'application/octet-stream', size: 110, sha256: digest('7') },
    ],
    update: {
      squirrel_releases: `${'e'.repeat(40)} ${nupkg} 210\n`,
      windows_legacy_bridge: {
        schema: 'flowzero.windows_legacy_bridge_requirement.v1',
        purpose: LEGACY_BRIDGE_PURPOSE,
        mode: 'required',
        bridge_hold_id: hold.hold_id,
        bridge_tag: hold.hold.bridge.tag,
        affected_versions: ['0.1.2-beta.7'],
      },
    },
  };
  return {
    schema: 'flowzero.release_platform_candidate.v1',
    candidate_id: contentId(candidate),
    candidate,
  };
}

function acceptance(hold = bridgeHold(), target = targetCandidate(hold)) {
  const receipt = {
    schema: LEGACY_BRIDGE_TWO_HOP_ACCEPTANCE_SCHEMA,
    status: 'pass',
    platform: 'windows-x64',
    bridge_candidate_id: hold.hold.candidate_id,
    target_candidate_id: target.candidate_id,
    affected_versions: ['0.1.2-beta.7'],
    routes: [{
      from_version: '0.1.2-beta.7',
      hops: [
        { from_version: '0.1.2-beta.7', to_version: '0.1.3-beta.1', status: 'pass', complete_payload: true, launch_verified: true, zero_process_residue: true },
        { from_version: '0.1.3-beta.1', to_version: '0.1.3-beta.2', status: 'pass', complete_payload: true, launch_verified: true, zero_process_residue: true },
      ],
    }],
    current_pointer_writes: 0,
    verifier_head_sha: target.candidate.source.head_sha,
    accepted_at: '2026-09-02T01:00:00.000Z',
  };
  return { ...receipt, acceptance_id: contentId(receipt) };
}

function rehashAcceptance(receipt) {
  const { acceptance_id: _acceptanceId, ...identity } = receipt;
  receipt.acceptance_id = contentId(identity);
  return receipt;
}

function targetVerification(target) {
  const setup = target.candidate.assets.find((asset) => asset.role === 'windows_setup');
  return {
    schema: 'flowzero.release_verification.v1',
    status: 'pass',
    suite: 'windows-installer',
    version: target.candidate.release.version,
    source_head_sha: target.candidate.source.head_sha,
    platform: 'windows-x64',
    subject: { name: setup.name, size: setup.size, sha256: setup.sha256 },
    evidence: [
      { kind: 'windows_authenticode', status: 'pass', timestamp_present: true },
      { kind: 'windows_installer', status: 'pass' },
    ],
    verified_at: '2026-09-02T02:00:00.000Z',
  };
}

function targetMirrorReceipt(target) {
  return {
    schema: 'flowzero.release_mirror_receipt.v1',
    candidate_id: target.candidate_id,
    transaction_id: target.candidate.transaction_id,
    platform: 'windows-x64',
    origins: ['r2', 'oss'].map((origin) => ({
      origin,
      objects: target.candidate.assets.map((asset) => ({
        name: asset.name,
        key: `releases/${target.candidate.release.tag}/${asset.name}`,
        size: asset.size,
        sha256: asset.sha256,
        server_checksum: origin === 'r2'
          ? `sha256:${Buffer.from(asset.sha256, 'hex').toString('base64')}`
          : `md5:${'a'.repeat(32)}`,
        etag: origin === 'r2' ? 'etag' : 'a'.repeat(32),
        public_head: true,
        public_range: true,
      })),
    })),
    mirrored_at: '2026-09-02T03:00:00.000Z',
  };
}

function fakeReservationStorage() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowzero-bridge-reservation-'));
  const objects = new Map();
  const headFor = (key) => {
    const body = objects.get(key);
    if (!body) return null;
    return {
      ETag: `"${createHash('md5').update(body).digest('hex')}"`,
      ContentLength: body.length,
      Metadata: { sha256: createHash('sha256').update(body).digest('hex') },
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
    };
  };
  const dependencies = {
    r2Head: (_env, key) => headFor(key),
    run: (_command, args) => {
      const operation = args[1];
      const key = args[args.indexOf('--key') + 1];
      if (operation === 'put-object') {
        if (objects.has(key)) return { status: 1, stderr: 'PreconditionFailed' };
        objects.set(key, readFileSync(args[args.indexOf('--body') + 1]));
        return { status: 0, stdout: '{}' };
      }
      if (operation === 'get-object') {
        writeFileSync(args.at(-1), objects.get(key));
        return { status: 0, stdout: '{}' };
      }
      throw new Error(`unexpected fake storage operation: ${operation}`);
    },
  };
  return {
    env: {
      RUNNER_TEMP: root,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      R2_ENDPOINT: 'https://r2.example.test',
      R2_BUCKET: 'test',
    },
    objects,
    dependencies,
  };
}

test('legacy bridge intent is content-addressed, Windows-only, and qualification-hold only', () => {
  const intent = bridgeIntent();
  assert.equal(validateLegacyBridgeIntent(intent).transaction_id, intent.transaction_id);
  for (const patch of [
    { platform: 'macos-arm64' },
    { mode: 'publish' },
    { operation: 'release' },
    { transaction_id: `sha256:${digest('0')}` },
  ]) {
    assert.throws(() => validateLegacyBridgeIntent({ ...intent, ...patch }));
  }
  assert.throws(() => buildLegacyBridgeIntent({
    sourceHeadSha: sourceSha,
    bridgeVersion: '0.1.3-beta.1',
    affectedVersions: ['0.1.3-beta.1'],
    targetVersion: '0.1.3-beta.2',
    targetFeedUrl,
    targetSetupUrl,
  }), /must be older|strictly increasing/u);
  assert.throws(() => buildLegacyBridgeIntent({
    sourceHeadSha: sourceSha,
    bridgeVersion: '0.1.3-beta.9',
    affectedVersions: ['0.1.2-beta.7'],
    targetVersion: '0.1.3-beta.10',
    targetFeedUrl: 'https://updates-beta.flowzero.app/update/win32/0.1.3-beta.9?channel=beta&app_version=0.1.3-beta.9&update_strategy=squirrel',
    targetSetupUrl,
  }), /strictly increasing after conversion/u);
});

test('shared-source qualification rejects checkout SHA and package-version drift', () => {
  const intent = bridgeIntent();
  assert.deepEqual(validateLegacyBridgeSharedSource({
    intent,
    checkedOutHeadSha: sourceSha,
    sourcePackageVersion: intent.target.version,
  }), {
    source_head_sha: sourceSha,
    source_package_version: intent.target.version,
    target_version: intent.target.version,
  });
  assert.throws(() => validateLegacyBridgeSharedSource({
    intent,
    checkedOutHeadSha: 'c'.repeat(40),
    sourcePackageVersion: intent.target.version,
  }), /exact shared source SHA/u);
  assert.throws(() => validateLegacyBridgeSharedSource({
    intent,
    checkedOutHeadSha: sourceSha,
    sourcePackageVersion: intent.bridge.version,
  }), /source package version does not match the planned target version/u);
});

test('bridge candidate and hold bind exact assets under legacy-bridges and no current write', () => {
  const intent = bridgeIntent();
  const candidate = bridgeCandidate(intent);
  validateLegacyBridgeCandidate(candidate, intent);
  const hold = bridgeHold(candidate);
  assert.equal(hold.schema, LEGACY_BRIDGE_HOLD_SCHEMA);
  assert.match(hold.hold.asset_namespace, /^channels\/beta\/platforms\/windows-x64\/legacy-bridges\/v0\.1\.3-beta\.1\/candidates\/[a-f0-9]{64}$/u);
  assert.equal(hold.hold.promotion_allowed, false);
  assert.equal(hold.hold.current_pointer_writes, 0);
  assert.doesNotMatch(hold.hold.asset_namespace, /\/releases\//u);
  const target = targetCandidate(hold);
  assert.equal(
    legacyBridgeHoldKey(target),
    `channels/beta/platforms/windows-x64/legacy-bridges/v0.1.3-beta.1/${hold.hold_id.slice('sha256:'.length)}.json`,
  );

  const renamed = structuredClone(candidate);
  const nupkg = renamed.candidate.assets.find((asset) => asset.role === 'windows_bridge_nupkg');
  nupkg.name = 'arbitrary-bridge-full.nupkg';
  renamed.candidate.update.squirrel_releases = `${nupkg.sha1} ${nupkg.name} ${nupkg.size}\n`;
  renamed.candidate_id = contentId(renamed.candidate);
  assert.throws(
    () => validateLegacyBridgeCandidate(renamed, intent),
    /nupkg name is not canonical/u,
  );
});

test('current pointer proof requires exact pre/post identity', () => {
  const snapshot = { key: 'channels/beta/platforms/windows-x64/current.json', etag: 'one', body_sha256: digest('a') };
  assert.equal(assertCurrentPointerUnchanged(snapshot, structuredClone(snapshot)).unchanged, true);
  assert.throws(
    () => assertCurrentPointerUnchanged(snapshot, { ...snapshot, etag: 'two' }),
    /current\.json change/u,
  );
});

test('content-addressed binding accepts only one exact acyclic old-to-bridge-to-target route', () => {
  const hold = bridgeHold();
  const target = targetCandidate(hold);
  const binding = buildLegacyBridgeCompatibilityBinding({ hold, targetCandidate: target, acceptance: acceptance(hold, target) });
  assert.equal(binding.schema, LEGACY_BRIDGE_BINDING_SCHEMA);
  validateLegacyBridgeCompatibilityBinding(binding, { hold, targetCandidate: target });
  assert.deepEqual(assertWindowsLegacyBridgePromotionReady({ candidate: target, binding, hold }), {
    status: 'pass',
    binding_id: binding.binding_id,
    bridge_hold_id: hold.hold_id,
    current_pointer_cas_count: 1,
  });

  const tampered = structuredClone(binding);
  tampered.binding.target.assets[0].sha256 = digest('0');
  assert.throws(
    () => validateLegacyBridgeCompatibilityBinding(tampered, { hold, targetCandidate: target }),
    /does not match exact hold\/target evidence/u,
  );
});

test('binding fails closed when the bridge hold and same-version target come from different source SHAs', () => {
  const hold = bridgeHold();
  const target = targetCandidate(hold);
  target.candidate.source.head_sha = 'c'.repeat(40);
  target.candidate_id = contentId(target.candidate);
  assert.throws(
    () => buildLegacyBridgeCompatibilityBinding({
      hold,
      targetCandidate: target,
      acceptance: acceptance(hold, target),
    }),
    /share the exact source SHA/u,
  );
});

test('binding rejects missing evidence, version inversions, discontinuities, cycles, and overlaps', () => {
  const hold = bridgeHold();
  const target = targetCandidate(hold);
  assert.throws(
    () => assertWindowsLegacyBridgePromotionReady({ candidate: target }),
    /requires a legacy bridge compatibility binding/u,
  );

  const invertedTarget = structuredClone(target);
  invertedTarget.candidate.release = { version: '0.1.2-beta.7', tag: 'v0.1.2-beta.7', channel: 'beta', variant: 'standard' };
  invertedTarget.candidate_id = contentId(invertedTarget.candidate);
  assert.throws(
    () => buildLegacyBridgeCompatibilityBinding({ hold, targetCandidate: invertedTarget, acceptance: acceptance(hold, invertedTarget) }),
    /older than target|must be older/u,
  );

  const discontinuous = acceptance(hold, target);
  discontinuous.routes[0].hops[1].from_version = '0.1.2-beta.9';
  rehashAcceptance(discontinuous);
  assert.throws(
    () => buildLegacyBridgeCompatibilityBinding({ hold, targetCandidate: target, acceptance: discontinuous }),
    /discontinuous/u,
  );

  const cyclic = acceptance(hold, target);
  cyclic.routes[0].hops[1].to_version = '0.1.2-beta.7';
  rehashAcceptance(cyclic);
  assert.throws(
    () => buildLegacyBridgeCompatibilityBinding({ hold, targetCandidate: target, acceptance: cyclic }),
    /discontinuous|incomplete|cycle/u,
  );

  const overlap = acceptance(hold, target);
  overlap.affected_versions = ['0.1.2-beta.7', '0.1.2-beta.7'];
  rehashAcceptance(overlap);
  assert.throws(
    () => buildLegacyBridgeCompatibilityBinding({ hold, targetCandidate: target, acceptance: overlap }),
    /overlap/u,
  );

  const wrongBridgeTag = structuredClone(target);
  wrongBridgeTag.candidate.update.windows_legacy_bridge.bridge_tag = target.candidate.release.tag;
  wrongBridgeTag.candidate_id = contentId(wrongBridgeTag.candidate);
  assert.throws(
    () => assertWindowsLegacyBridgePromotionReady({ candidate: wrongBridgeTag, binding: {}, hold }),
    /older than target/u,
  );

  const expandedAllowlist = structuredClone(target);
  expandedAllowlist.candidate.update.windows_legacy_bridge.affected_versions = [
    '0.1.2-beta.6',
    '0.1.2-beta.7',
  ];
  expandedAllowlist.candidate_id = contentId(expandedAllowlist.candidate);
  assert.throws(
    () => assertWindowsLegacyBridgePromotionReady({ candidate: expandedAllowlist, binding: {}, hold }),
    /exact qualified allowlist/u,
  );
});

test('ordinary Windows targets remain promotion-ready without bridge evidence', () => {
  const target = targetCandidate();
  delete target.candidate.update.windows_legacy_bridge;
  target.candidate_id = contentId(target.candidate);
  assert.deepEqual(assertWindowsLegacyBridgePromotionReady({ candidate: target }), {
    status: 'not_required',
    current_pointer_cas_count: 1,
  });
});

test('normal release intent preserves the exact source-side Windows bridge arguments', () => {
  const hold = bridgeHold();
  const intent = buildManualReleaseIntent({
    version: '0.1.3-beta.2',
    headSha: sourceSha,
    platforms: 'windows-x64',
    variant: 'standard',
    windowsLegacyBridgeHoldId: hold.hold_id,
    windowsLegacyBridgeTag: hold.hold.bridge.tag,
    windowsLegacyBridgeAffectedVersionsJson: '["0.1.2-beta.7"]',
  });
  assert.deepEqual(validateReleaseIntent(intent).windows_legacy_bridge, {
    schema: 'flowzero.windows_legacy_bridge_requirement.v1',
    purpose: LEGACY_BRIDGE_PURPOSE,
    mode: 'required',
    bridge_hold_id: hold.hold_id,
    bridge_tag: 'v0.1.3-beta.1',
    affected_versions: ['0.1.2-beta.7'],
  });
  assert.throws(() => buildManualReleaseIntent({
    version: '0.1.3-beta.2',
    headSha: sourceSha,
    platforms: 'windows-x64',
    variant: 'standard',
    windowsLegacyBridgeHoldId: hold.hold_id,
    windowsLegacyBridgeTag: hold.hold.bridge.tag,
    windowsLegacyBridgeAffectedVersionsJson: '["0.1.2-beta.6","0.1.2-beta.7"]',
  }), /exact qualified allowlist/u);
});

test('mirrored checkpoint, platform manifest, and archive preserve exact bridge evidence', () => {
  const hold = bridgeHold();
  const target = targetCandidate(hold);
  const verification = targetVerification(target);
  const binding = buildLegacyBridgeCompatibilityBinding({
    hold,
    targetCandidate: target,
    acceptance: acceptance(hold, target),
  });
  const built = buildPlatformCheckpoint({
    phase: 'build_created',
    candidate: target,
    createdAt: '2026-09-02T04:00:00.000Z',
  });
  const verified = buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate: target,
    parent: built,
    verifications: [verification],
    createdAt: '2026-09-02T05:00:00.000Z',
  });
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'mirrored',
    candidate: target,
    parent: verified,
    verifications: [verification],
    mirrorReceipt: targetMirrorReceipt(target),
  }), /requires binding and hold/u);
  const mirrored = buildPlatformCheckpoint({
    phase: 'mirrored',
    candidate: target,
    parent: verified,
    verifications: [verification],
    mirrorReceipt: targetMirrorReceipt(target),
    legacyBridgeBinding: binding,
    legacyBridgeHold: hold,
    createdAt: '2026-09-02T06:00:00.000Z',
  });
  assert.equal(mirrored.checkpoint.windows_legacy_bridge.binding.binding_id, binding.binding_id);
  const manifest = buildPlatformChannelManifest({
    checkpoint: mirrored,
    publishedAt: '2026-09-02T07:00:00.000Z',
  });
  assert.equal(manifest.windows_legacy_bridge.binding_id, binding.binding_id);
  assert.equal(manifest.windows_legacy_bridge.bridge_hold_id, hold.hold_id);

  const transaction = {
    schema: 'flowzero.release_transaction.v1',
    transaction_id: target.candidate.transaction_id,
    intent: {
      requested_platforms: ['windows-x64'],
      source: target.candidate.source,
      release: target.candidate.release,
    },
    attempt: target.candidate.attempt,
  };
  const archive = buildReleaseArchiveManifest({
    transaction,
    entries: [{
      candidate: target,
      verification,
      windowsLegacyBridge: { binding, hold },
    }],
  });
  const validated = validateReleaseArchiveManifest(archive);
  assert.equal(validated.archive.platforms[0].windows_legacy_bridge.binding.binding_id, binding.binding_id);
});

test('durable reservations block the bridge tag and target requirement omission', () => {
  const storage = fakeReservationStorage();
  const intent = bridgeIntent();
  const reservations = reserveLegacyBridgeIntent(intent, {
    env: storage.env,
    ...storage.dependencies,
  });
  assert.equal(
    JSON.parse(storage.objects.get(reservationKey('bridge', intent.bridge.tag))).reservation_id,
    reservations.bridge.reservation_id,
  );
  assert.equal(
    JSON.parse(storage.objects.get(reservationKey('target', intent.target.tag))).reservation_id,
    reservations.target.reservation_id,
  );
  const hold = bridgeHold();
  const holdKey = `channels/beta/platforms/windows-x64/legacy-bridges/${hold.hold.bridge.tag}/${hold.hold_id.slice('sha256:'.length)}.json`;
  storage.objects.set(holdKey, Buffer.from(`${JSON.stringify(hold, null, 2)}\n`));
  const target = targetCandidate(hold);
  assert.equal(assertReleaseCandidateReservations(target, {
    env: storage.env,
    ...storage.dependencies,
  }).status, 'required');
  assert.equal(claimNormalReleaseTagArbitration({
    schema: 'flowzero.release_transaction.v1',
    transaction_id: target.candidate.transaction_id,
    intent: {
      requested_platforms: ['windows-x64'],
      source: target.candidate.source,
      release: target.candidate.release,
      windows_legacy_bridge: target.candidate.update.windows_legacy_bridge,
    },
  }, { env: storage.env, ...storage.dependencies }).status, 'reserved_target');

  const differentSource = structuredClone(target);
  differentSource.candidate.source.head_sha = 'c'.repeat(40);
  differentSource.candidate_id = contentId(differentSource.candidate);
  assert.throws(() => assertReleaseCandidateReservations(differentSource, {
    env: storage.env,
    ...storage.dependencies,
  }), /exact shared source SHA/u);
  assert.throws(() => claimNormalReleaseTagArbitration({
    schema: 'flowzero.release_transaction.v1',
    transaction_id: target.candidate.transaction_id,
    intent: {
      requested_platforms: ['windows-x64'],
      source: differentSource.candidate.source,
      release: target.candidate.release,
      windows_legacy_bridge: target.candidate.update.windows_legacy_bridge,
    },
  }, { env: storage.env, ...storage.dependencies }), /exact shared source SHA/u);

  const omitted = structuredClone(target);
  delete omitted.candidate.update.windows_legacy_bridge;
  omitted.candidate_id = contentId(omitted.candidate);
  assert.throws(() => assertReleaseCandidateReservations(omitted, {
    env: storage.env,
    ...storage.dependencies,
  }), /omitted its compatibility requirement/u);

  const bridgeAsNormal = structuredClone(target);
  bridgeAsNormal.candidate.release = intent.bridge;
  delete bridgeAsNormal.candidate.update.windows_legacy_bridge;
  assert.throws(() => assertReleaseCandidateReservations(bridgeAsNormal, {
    env: storage.env,
    ...storage.dependencies,
  }), /reserved Windows bridge tag/u);

  const macOnlyTransaction = (release) => ({
    schema: 'flowzero.release_transaction.v1',
    intent: { requested_platforms: ['macos-arm64'], release },
  });
  assert.throws(() => assertReleaseTransactionReservations(
    macOnlyTransaction(intent.bridge),
    { env: storage.env, ...storage.dependencies },
  ), /reserved Windows bridge tag/u);
  assert.throws(() => assertReleaseTransactionReservations(
    macOnlyTransaction(target.candidate.release),
    { env: storage.env, ...storage.dependencies },
  ), /requires the Windows lane/u);
});

test('per-tag arbitration makes normal-vs-reservation interleavings mutually exclusive', () => {
  const intent = bridgeIntent();
  for (const release of [intent.bridge, intent.target]) {
    const storage = fakeReservationStorage();
    const normalTransaction = {
      schema: 'flowzero.release_transaction.v1',
      transaction_id: `sha256:${digest(release === intent.bridge ? '8' : '9')}`,
      intent: { requested_platforms: ['macos-arm64'], release },
    };
    assert.equal(claimNormalReleaseTagArbitration(normalTransaction, {
      env: storage.env,
      ...storage.dependencies,
    }).status, 'normal_owner');
    assert.throws(
      () => reserveLegacyBridgeIntent(intent, {
        env: storage.env,
        ...storage.dependencies,
      }),
      /already arbitrated outside the bridge lane|reserved by another/u,
    );
  }
  const reservedFirst = fakeReservationStorage();
  reserveLegacyBridgeIntent(intent, { env: reservedFirst.env, ...reservedFirst.dependencies });
  for (const release of [intent.bridge, intent.target]) {
    assert.throws(() => claimNormalReleaseTagArbitration({
      schema: 'flowzero.release_transaction.v1',
      transaction_id: `sha256:${digest('7')}`,
      intent: { requested_platforms: ['macos-arm64'], release },
    }, { env: reservedFirst.env, ...reservedFirst.dependencies }), /reserved Windows bridge tag|requires the Windows lane/u);
  }
});
