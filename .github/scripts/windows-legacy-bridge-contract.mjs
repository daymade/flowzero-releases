#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';
import { parseProjectReleaseTag } from './release-tag-contract.mjs';

export const LEGACY_BRIDGE_PURPOSE = 'windows_legacy_bridge_v1';
export const LEGACY_BRIDGE_INTENT_SCHEMA = 'flowzero.windows_legacy_bridge_intent.v1';
export const LEGACY_BRIDGE_CANDIDATE_SCHEMA = 'flowzero.windows_legacy_bridge_candidate.v1';
export const LEGACY_BRIDGE_VERIFICATION_SCHEMA = 'flowzero.windows_legacy_bridge_verification.v1';
export const LEGACY_BRIDGE_MIRROR_RECEIPT_SCHEMA = 'flowzero.windows_legacy_bridge_mirror_receipt.v1';
export const LEGACY_BRIDGE_CHECKPOINT_SCHEMA = 'flowzero.windows_legacy_bridge_checkpoint.v1';
export const LEGACY_BRIDGE_HOLD_SCHEMA = 'flowzero.windows_legacy_bridge_hold.v1';
export const LEGACY_BRIDGE_REQUIREMENT_SCHEMA = 'flowzero.windows_legacy_bridge_requirement.v1';
export const LEGACY_BRIDGE_TWO_HOP_ACCEPTANCE_SCHEMA = 'flowzero.windows_legacy_bridge_two_hop_acceptance.v1';
export const LEGACY_BRIDGE_BINDING_SCHEMA = 'flowzero.windows_legacy_bridge_compatibility_binding.v1';

export const LEGACY_BRIDGE_ASSET_ROLES = Object.freeze([
  'windows_bridge_setup',
  'windows_bridge_nupkg',
  'windows_bridge_releases',
]);
export const LEGACY_BRIDGE_AFFECTED_VERSIONS = Object.freeze(['0.1.2-beta.7']);
export const WINDOWS_SIGNING_POLICIES = Object.freeze(['unsigned', 'authenticode']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contentId(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function assertContentId(value, label) {
  assert(/^sha256:[a-f0-9]{64}$/u.test(value || ''), `${label} is invalid`);
}

export function validateWindowsSigningPolicy(value) {
  assert(WINDOWS_SIGNING_POLICIES.includes(value), 'Windows signing policy is invalid');
  return value;
}

function compareVersion(left, right) {
  const leftParsed = parseProjectReleaseTag(`v${left}`);
  const rightParsed = parseProjectReleaseTag(`v${right}`);
  assert(leftParsed.channel === rightParsed.channel, 'legacy bridge versions must remain in one channel');
  const length = Math.max(leftParsed.parts.length, rightParsed.parts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParsed.parts[index] ?? 0) - (rightParsed.parts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function convertWindowsSquirrelVersion(version) {
  parseProjectReleaseTag(`v${version}`);
  const [withoutBuild] = version.split('+');
  const [core, ...prerelease] = withoutBuild.split('-');
  return prerelease.length ? `${core}-${prerelease.join('-').replace(/\./gu, '')}` : core;
}

function compareWindowsSquirrelVersions(left, right) {
  const parse = (value) => {
    const [withoutBuild] = value.split('+');
    const [core, ...preParts] = withoutBuild.split('-');
    return {
      core: core.split('.').map(Number),
      pre: preParts.join('-').split('.').filter(Boolean),
    };
  };
  const leftParsed = parse(left);
  const rightParsed = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParsed.core[index] === rightParsed.core[index]) continue;
    return leftParsed.core[index] < rightParsed.core[index] ? -1 : 1;
  }
  if (leftParsed.pre.length === 0 || rightParsed.pre.length === 0) {
    if (leftParsed.pre.length === rightParsed.pre.length) return 0;
    return leftParsed.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftParsed.pre.length, rightParsed.pre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParsed.pre[index];
    const rightPart = rightParsed.pre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.toLowerCase() < rightPart.toLowerCase() ? -1 : 1;
  }
  return 0;
}

export function assertWindowsSquirrelUpgradePath(versions) {
  assert(Array.isArray(versions) && versions.length >= 2, 'Windows Squirrel upgrade path requires at least two versions');
  for (let index = 1; index < versions.length; index += 1) {
    assert(compareVersion(versions[index - 1], versions[index]) < 0, 'project versions must be strictly increasing');
  }
  const converted = versions.map(convertWindowsSquirrelVersion);
  for (let index = 1; index < converted.length; index += 1) {
    assert(
      compareWindowsSquirrelVersions(converted[index - 1], converted[index]) < 0,
      `Squirrel/NuGet package versions must be strictly increasing after conversion: ${converted.join(' < ')}`,
    );
  }
  return converted;
}

function canonicalVersions(versions, { before = null, label = 'affected versions' } = {}) {
  assert(Array.isArray(versions) && versions.length > 0, `${label} are missing`);
  const values = versions.map((value) => {
    assert(typeof value === 'string' && value.length > 0, `${label} contain an invalid version`);
    parseProjectReleaseTag(`v${value}`);
    return value;
  });
  assert(new Set(values).size === values.length, `${label} overlap`);
  const sorted = [...values].sort(compareVersion);
  assert(canonicalJson(values) === canonicalJson(sorted), `${label} must be canonical and ascending`);
  if (before !== null) {
    for (const version of values) {
      assert(compareVersion(version, before) < 0, `${label} must be older than ${before}`);
    }
  }
  return values;
}

function validateSource(source, label = 'source') {
  assert(source?.repository === 'daymade/flowzero', `${label} repository is invalid`);
  assert(/^[a-f0-9]{40}$/u.test(source?.head_sha || ''), `${label} SHA is invalid`);
  return source;
}

function validateRelease(release, label = 'release') {
  const parsed = parseProjectReleaseTag(release?.tag);
  assert(release.version === parsed.version, `${label} tag/version mismatch`);
  assert(release.channel === parsed.channel, `${label} tag/channel mismatch`);
  assert(release.variant === 'standard', `${label} must use the standard variant`);
  return release;
}

function validatePlannedTarget(target, bridge) {
  const parsed = parseProjectReleaseTag(target?.tag);
  assert(target.version === parsed.version, 'legacy bridge target tag/version mismatch');
  assert(target.channel === parsed.channel, 'legacy bridge target tag/channel mismatch');
  assert(target.channel === bridge.channel, 'legacy bridge target must remain in the bridge channel');
  assert(compareVersion(bridge.version, target.version) < 0, 'legacy bridge target must be newer than bridge');
  const expectedOrigin = target.channel === 'beta'
    ? 'https://updates-beta.flowzero.app'
    : 'https://updates.flowzero.app';
  const feed = new URL(target.feed_url);
  assert(feed.origin === expectedOrigin, 'legacy bridge target feed origin is invalid');
  assert(feed.pathname === `/update/win32/${bridge.version}`, 'legacy bridge target feed path must identify the bridge version');
  assert(feed.searchParams.get('channel') === target.channel, 'legacy bridge target feed channel is invalid');
  assert(feed.searchParams.get('app_version') === bridge.version, 'legacy bridge target feed app_version is invalid');
  assert(feed.searchParams.get('update_strategy') === 'squirrel', 'legacy bridge target feed strategy is invalid');
  assert([...feed.searchParams.keys()].every((key) => ['channel', 'app_version', 'update_strategy'].includes(key)), 'legacy bridge target feed has unsupported query parameters');
  const setup = new URL(target.setup_url);
  assert(setup.origin === expectedOrigin && setup.pathname === '/download/windows' && setup.search === '', 'legacy bridge target Setup URL is invalid');
  return target;
}

function validateAssets(assets, roles, label) {
  assert(Array.isArray(assets) && assets.length === roles.length, `${label} asset count is invalid`);
  const names = new Set();
  for (const role of roles) {
    assert(assets.filter((asset) => asset?.role === role).length === 1, `${label} role is missing or duplicated: ${role}`);
  }
  for (const asset of assets) {
    assert(typeof asset.name === 'string' && asset.name.length > 0, `${label} asset name is invalid`);
    assert(!asset.name.includes('/') && !asset.name.includes('\\'), `${label} asset name contains a path`);
    assert(!names.has(asset.name), `${label} asset name is duplicated: ${asset.name}`);
    names.add(asset.name);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `${label} asset size is invalid: ${asset.name}`);
    assert(/^[a-f0-9]{64}$/u.test(asset.sha256 || ''), `${label} asset SHA-256 is invalid: ${asset.name}`);
    if (asset.role.endsWith('_nupkg')) {
      assert(/^[a-f0-9]{40}$/u.test(asset.sha1 || ''), `${label} nupkg SHA-1 is invalid`);
    }
  }
  return assets;
}

function assertSquirrelRelease(candidate) {
  const nupkg = candidate.assets.find((asset) => asset.role === 'windows_bridge_nupkg');
  const setup = candidate.assets.find((asset) => asset.role === 'windows_bridge_setup');
  const releasesAsset = candidate.assets.find((asset) => asset.role === 'windows_bridge_releases');
  const squirrelVersion = candidate.bridge.version.replace(/-([a-z0-9-]+)\.(\d+)$/u, '-$1$2');
  assert(nupkg.name === `Flowzero-${squirrelVersion}-full.nupkg`, 'legacy bridge nupkg name is not canonical');
  assert(setup.name === `Flowzero-${candidate.bridge.version}-Setup.exe`, 'legacy bridge Setup name is not canonical');
  assert(releasesAsset.name === 'RELEASES', 'legacy bridge RELEASES name is not canonical');
  const rows = String(candidate.update?.squirrel_releases || '').trim().split(/\r?\n/u).filter(Boolean);
  const columns = rows.length === 1 ? rows[0].split(/\s+/u) : [];
  assert(
    rows.length === 1
      && columns[0]?.toLowerCase() === nupkg.sha1
      && columns[1] === nupkg.name
      && columns[2] === String(nupkg.size),
    'legacy bridge RELEASES does not bind the exact nupkg',
  );
}

export function buildLegacyBridgeIntent({
  sourceHeadSha,
  bridgeVersion,
  affectedVersions,
  targetVersion,
  targetFeedUrl,
  targetSetupUrl,
  windowsSigningPolicy = 'unsigned',
}) {
  const parsed = parseProjectReleaseTag(`v${bridgeVersion}`);
  const parsedTarget = parseProjectReleaseTag(`v${targetVersion}`);
  assertWindowsSquirrelUpgradePath([
    ...affectedVersions,
    bridgeVersion,
    targetVersion,
  ]);
  const canonicalAffectedVersions = canonicalVersions(affectedVersions, { before: bridgeVersion });
  assert(
    canonicalJson(canonicalAffectedVersions) === canonicalJson(LEGACY_BRIDGE_AFFECTED_VERSIONS),
    'legacy bridge affected versions must match the exact qualified allowlist',
  );
  const identity = {
    schema: LEGACY_BRIDGE_INTENT_SCHEMA,
    purpose: LEGACY_BRIDGE_PURPOSE,
    operation: 'legacy_bridge',
    mode: 'qualification_hold',
    platform: 'windows-x64',
    windows_signing_policy: validateWindowsSigningPolicy(windowsSigningPolicy),
    source: { repository: 'daymade/flowzero', head_sha: sourceHeadSha },
    bridge: {
      version: parsed.version,
      tag: parsed.tag,
      channel: parsed.channel,
      variant: 'standard',
    },
    target: validatePlannedTarget({
      version: parsedTarget.version,
      tag: parsedTarget.tag,
      channel: parsedTarget.channel,
      feed_url: targetFeedUrl,
      setup_url: targetSetupUrl,
    }, {
      version: parsed.version,
      channel: parsed.channel,
    }),
    affected_versions: canonicalAffectedVersions,
    delivery_policy: {
      mode: 'qualification_hold',
      current_pointer_writes: false,
      promotion: false,
      canary: false,
      archive: false,
    },
  };
  return { ...identity, transaction_id: contentId(identity) };
}

export function validateLegacyBridgeIntent(input) {
  assert(input?.schema === LEGACY_BRIDGE_INTENT_SCHEMA, 'legacy bridge intent schema is unsupported');
  assert(input.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge intent purpose is invalid');
  assert(input.operation === 'legacy_bridge', 'legacy bridge operation is invalid');
  assert(input.mode === 'qualification_hold', 'legacy bridge mode is invalid');
  assert(input.platform === 'windows-x64', 'legacy bridge is restricted to windows-x64');
  validateWindowsSigningPolicy(input.windows_signing_policy);
  validateSource(input.source, 'legacy bridge source');
  validateRelease(input.bridge, 'legacy bridge release');
  validatePlannedTarget(input.target, input.bridge);
  const affectedVersions = canonicalVersions(input.affected_versions, { before: input.bridge.version });
  assert(
    canonicalJson(affectedVersions) === canonicalJson(LEGACY_BRIDGE_AFFECTED_VERSIONS),
    'legacy bridge affected versions must match the exact qualified allowlist',
  );
  assertWindowsSquirrelUpgradePath([
    ...affectedVersions,
    input.bridge.version,
    input.target.version,
  ]);
  assert(
    input.delivery_policy?.mode === 'qualification_hold'
      && input.delivery_policy.current_pointer_writes === false
      && input.delivery_policy.promotion === false
      && input.delivery_policy.canary === false
      && input.delivery_policy.archive === false,
    'legacy bridge delivery policy must remain hold-only',
  );
  const { transaction_id: transactionId, ...identity } = input;
  assert(transactionId === contentId(identity), 'legacy bridge transaction id is invalid');
  return structuredClone(input);
}

export function validateLegacyBridgeSharedSource({
  intent: intentInput,
  checkedOutHeadSha,
  sourcePackageVersion,
}) {
  const intent = validateLegacyBridgeIntent(intentInput);
  assert(
    checkedOutHeadSha === intent.source.head_sha,
    'checked-out source does not match the exact shared source SHA',
  );
  assert(
    sourcePackageVersion === intent.target.version,
    'shared source package version does not match the planned target version',
  );
  return {
    source_head_sha: intent.source.head_sha,
    source_package_version: sourcePackageVersion,
    target_version: intent.target.version,
  };
}

export function validateLegacyBridgeCandidate(envelope, intentInput = null) {
  assert(envelope?.schema === LEGACY_BRIDGE_CANDIDATE_SCHEMA, 'legacy bridge candidate schema is unsupported');
  assert(envelope.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge candidate purpose is invalid');
  assertContentId(envelope.candidate_id, 'legacy bridge candidate id');
  const candidate = envelope.candidate;
  assert(candidate?.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge candidate payload purpose is invalid');
  assert(candidate.platform === 'windows-x64', 'legacy bridge candidate is restricted to windows-x64');
  validateWindowsSigningPolicy(candidate.windows_signing_policy);
  validateSource(candidate.source, 'legacy bridge candidate source');
  validateRelease(candidate.bridge, 'legacy bridge candidate release');
  validatePlannedTarget(candidate.target, candidate.bridge);
  const affectedVersions = canonicalVersions(candidate.affected_versions, { before: candidate.bridge.version });
  assert(
    canonicalJson(affectedVersions) === canonicalJson(LEGACY_BRIDGE_AFFECTED_VERSIONS),
    'legacy bridge candidate affected versions must match the exact qualified allowlist',
  );
  assertWindowsSquirrelUpgradePath([
    ...affectedVersions,
    candidate.bridge.version,
    candidate.target.version,
  ]);
  assertContentId(candidate.transaction_id, 'legacy bridge candidate transaction id');
  assert(/^[a-f0-9]{40}$/u.test(candidate.attempt?.release_infrastructure_sha || ''), 'legacy bridge infrastructure SHA is invalid');
  assert(/^\d+$/u.test(String(candidate.attempt?.workflow_run_id || '')), 'legacy bridge workflow run id is invalid');
  assert(Number.isSafeInteger(Number(candidate.attempt?.workflow_run_attempt)) && Number(candidate.attempt.workflow_run_attempt) > 0, 'legacy bridge workflow run attempt is invalid');
  validateAssets(candidate.assets, LEGACY_BRIDGE_ASSET_ROLES, 'legacy bridge candidate');
  assertSquirrelRelease(candidate);
  assert(envelope.candidate_id === contentId(candidate), 'legacy bridge candidate content hash is invalid');
  if (intentInput !== null) {
    const intent = validateLegacyBridgeIntent(intentInput);
    assert(candidate.transaction_id === intent.transaction_id, 'legacy bridge candidate transaction mismatch');
    assert(canonicalJson(candidate.source) === canonicalJson(intent.source), 'legacy bridge candidate source mismatch');
    assert(canonicalJson(candidate.bridge) === canonicalJson(intent.bridge), 'legacy bridge candidate release mismatch');
    assert(canonicalJson(candidate.target) === canonicalJson(intent.target), 'legacy bridge candidate target mismatch');
    assert(canonicalJson(candidate.affected_versions) === canonicalJson(intent.affected_versions), 'legacy bridge affected versions mismatch');
    assert(candidate.windows_signing_policy === intent.windows_signing_policy, 'legacy bridge signing policy mismatch');
  }
  return structuredClone(envelope);
}

export function validateLegacyBridgeVerification(receipt, candidateInput) {
  const candidate = validateLegacyBridgeCandidate(candidateInput);
  assert(receipt?.schema === LEGACY_BRIDGE_VERIFICATION_SCHEMA, 'legacy bridge verification schema is unsupported');
  assert(receipt.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge verification purpose is invalid');
  assert(receipt.status === 'pass', 'legacy bridge verification did not pass');
  assert(receipt.platform === 'windows-x64', 'legacy bridge verification platform is invalid');
  assert(receipt.candidate_id === candidate.candidate_id, 'legacy bridge verification candidate mismatch');
  assert(receipt.transaction_id === candidate.candidate.transaction_id, 'legacy bridge verification transaction mismatch');
  assert(receipt.source_head_sha === candidate.candidate.source.head_sha, 'legacy bridge verification source mismatch');
  assert(receipt.bridge_version === candidate.candidate.bridge.version, 'legacy bridge verification version mismatch');
  assert(receipt.target_version === candidate.candidate.target.version, 'legacy bridge verification target version mismatch');
  assert(canonicalJson(receipt.affected_versions) === canonicalJson(candidate.candidate.affected_versions), 'legacy bridge verification affected versions mismatch');
  assert(!Number.isNaN(Date.parse(receipt.verified_at)), 'legacy bridge verification timestamp is invalid');
  assert(receipt.evidence?.current_pointer_writes === 0, 'legacy bridge verification wrote a current pointer');
  assert(
    receipt.evidence?.windows_signing_policy === candidate.candidate.windows_signing_policy,
    'legacy bridge verification signing policy mismatch',
  );
  const signingEvidence = receipt.evidence?.windows_signing;
  assert(
    signingEvidence?.status === 'pass'
      && signingEvidence.policy === candidate.candidate.windows_signing_policy
      && signingEvidence.observed_status === (
        candidate.candidate.windows_signing_policy === 'authenticode' ? 'Valid' : 'NotSigned'
      )
      && signingEvidence.timestamp_present === (
        candidate.candidate.windows_signing_policy === 'authenticode'
      ),
    'legacy bridge verification signing evidence is incomplete',
  );
  assert(
    receipt.evidence?.target_routing?.embedded === true
      && receipt.evidence.target_routing.version === candidate.candidate.target.version
      && receipt.evidence.target_routing.feed_url === candidate.candidate.target.feed_url
      && receipt.evidence.target_routing.setup_url === candidate.candidate.target.setup_url,
    'legacy bridge verification did not prove exact embedded target routing',
  );
  const routes = receipt.evidence?.legacy_updater_routes;
  assert(Array.isArray(routes) && routes.length === candidate.candidate.affected_versions.length, 'legacy bridge verification route count is invalid');
  for (const version of candidate.candidate.affected_versions) {
    const matches = routes.filter((route) => route?.from_version === version);
    assert(matches.length === 1, `legacy bridge verification route is missing or duplicated: ${version}`);
    const route = matches[0];
    assert(
      route.to_version === candidate.candidate.bridge.version
        && route.status === 'pass'
        && route.complete_payload === true
        && route.launch_verified === true
        && route.root_updater_replaced === true
        && route.zero_process_residue === true,
      `legacy bridge verification route is incomplete: ${version}`,
    );
  }
  return structuredClone(receipt);
}

export function validateLegacyBridgeRequirement(requirement, targetVersion) {
  assert(requirement?.schema === LEGACY_BRIDGE_REQUIREMENT_SCHEMA, 'Windows legacy bridge requirement schema is unsupported');
  assert(requirement.purpose === LEGACY_BRIDGE_PURPOSE, 'Windows legacy bridge requirement purpose is invalid');
  assert(requirement.mode === 'required', 'Windows legacy bridge requirement mode is invalid');
  assertContentId(requirement.bridge_hold_id, 'Windows legacy bridge hold id');
  const parsedBridge = parseProjectReleaseTag(requirement.bridge_tag);
  assert(compareVersion(parsedBridge.version, targetVersion) < 0, 'Windows legacy bridge tag must be older than target');
  const affectedVersions = canonicalVersions(requirement.affected_versions, { before: targetVersion });
  assert(
    canonicalJson(affectedVersions) === canonicalJson(LEGACY_BRIDGE_AFFECTED_VERSIONS),
    'Windows legacy bridge requirement must match the exact qualified allowlist',
  );
  assertWindowsSquirrelUpgradePath([
    ...affectedVersions,
    parsedBridge.version,
    targetVersion,
  ]);
  return structuredClone(requirement);
}

function validateCurrentPointerProof(currentPointer, channel) {
  assert(currentPointer?.unchanged === true, 'legacy bridge hold did not prove current.json unchanged');
  assert(currentPointer.before_digest === currentPointer.after_digest, 'legacy bridge current.json digest changed');
  assert(currentPointer.before_digest === contentId(currentPointer.before), 'legacy bridge current.json before digest is invalid');
  assert(currentPointer.after_digest === contentId(currentPointer.after), 'legacy bridge current.json after digest is invalid');
  assert(
    currentPointer.current_key === `channels/${channel}/platforms/windows-x64/current.json`,
    'legacy bridge current.json proof key is invalid',
  );
  assert(canonicalJson(currentPointer.before) === canonicalJson(currentPointer.after), 'legacy bridge current.json snapshots changed');
  return currentPointer;
}

export function validateLegacyBridgeMirrorReceipt(mirrorReceipt, candidateInput) {
  const candidate = validateLegacyBridgeCandidate(candidateInput);
  assert(mirrorReceipt?.schema === LEGACY_BRIDGE_MIRROR_RECEIPT_SCHEMA, 'legacy bridge mirror receipt schema is unsupported');
  assert(mirrorReceipt.candidate_id === candidate.candidate_id, 'legacy bridge mirror receipt candidate mismatch');
  assert(mirrorReceipt.transaction_id === candidate.candidate.transaction_id, 'legacy bridge mirror receipt transaction mismatch');
  assert(mirrorReceipt.platform === 'windows-x64', 'legacy bridge mirror receipt platform is invalid');
  const expectedNamespace = `channels/${candidate.candidate.bridge.channel}/platforms/windows-x64/legacy-bridges/${candidate.candidate.bridge.tag}/candidates/${candidate.candidate_id.slice('sha256:'.length)}`;
  assert(mirrorReceipt.namespace === expectedNamespace, 'legacy bridge mirror namespace is invalid');
  assert(Array.isArray(mirrorReceipt.origins) && mirrorReceipt.origins.length === 2, 'legacy bridge mirror origins are invalid');
  for (const originName of ['r2', 'oss']) {
    const origins = mirrorReceipt.origins.filter((origin) => origin?.origin === originName);
    assert(origins.length === 1, `legacy bridge mirror origin is missing or duplicated: ${originName}`);
    assert(origins[0].objects?.length === candidate.candidate.assets.length, `legacy bridge mirror object set is incomplete: ${originName}`);
    for (const asset of candidate.candidate.assets) {
      const objects = origins[0].objects.filter((object) => object?.name === asset.name);
      assert(objects.length === 1, `legacy bridge mirror object is missing or duplicated: ${originName}/${asset.name}`);
      const object = objects[0];
      assert(
        object.key === `${expectedNamespace}/assets/${asset.name}`
          && object.size === asset.size
          && object.sha256 === asset.sha256
          && object.public_head === true
          && object.public_range === true,
        `legacy bridge mirror object evidence is invalid: ${originName}/${asset.name}`,
      );
    }
  }
  assert(!Number.isNaN(Date.parse(mirrorReceipt.mirrored_at)), 'legacy bridge mirror timestamp is invalid');
  return structuredClone(mirrorReceipt);
}

export function validateLegacyBridgeCheckpoint(envelope) {
  assert(envelope?.schema === LEGACY_BRIDGE_CHECKPOINT_SCHEMA, 'legacy bridge checkpoint schema is unsupported');
  assertContentId(envelope.checkpoint_id, 'legacy bridge checkpoint id');
  const checkpoint = envelope.checkpoint;
  assert(checkpoint?.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge checkpoint purpose is invalid');
  assert(checkpoint.phase === 'qualification_held' && checkpoint.platform === 'windows-x64', 'legacy bridge checkpoint state is invalid');
  const candidate = validateLegacyBridgeCandidate(checkpoint.candidate);
  validateLegacyBridgeVerification(checkpoint.verification, candidate);
  validateLegacyBridgeMirrorReceipt(checkpoint.mirror_receipt, candidate);
  assert(checkpoint.transaction_id === candidate.candidate.transaction_id, 'legacy bridge checkpoint transaction mismatch');
  assert(checkpoint.candidate_id === candidate.candidate_id, 'legacy bridge checkpoint candidate mismatch');
  validateCurrentPointerProof(checkpoint.current_pointer, candidate.candidate.bridge.channel);
  assert(envelope.checkpoint_id === contentId(checkpoint), 'legacy bridge checkpoint content hash is invalid');
  return structuredClone(envelope);
}

export function buildLegacyBridgeHold({
  candidate: rawCandidate,
  verification: rawVerification,
  mirrorReceipt,
  currentPointer,
  checkpoint: rawCheckpoint = null,
}) {
  const candidate = validateLegacyBridgeCandidate(rawCandidate);
  const verification = validateLegacyBridgeVerification(rawVerification, candidate);
  validateLegacyBridgeMirrorReceipt(mirrorReceipt, candidate);
  validateCurrentPointerProof(currentPointer, candidate.candidate.bridge.channel);
  const checkpointEnvelope = rawCheckpoint === null
    ? (() => {
      const checkpoint = {
        purpose: LEGACY_BRIDGE_PURPOSE,
        phase: 'qualification_held',
        transaction_id: candidate.candidate.transaction_id,
        platform: 'windows-x64',
        candidate_id: candidate.candidate_id,
        candidate,
        verification,
        mirror_receipt: structuredClone(mirrorReceipt),
        current_pointer: structuredClone(currentPointer),
      };
      return {
        schema: LEGACY_BRIDGE_CHECKPOINT_SCHEMA,
        checkpoint_id: contentId(checkpoint),
        checkpoint,
      };
    })()
    : validateLegacyBridgeCheckpoint(rawCheckpoint);
  assert(checkpointEnvelope.checkpoint.candidate_id === candidate.candidate_id, 'legacy bridge hold checkpoint candidate mismatch');
  const hold = {
    purpose: LEGACY_BRIDGE_PURPOSE,
    state: 'qualification_hold',
    platform: 'windows-x64',
    transaction_id: candidate.candidate.transaction_id,
    candidate_id: candidate.candidate_id,
    checkpoint_id: checkpointEnvelope.checkpoint_id,
    source_head_sha: candidate.candidate.source.head_sha,
    bridge: structuredClone(candidate.candidate.bridge),
    target: structuredClone(candidate.candidate.target),
    affected_versions: [...candidate.candidate.affected_versions],
    windows_signing_policy: candidate.candidate.windows_signing_policy,
    asset_namespace: mirrorReceipt.namespace,
    assets: structuredClone(candidate.candidate.assets),
    current_pointer: structuredClone(currentPointer),
    promotion_allowed: false,
    current_pointer_writes: 0,
  };
  const holdEnvelope = {
    schema: LEGACY_BRIDGE_HOLD_SCHEMA,
    hold_id: contentId(hold),
    hold,
  };
  return { checkpoint: checkpointEnvelope, hold: holdEnvelope };
}

export function validateLegacyBridgeHold(envelope) {
  assert(envelope?.schema === LEGACY_BRIDGE_HOLD_SCHEMA, 'legacy bridge hold schema is unsupported');
  assertContentId(envelope.hold_id, 'legacy bridge hold id');
  const hold = envelope.hold;
  assert(hold?.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge hold purpose is invalid');
  assert(hold.state === 'qualification_hold' && hold.platform === 'windows-x64', 'legacy bridge hold state is invalid');
  assert(hold.promotion_allowed === false && hold.current_pointer_writes === 0, 'legacy bridge hold permits publication');
  assertContentId(hold.transaction_id, 'legacy bridge hold transaction id');
  assertContentId(hold.candidate_id, 'legacy bridge hold candidate id');
  assertContentId(hold.checkpoint_id, 'legacy bridge hold checkpoint id');
  assert(/^[a-f0-9]{40}$/u.test(hold.source_head_sha || ''), 'legacy bridge hold source SHA is invalid');
  validateWindowsSigningPolicy(hold.windows_signing_policy);
  validateRelease(hold.bridge, 'legacy bridge hold release');
  validatePlannedTarget(hold.target, hold.bridge);
  canonicalVersions(hold.affected_versions, { before: hold.bridge.version });
  assert(
    hold.asset_namespace === `channels/${hold.bridge.channel}/platforms/windows-x64/legacy-bridges/${hold.bridge.tag}/candidates/${hold.candidate_id.slice('sha256:'.length)}`,
    'legacy bridge hold asset namespace is invalid',
  );
  validateAssets(hold.assets, LEGACY_BRIDGE_ASSET_ROLES, 'legacy bridge hold');
  validateCurrentPointerProof(hold.current_pointer, hold.bridge.channel);
  const squirrelVersion = hold.bridge.version.replace(/-([a-z0-9-]+)\.(\d+)$/u, '-$1$2');
  assert(
    hold.assets.find((asset) => asset.role === 'windows_bridge_nupkg')?.name
      === `Flowzero-${squirrelVersion}-full.nupkg`,
    'legacy bridge hold nupkg name is not canonical',
  );
  assert(envelope.hold_id === contentId(hold), 'legacy bridge hold content hash is invalid');
  return structuredClone(envelope);
}

function assertAcyclic(routes) {
  const graph = new Map();
  for (const route of routes) {
    for (const hop of route.hops) {
      if (!graph.has(hop.from_version)) graph.set(hop.from_version, new Set());
      graph.get(hop.from_version).add(hop.to_version);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    assert(!visiting.has(node), 'Windows legacy bridge routes contain a cycle');
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) || []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
}

export function buildLegacyBridgeCompatibilityBinding({ hold: rawHold, targetCandidate, acceptance }) {
  const hold = validateLegacyBridgeHold(rawHold);
  const target = targetCandidate?.candidate;
  assert(targetCandidate?.schema === 'flowzero.release_platform_candidate.v1', 'target candidate schema is unsupported');
  assertContentId(targetCandidate.candidate_id, 'target candidate id');
  assert(targetCandidate.candidate_id === contentId(target), 'target candidate content hash is invalid');
  assert(target?.platform === 'windows-x64', 'legacy bridge target must be windows-x64');
  validateSource(target.source, 'legacy bridge target source');
  validateRelease(target.release, 'legacy bridge target release');
  validateWindowsSigningPolicy(target.update?.windows_signing_policy);
  const requirement = validateLegacyBridgeRequirement(target.update?.windows_legacy_bridge, target.release.version);
  assert(requirement.bridge_hold_id === hold.hold_id, 'target bridge hold requirement mismatch');
  assert(requirement.bridge_tag === hold.hold.bridge.tag, 'target bridge tag requirement mismatch');
  assert(canonicalJson(requirement.affected_versions) === canonicalJson(hold.hold.affected_versions), 'target bridge affected versions mismatch');
  assert(
    hold.hold.source_head_sha === target.source.head_sha,
    'legacy bridge hold and target candidate must share the exact source SHA',
  );
  assert(
    hold.hold.windows_signing_policy === target.update.windows_signing_policy,
    'legacy bridge hold and target candidate signing policies differ',
  );
  assert(compareVersion(hold.hold.bridge.version, target.release.version) < 0, 'legacy bridge version must be older than target');
  assert(canonicalJson(hold.hold.target) === canonicalJson({
    version: target.release.version,
    tag: target.release.tag,
    channel: target.release.channel,
    feed_url: hold.hold.target.feed_url,
    setup_url: hold.hold.target.setup_url,
  }), 'legacy bridge planned target does not match the exact target candidate');
  validateAssets(target.assets, ['windows_setup', 'windows_nupkg', 'windows_releases'], 'legacy bridge target');
  assert(acceptance?.schema === LEGACY_BRIDGE_TWO_HOP_ACCEPTANCE_SCHEMA, 'two-hop acceptance schema is unsupported');
  const { acceptance_id: acceptanceId, ...acceptanceIdentity } = acceptance;
  assert(acceptanceId === contentId(acceptanceIdentity), 'two-hop acceptance content hash is invalid');
  assert(acceptance.status === 'pass', 'two-hop acceptance did not pass');
  assert(acceptance.platform === 'windows-x64', 'two-hop acceptance platform is invalid');
  assert(acceptance.bridge_candidate_id === hold.hold.candidate_id, 'two-hop acceptance bridge mismatch');
  assert(acceptance.target_candidate_id === targetCandidate.candidate_id, 'two-hop acceptance target mismatch');
  assert(acceptance.verifier_head_sha === target.source.head_sha, 'two-hop acceptance verifier SHA mismatch');
  assert(acceptance.current_pointer_writes === 0, 'two-hop acceptance must not write current.json');
  assert(!Number.isNaN(Date.parse(acceptance.accepted_at)), 'two-hop acceptance timestamp is invalid');
  const affectedVersions = canonicalVersions(acceptance.affected_versions, { before: hold.hold.bridge.version });
  assert(canonicalJson(affectedVersions) === canonicalJson(hold.hold.affected_versions), 'two-hop acceptance affected versions mismatch');
  assert(Array.isArray(acceptance.routes) && acceptance.routes.length === affectedVersions.length, 'two-hop acceptance route count is invalid');
  const routeSources = acceptance.routes.map((route) => route?.from_version);
  assert(new Set(routeSources).size === routeSources.length, 'two-hop acceptance routes overlap');
  for (const version of affectedVersions) {
    const routes = acceptance.routes.filter((route) => route?.from_version === version);
    assert(routes.length === 1, `two-hop acceptance route is missing or duplicated: ${version}`);
    const route = routes[0];
    assert(Array.isArray(route.hops) && route.hops.length === 2, `two-hop acceptance must contain exactly two hops: ${version}`);
    const [bridgeHop, targetHop] = route.hops;
    assert(
      bridgeHop.from_version === version
        && bridgeHop.to_version === hold.hold.bridge.version
        && targetHop.from_version === hold.hold.bridge.version
        && targetHop.to_version === target.release.version,
      `two-hop acceptance route is discontinuous: ${version}`,
    );
    for (const hop of route.hops) {
      assert(
        compareVersion(hop.from_version, hop.to_version) < 0
          && hop.status === 'pass'
          && hop.complete_payload === true
          && hop.payload_sha256_match === true
          && hop.launch_verified === true
          && hop.zero_process_residue === true,
        `two-hop acceptance evidence is incomplete: ${hop.from_version}->${hop.to_version}`,
      );
    }
    const preservation = route.user_data_preservation;
    assert(
      preservation?.schema === 'flowzero.windows_update_user_data_preservation.v2'
        && preservation.scope === 'isolated_production_profile'
        && preservation.seeded_before_first_hop === true
        && preservation.source_version === version
        && /^[a-f0-9]{40}$/u.test(preservation.source_schema_commit || '')
        && /^[a-f0-9]{64}$/u.test(preservation.source_schema_fixture_sha256 || '')
        && preservation.initial_migration_count === 24
        && Number.isSafeInteger(preservation.final_migration_count)
        && preservation.final_migration_count >= preservation.initial_migration_count
        && preservation.final_migration === '041_add_migration_receipts.js'
        && /^[a-f0-9]{64}$/u.test(preservation.database_before_sha256 || '')
        && /^[a-f0-9]{64}$/u.test(preservation.database_after_sha256 || '')
        && /^[a-f0-9]{64}$/u.test(preservation.transcription_text_sha256 || '')
        && /^[a-f0-9]{64}$/u.test(preservation.recording_before_sha256 || '')
        && preservation.recording_after_sha256 === preservation.recording_before_sha256
        && preservation.production_runtime_profile === true
        && preservation.database_migrated === true
        && preservation.transcription_preserved === true
        && preservation.settings_preserved === true
        && preservation.recording_preserved === true,
      `two-hop acceptance user data preservation evidence is incomplete: ${version}`,
    );
  }
  assertAcyclic(acceptance.routes);
  const binding = {
    purpose: LEGACY_BRIDGE_PURPOSE,
    platform: 'windows-x64',
    channel: target.release.channel,
    windows_signing_policy: hold.hold.windows_signing_policy,
    affected_versions: [...affectedVersions],
    bridge: {
      hold_id: hold.hold_id,
      candidate_id: hold.hold.candidate_id,
      source_head_sha: hold.hold.source_head_sha,
      version: hold.hold.bridge.version,
      tag: hold.hold.bridge.tag,
      asset_namespace: hold.hold.asset_namespace,
      assets: structuredClone(hold.hold.assets),
    },
    target: {
      transaction_id: target.transaction_id,
      candidate_id: targetCandidate.candidate_id,
      source_head_sha: target.source.head_sha,
      version: target.release.version,
      tag: target.release.tag,
      assets: structuredClone(target.assets),
    },
    acceptance: structuredClone(acceptance),
    promotion_plan: { current_pointer_cas_count: 1 },
  };
  return { schema: LEGACY_BRIDGE_BINDING_SCHEMA, binding_id: contentId(binding), binding };
}

export function validateLegacyBridgeCompatibilityBinding(envelope, { hold, targetCandidate }) {
  assert(envelope?.schema === LEGACY_BRIDGE_BINDING_SCHEMA, 'Windows legacy bridge binding schema is unsupported');
  assertContentId(envelope.binding_id, 'Windows legacy bridge binding id');
  const rebuilt = buildLegacyBridgeCompatibilityBinding({
    hold,
    targetCandidate,
    acceptance: envelope.binding?.acceptance,
  });
  assert(canonicalJson(envelope) === canonicalJson(rebuilt), 'Windows legacy bridge binding does not match exact hold/target evidence');
  return structuredClone(envelope);
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    assert(/^--/u.test(key || '') && value && !Object.hasOwn(values, key), `invalid argument: ${key || '<empty>'}`);
    values[key] = value;
  }
  return { command, values };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv);
  if (command === 'build-intent') {
    for (const key of ['--source-head-sha', '--bridge-version', '--affected-versions', '--target-version', '--target-feed-url', '--target-setup-url', '--windows-signing-policy', '--output']) {
      assert(values[key], `missing argument: ${key}`);
    }
    const intent = buildLegacyBridgeIntent({
      sourceHeadSha: values['--source-head-sha'],
      bridgeVersion: values['--bridge-version'],
      affectedVersions: JSON.parse(values['--affected-versions']),
      targetVersion: values['--target-version'],
      targetFeedUrl: values['--target-feed-url'],
      targetSetupUrl: values['--target-setup-url'],
      windowsSigningPolicy: values['--windows-signing-policy'],
    });
    if (values['--transaction-id']) {
      assert(values['--transaction-id'] === intent.transaction_id, 'legacy bridge transaction ID mismatch');
    }
    await atomicWriteJson(values['--output'], intent);
    process.stdout.write(`${intent.transaction_id}\n`);
    return intent;
  }
  if (command === 'validate-intent') {
    assert(values['--intent'], 'missing argument: --intent');
    const intent = validateLegacyBridgeIntent(
      JSON.parse(await readFile(path.resolve(values['--intent']), 'utf8')),
    );
    if (values['--transaction-id']) {
      assert(values['--transaction-id'] === intent.transaction_id, 'legacy bridge transaction ID mismatch');
    }
    process.stdout.write(`${intent.transaction_id}\n`);
    return intent;
  }
  if (command === 'validate-shared-source') {
    for (const key of ['--intent', '--checked-out-head-sha', '--source-package-version']) {
      assert(values[key], `missing argument: ${key}`);
    }
    const result = validateLegacyBridgeSharedSource({
      intent: JSON.parse(await readFile(path.resolve(values['--intent']), 'utf8')),
      checkedOutHeadSha: values['--checked-out-head-sha'],
      sourcePackageVersion: values['--source-package-version'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (command === 'validate-candidate') {
    for (const key of ['--intent', '--candidate']) assert(values[key], `missing argument: ${key}`);
    const intent = JSON.parse(await readFile(path.resolve(values['--intent']), 'utf8'));
    const candidate = JSON.parse(await readFile(path.resolve(values['--candidate']), 'utf8'));
    const result = validateLegacyBridgeCandidate(candidate, intent);
    process.stdout.write(`${result.candidate_id}\n`);
    return result;
  }
  if (command === 'validate-verification') {
    for (const key of ['--candidate', '--verification']) assert(values[key], `missing argument: ${key}`);
    const candidate = JSON.parse(await readFile(path.resolve(values['--candidate']), 'utf8'));
    const verification = JSON.parse(await readFile(path.resolve(values['--verification']), 'utf8'));
    const result = validateLegacyBridgeVerification(verification, candidate);
    process.stdout.write(`${result.candidate_id}\n`);
    return result;
  }
  if (command === 'build-binding') {
    for (const key of ['--hold', '--target-candidate', '--acceptance', '--output']) assert(values[key], `missing argument: ${key}`);
    const result = buildLegacyBridgeCompatibilityBinding({
      hold: JSON.parse(await readFile(path.resolve(values['--hold']), 'utf8')),
      targetCandidate: JSON.parse(await readFile(path.resolve(values['--target-candidate']), 'utf8')),
      acceptance: JSON.parse(await readFile(path.resolve(values['--acceptance']), 'utf8')),
    });
    await atomicWriteJson(values['--output'], result);
    process.stdout.write(`${result.binding_id}\n`);
    return result;
  }
  throw new Error(`unsupported legacy bridge command: ${command || '<empty>'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
