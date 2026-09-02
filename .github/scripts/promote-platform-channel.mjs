#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertChannelVersionForward } from './assert-channel-version-forward.mjs';
import { assertCurrentReleaseTagAllowed } from './check-current-release-tombstone.mjs';
import { canonicalJson } from './release-transaction.mjs';
import { buildPlatformChannelManifest } from './generate-platform-channel-manifest.mjs';
import {
  atomicWriteJson,
  r2Head,
  run,
  verifyPublicOrigin,
} from './mirror-release-assets.mjs';
import { assertWindowsLegacyBridgePromotionReady } from './validate-windows-legacy-bridge-promotion.mjs';
import { assertReleaseCandidateReservations } from './windows-legacy-bridge-reservation.mjs';
import {
  validateLegacyBridgeCheckpoint,
  validateLegacyBridgeHold,
} from './windows-legacy-bridge-contract.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(env = process.env) {
  for (const name of [
    'RUNNER_TEMP',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
    'ALIYUN_OSS_PUBLIC_BASE_URL',
  ]) {
    assert(typeof env[name] === 'string' && env[name].trim(), `missing promotion configuration: ${name}`);
  }
  return env;
}

export function sha256Buffer(buffer, encoding = 'hex') {
  return createHash('sha256').update(buffer).digest(encoding);
}

function parseJsonResult(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

export function readCurrent(env, key) {
  const head = r2Head(env, key);
  if (!head) return { head: null, manifest: null };
  const target = path.join(env.RUNNER_TEMP, `tinkle_current-${process.pid}.json`);
  run('aws', [
    's3api', 'get-object',
    '--bucket', env.R2_BUCKET,
    '--key', key,
    '--if-match', head.ETag,
    '--endpoint-url', env.R2_ENDPOINT,
    target,
  ]);
  const bytes = readFileSync(target);
  return {
    head,
    bytes,
    body_sha256: sha256Buffer(bytes),
    manifest: JSON.parse(bytes.toString('utf8')),
  };
}

export function samePublishedTarget(left, right) {
  if (!left || !right) return false;
  const stableProjection = manifest => {
    const { published_at: _publishedAt, checkpoint_id: _checkpointId, ...stable } = manifest;
    return stable;
  };
  return canonicalJson(stableProjection(left)) === canonicalJson(stableProjection(right));
}

export function advanceCurrentPointerOnce({
  before,
  targetManifest,
  targetBytes,
  targetDigestHex,
  targetDigestBase64,
  write,
}) {
  if (before.manifest?.tag === targetManifest.tag) {
    assert(samePublishedTarget(before.manifest, targetManifest), 'current platform pointer has the same tag but different immutable target identity');
    assert(before.head?.ContentLength === before.bytes?.length, 'idempotent current pointer size readback failed');
    assert(before.head?.Metadata?.sha256 === before.body_sha256, 'idempotent current pointer metadata readback failed');
    assert(before.head?.ChecksumSHA256 === Buffer.from(before.body_sha256, 'hex').toString('base64'), 'idempotent current pointer checksum readback failed');
    return { write_performed: false, recovered_after_lost_response: false };
  }
  assert(targetBytes.length > 0, 'target current pointer body is empty');
  assert(sha256Buffer(targetBytes) === targetDigestHex, 'target current pointer digest is invalid');
  assert(sha256Buffer(targetBytes, 'base64') === targetDigestBase64, 'target current pointer checksum is invalid');
  return write();
}

export function legacyBridgeHoldKey(candidateEnvelope) {
  const candidate = candidateEnvelope?.candidate;
  const requirement = candidate?.update?.windows_legacy_bridge;
  assert(candidate?.platform === 'windows-x64' && requirement, 'candidate does not declare a Windows legacy bridge');
  return `channels/${candidate.release.channel}/platforms/windows-x64/legacy-bridges/${requirement.bridge_tag}/${requirement.bridge_hold_id.slice('sha256:'.length)}.json`;
}

function readTrustedLegacyBridgeHold(env, candidateEnvelope, providedHold) {
  const requirement = candidateEnvelope.candidate.update?.windows_legacy_bridge;
  if (requirement === undefined) return providedHold;
  assert(providedHold !== null, 'Windows target requires a bundled legacy bridge hold');
  const key = legacyBridgeHoldKey(candidateEnvelope);
  const head = r2Head(env, key);
  assert(head, `trusted Windows legacy bridge hold is missing: ${key}`);
  const target = path.join(env.RUNNER_TEMP, `legacy-bridge-hold-${process.pid}.json`);
  run('aws', [
    's3api', 'get-object',
    '--bucket', env.R2_BUCKET,
    '--key', key,
    '--if-match', head.ETag,
    '--endpoint-url', env.R2_ENDPOINT,
    '--checksum-mode', 'ENABLED',
    '--output', 'json',
    target,
  ]);
  const bytes = readFileSync(target);
  const digestHex = sha256Buffer(bytes);
  const digestBase64 = sha256Buffer(bytes, 'base64');
  assert(head.ContentLength === bytes.length, 'trusted Windows legacy bridge hold size mismatch');
  assert(head.Metadata?.sha256 === digestHex, 'trusted Windows legacy bridge hold metadata mismatch');
  assert(head.ChecksumSHA256 === digestBase64, 'trusted Windows legacy bridge hold checksum mismatch');
  const trusted = validateLegacyBridgeHold(JSON.parse(bytes.toString('utf8')));
  assert(
    canonicalJson(trusted) === canonicalJson(providedHold),
    'bundled Windows legacy bridge hold differs from trusted immutable hold',
  );
  const checkpointKey = `channels/${candidateEnvelope.candidate.release.channel}/platforms/windows-x64/legacy-bridges/${trusted.hold.bridge.tag}/checkpoints/${trusted.hold.checkpoint_id.slice('sha256:'.length)}.json`;
  const checkpointHead = r2Head(env, checkpointKey);
  assert(checkpointHead, `trusted Windows legacy bridge checkpoint is missing: ${checkpointKey}`);
  const checkpointPath = path.join(env.RUNNER_TEMP, `legacy-bridge-checkpoint-${process.pid}.json`);
  run('aws', [
    's3api', 'get-object', '--bucket', env.R2_BUCKET, '--key', checkpointKey,
    '--if-match', checkpointHead.ETag, '--endpoint-url', env.R2_ENDPOINT,
    '--checksum-mode', 'ENABLED', '--output', 'json', checkpointPath,
  ]);
  const checkpointBytes = readFileSync(checkpointPath);
  const checkpointDigestHex = sha256Buffer(checkpointBytes);
  assert(checkpointHead.ContentLength === checkpointBytes.length, 'trusted Windows legacy bridge checkpoint size mismatch');
  assert(checkpointHead.Metadata?.sha256 === checkpointDigestHex, 'trusted Windows legacy bridge checkpoint metadata mismatch');
  assert(checkpointHead.ChecksumSHA256 === sha256Buffer(checkpointBytes, 'base64'), 'trusted Windows legacy bridge checkpoint checksum mismatch');
  const checkpoint = validateLegacyBridgeCheckpoint(JSON.parse(checkpointBytes.toString('utf8')));
  assert(checkpoint.checkpoint_id === trusted.hold.checkpoint_id, 'trusted Windows legacy bridge checkpoint id mismatch');
  assert(checkpoint.checkpoint.candidate_id === trusted.hold.candidate_id, 'trusted Windows legacy bridge checkpoint candidate mismatch');
  return trusted;
}

export function putImmutableJson(env, key, filePath, digestHex, digestBase64, size, dependencies = {}) {
  const headObject = dependencies.r2Head || r2Head;
  const runCommand = dependencies.run || run;
  let head = headObject(env, key);
  if (!head) {
    const result = runCommand('aws', [
      's3api', 'put-object',
      '--bucket', env.R2_BUCKET,
      '--key', key,
      '--body', filePath,
      '--endpoint-url', env.R2_ENDPOINT,
      '--content-type', 'application/json',
      '--cache-control', 'public, max-age=31536000, immutable',
      '--metadata', `sha256=${digestHex}`,
      '--checksum-algorithm', 'SHA256',
      '--checksum-sha256', digestBase64,
      '--if-none-match', '*',
    ], { allowFailure: true });
    if (result.status !== 0 && !headObject(env, key)) {
      throw new Error(`immutable platform manifest upload failed: ${result.stderr}`);
    }
    head = headObject(env, key);
  }
  assert(head.ContentLength === size, `immutable platform manifest size conflict: ${key}`);
  assert(head.Metadata?.sha256 === digestHex, `immutable platform manifest digest conflict: ${key}`);
  assert(head.ChecksumSHA256 === digestBase64, `immutable platform manifest checksum conflict: ${key}`);
  return head;
}

export function putCurrentJson(env, key, filePath, digestHex, digestBase64, previousHead, dependencies = {}) {
  const runCommand = dependencies.run || run;
  const readCurrentPointer = dependencies.readCurrent || readCurrent;
  const condition = previousHead
    ? ['--if-match', previousHead.ETag]
    : ['--if-none-match', '*'];
  const result = runCommand('aws', [
    's3api', 'put-object',
    '--bucket', env.R2_BUCKET,
    '--key', key,
    '--body', filePath,
    '--endpoint-url', env.R2_ENDPOINT,
    '--content-type', 'application/json',
    '--cache-control', 'public, max-age=0, must-revalidate, stale-if-error=86400',
    '--metadata', `sha256=${digestHex}`,
    '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', digestBase64,
    ...condition,
  ], { allowFailure: true });
  if (result.status === 0) return { write_performed: true, recovered_after_lost_response: false };
  const recovered = readCurrentPointer(env, key);
  const expectedBytes = readFileSync(filePath);
  if (
    recovered.head?.ContentLength === expectedBytes.length
    && recovered.head?.Metadata?.sha256 === digestHex
    && recovered.head?.ChecksumSHA256 === digestBase64
    && recovered.body_sha256 === digestHex
  ) {
    return { write_performed: true, recovered_after_lost_response: true };
  }
  throw new Error(`current platform pointer CAS failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function verifyMirroredCandidateStillExists(env, manifest) {
  for (const asset of manifest.assets) {
    const key = `releases/${manifest.tag}/${asset.name}`;
    const r2 = r2Head(env, key);
    assert(r2, `R2 object disappeared before promotion: ${asset.name}`);
    assert(r2.ContentLength === asset.size, `R2 object size changed before promotion: ${asset.name}`);
    assert(r2.Metadata?.sha256 === asset.sha256, `R2 object digest changed before promotion: ${asset.name}`);
    assert(
      r2.ChecksumSHA256 === Buffer.from(asset.sha256, 'hex').toString('base64'),
      `R2 server checksum changed before promotion: ${asset.name}`,
    );
    verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`, asset.size);
    verifyPublicOrigin(`${env.ALIYUN_OSS_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`, asset.size);
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--manifest', '--checkpoint', '--allow-downgrade', '--compatibility-binding', '--bridge-hold', '--output'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--manifest', '--checkpoint', '--allow-downgrade', '--output']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  assert(['true', 'false'].includes(values['--allow-downgrade']), '--allow-downgrade must be true or false');
  return values;
}

export async function main(argv = process.argv.slice(2), envInput = process.env) {
  const args = parseArguments(argv);
  const env = requiredEnvironment(envInput);
  const manifestPath = path.resolve(args['--manifest']);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const checkpointPath = path.resolve(args['--checkpoint']);
  const checkpointBytes = readFileSync(checkpointPath);
  const checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
  await assertCurrentReleaseTagAllowed({
    tag: manifest.tag,
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
  });
  const expected = buildPlatformChannelManifest({
    checkpoint,
    notes: manifest.notes,
    publishedAt: manifest.published_at,
  });
  assert(JSON.stringify(manifest) === JSON.stringify(expected), 'platform manifest does not match its mirrored checkpoint');
  const bindingPath = args['--compatibility-binding'];
  const holdPath = args['--bridge-hold'];
  assert(Boolean(bindingPath) === Boolean(holdPath), 'Windows legacy bridge binding and hold paths must be supplied together');
  const candidateEnvelope = checkpoint.checkpoint.candidate;
  assertReleaseCandidateReservations(candidateEnvelope, { env });
  const fileHold = holdPath && existsSync(path.resolve(holdPath))
    ? JSON.parse(readFileSync(path.resolve(holdPath), 'utf8'))
    : null;
  const fileBinding = bindingPath && existsSync(path.resolve(bindingPath))
    ? JSON.parse(readFileSync(path.resolve(bindingPath), 'utf8'))
    : null;
  const embedded = checkpoint.checkpoint.windows_legacy_bridge || null;
  if (embedded && fileHold) {
    assert(canonicalJson(embedded.hold) === canonicalJson(fileHold), 'Windows legacy bridge hold file differs from checkpoint evidence');
  }
  if (embedded && fileBinding) {
    assert(canonicalJson(embedded.binding) === canonicalJson(fileBinding), 'Windows legacy bridge binding file differs from checkpoint evidence');
  }
  const bundledHold = embedded?.hold || fileHold;
  const bundledBinding = embedded?.binding || fileBinding;
  const trustedHold = readTrustedLegacyBridgeHold(env, candidateEnvelope, bundledHold);
  assertWindowsLegacyBridgePromotionReady({
    candidate: candidateEnvelope,
    binding: bundledBinding,
    hold: trustedHold,
  });
  const baseKey = `channels/${manifest.channel}/platforms/${manifest.platform}`;
  const immutableKey = `${baseKey}/releases/${manifest.tag}.json`;
  const checkpointKey = `${baseKey}/checkpoints/${manifest.tag}.json`;
  const currentKey = `${baseKey}/current.json`;
  const before = readCurrent(env, currentKey);
  const ordering = assertChannelVersionForward({
    channel: manifest.channel,
    platform: manifest.platform,
    targetTag: manifest.tag,
    currentManifest: before.manifest,
    allowDowngrade: args['--allow-downgrade'] === 'true',
  });
  if (ordering.status === 'idempotent') {
    const currentWrite = advanceCurrentPointerOnce({
      before,
      targetManifest: manifest,
      targetBytes: manifestBytes,
      targetDigestHex: sha256Buffer(manifestBytes),
      targetDigestBase64: sha256Buffer(manifestBytes, 'base64'),
      write: () => { throw new Error('idempotent promotion attempted a current pointer write'); },
    });
    verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${currentKey}?promotion=${before.body_sha256}`, before.bytes.length);
    const receipt = {
      schema: 'flowzero.platform_promotion_receipt.v1',
      status: 'pass',
      channel: manifest.channel,
      platform: manifest.platform,
      tag: manifest.tag,
      transaction_id: manifest.transaction_id,
      checkpoint_id: before.manifest.checkpoint_id,
      checkpoint_key: `${baseKey}/checkpoints/${manifest.tag}.json`,
      checkpoint_sha256: null,
      manifest_sha256: before.body_sha256,
      immutable_key: `${baseKey}/releases/${manifest.tag}.json`,
      current_key: currentKey,
      ordering,
      current_pointer_write_performed: currentWrite.write_performed,
      current_pointer_write_recovered: currentWrite.recovered_after_lost_response,
      promoted_at: new Date().toISOString(),
    };
    atomicWriteJson(args['--output'], receipt);
    process.stdout.write(`platform ${manifest.channel}/${manifest.platform} already targets ${manifest.tag}; current.json unchanged\n`);
    return receipt;
  }
  verifyMirroredCandidateStillExists(env, manifest);
  const checkpointDigestHex = sha256Buffer(checkpointBytes);
  const checkpointDigestBase64 = sha256Buffer(checkpointBytes, 'base64');
  putImmutableJson(
    env,
    checkpointKey,
    checkpointPath,
    checkpointDigestHex,
    checkpointDigestBase64,
    checkpointBytes.length,
  );
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${checkpointKey}`, checkpointBytes.length);
  const digestHex = sha256Buffer(manifestBytes);
  const digestBase64 = sha256Buffer(manifestBytes, 'base64');
  putImmutableJson(env, immutableKey, manifestPath, digestHex, digestBase64, manifestBytes.length);
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${immutableKey}`, manifestBytes.length);
  const currentWrite = advanceCurrentPointerOnce({
    before,
    targetManifest: manifest,
    targetBytes: manifestBytes,
    targetDigestHex: digestHex,
    targetDigestBase64: digestBase64,
    write: () => putCurrentJson(env, currentKey, manifestPath, digestHex, digestBase64, before.head),
  });
  const current = r2Head(env, currentKey);
  assert(current?.ContentLength === manifestBytes.length, 'current platform pointer size verification failed');
  assert(current?.Metadata?.sha256 === digestHex, 'current platform pointer digest verification failed');
  assert(current?.ChecksumSHA256 === digestBase64, 'current platform pointer checksum verification failed');
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${currentKey}?promotion=${digestHex}`, manifestBytes.length);
  const receipt = {
    schema: 'flowzero.platform_promotion_receipt.v1',
    status: 'pass',
    channel: manifest.channel,
    platform: manifest.platform,
    tag: manifest.tag,
    transaction_id: manifest.transaction_id,
    checkpoint_id: manifest.checkpoint_id,
    checkpoint_key: checkpointKey,
    checkpoint_sha256: checkpointDigestHex,
    manifest_sha256: digestHex,
    immutable_key: immutableKey,
    current_key: currentKey,
    ordering,
    current_pointer_write_performed: currentWrite.write_performed,
    current_pointer_write_recovered: currentWrite.recovered_after_lost_response,
    promoted_at: new Date().toISOString(),
  };
  atomicWriteJson(args['--output'], receipt);
  process.stdout.write(`promoted ${manifest.channel}/${manifest.platform} to ${manifest.tag}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
