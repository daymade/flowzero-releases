#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';
import {
  atomicWriteJson,
  assertImmutableMirrorStorage,
  ensureOssutil,
  hashFile,
  mirrorToOss,
  mirrorToR2,
  r2Head,
  requiredEnvironment,
  run,
  verifyPublicOrigin,
} from './mirror-release-assets.mjs';
import {
  LEGACY_BRIDGE_MIRROR_RECEIPT_SCHEMA,
  buildLegacyBridgeHold,
  validateLegacyBridgeCandidate,
  validateLegacyBridgeVerification,
} from './windows-legacy-bridge-contract.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value, encoding = 'hex') {
  return createHash('sha256').update(value).digest(encoding);
}

export function legacyBridgeNamespace(candidateEnvelope) {
  const candidate = validateLegacyBridgeCandidate(candidateEnvelope);
  const id = candidate.candidate_id.slice('sha256:'.length);
  return `channels/${candidate.candidate.bridge.channel}/platforms/windows-x64/legacy-bridges/${candidate.candidate.bridge.tag}/candidates/${id}`;
}

export function assertCurrentPointerUnchanged(before, after) {
  const beforeDigest = `sha256:${sha256(canonicalJson(before))}`;
  const afterDigest = `sha256:${sha256(canonicalJson(after))}`;
  assert(beforeDigest === afterDigest, 'legacy bridge qualification observed current.json change');
  return {
    current_key: before.key,
    before: structuredClone(before),
    after: structuredClone(after),
    before_digest: beforeDigest,
    after_digest: afterDigest,
    unchanged: true,
  };
}

function snapshotCurrentPointer(env, key, dependencies = {}) {
  const headObject = dependencies.r2Head || r2Head;
  const runCommand = dependencies.run || run;
  const head = headObject(env, key);
  if (!head) return { key, state: 'absent' };
  const target = path.join(env.RUNNER_TEMP, `legacy-bridge-current-${process.pid}-${Date.now()}.json`);
  const result = runCommand('aws', [
    's3api', 'get-object',
    '--bucket', env.R2_BUCKET,
    '--key', key,
    '--if-match', head.ETag,
    '--endpoint-url', env.R2_ENDPOINT,
    '--checksum-mode', 'ENABLED',
    '--output', 'json',
    target,
  ]);
  const body = readFileSync(target);
  return {
    key,
    state: 'present',
    etag: head.ETag,
    size: head.ContentLength,
    metadata_sha256: head.Metadata?.sha256 || null,
    checksum_sha256: head.ChecksumSHA256 || null,
    body_sha256: sha256(body),
    readback_checksum_sha256: result.stdout ? JSON.parse(result.stdout).ChecksumSHA256 || null : null,
  };
}

function bridgeAssetFiles(candidateEnvelope, assetRoot) {
  const candidate = validateLegacyBridgeCandidate(candidateEnvelope);
  const root = path.resolve(assetRoot);
  assert(existsSync(root) && statSync(root).isDirectory(), `legacy bridge asset root is missing: ${root}`);
  const expected = candidate.candidate.assets.map((asset) => asset.name).sort();
  const actual = readdirSync(root, { withFileTypes: true }).map((entry) => {
    assert(entry.isFile(), `legacy bridge asset root contains a non-file: ${entry.name}`);
    return entry.name;
  }).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'legacy bridge asset root does not exactly match candidate');
  return candidate.candidate.assets.map((asset) => {
    const filePath = path.join(root, asset.name);
    assert(statSync(filePath).size === asset.size, `legacy bridge asset size changed: ${asset.name}`);
    assert(hashFile(filePath, 'sha256') === asset.sha256, `legacy bridge asset digest changed: ${asset.name}`);
    return {
      ...asset,
      filePath,
      md5Hex: hashFile(filePath, 'md5'),
      sha256Base64: hashFile(filePath, 'sha256', 'base64'),
    };
  });
}

function putImmutableControlJson(env, key, filePath) {
  const bytes = readFileSync(filePath);
  const digestHex = sha256(bytes);
  const digestBase64 = sha256(bytes, 'base64');
  let head = r2Head(env, key);
  if (!head) {
    const put = run('aws', [
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
      '--output', 'json',
    ], { allowFailure: true });
    if (put.status !== 0 && !r2Head(env, key)) {
      throw new Error(`legacy bridge immutable state write failed: ${key}`);
    }
    head = r2Head(env, key);
  }
  assert(head?.ContentLength === bytes.length, `legacy bridge state size conflict: ${key}`);
  assert(head?.Metadata?.sha256 === digestHex, `legacy bridge state digest conflict: ${key}`);
  assert(head?.ChecksumSHA256 === digestBase64, `legacy bridge state checksum conflict: ${key}`);
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/u, '')}/${key}`, bytes.length);
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--candidate', '--verification', '--asset-root', '--output-dir']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(allowed.has(key) && value && !Object.hasOwn(values, key), `invalid argument: ${key || '<empty>'}`);
    values[key] = value;
  }
  for (const key of allowed) assert(values[key], `missing argument: ${key}`);
  return values;
}

export async function main(argv = process.argv.slice(2), envInput = process.env) {
  const args = parseArguments(argv);
  const env = requiredEnvironment(envInput);
  const candidate = validateLegacyBridgeCandidate(JSON.parse(readFileSync(path.resolve(args['--candidate']), 'utf8')));
  const verification = validateLegacyBridgeVerification(
    JSON.parse(readFileSync(path.resolve(args['--verification']), 'utf8')),
    candidate,
  );
  const files = bridgeAssetFiles(candidate, args['--asset-root']);
  const namespace = legacyBridgeNamespace(candidate);
  const currentKey = `channels/${candidate.candidate.bridge.channel}/platforms/windows-x64/current.json`;
  const currentBefore = snapshotCurrentPointer(env, currentKey);
  const binary = ensureOssutil(env);
  assertImmutableMirrorStorage(binary, env);
  const r2Objects = [];
  const ossObjects = [];
  for (const asset of files) {
    assert(asset.size <= 5 * 1024 * 1024 * 1024, `legacy bridge asset exceeds single-request mirror limit: ${asset.name}`);
    const objectKey = `${namespace}/assets/${asset.name}`;
    r2Objects.push(mirrorToR2(env, asset, objectKey));
    ossObjects.push(mirrorToOss(binary, env, asset, objectKey));
  }
  const currentAfterAssets = snapshotCurrentPointer(env, currentKey);
  const currentPointer = assertCurrentPointerUnchanged(currentBefore, currentAfterAssets);
  const mirrorReceipt = {
    schema: LEGACY_BRIDGE_MIRROR_RECEIPT_SCHEMA,
    candidate_id: candidate.candidate_id,
    transaction_id: candidate.candidate.transaction_id,
    platform: 'windows-x64',
    namespace,
    origins: [
      { origin: 'r2', objects: r2Objects },
      { origin: 'oss', objects: ossObjects },
    ],
    mirrored_at: new Date().toISOString(),
  };
  const state = buildLegacyBridgeHold({
    candidate,
    verification,
    mirrorReceipt,
    currentPointer,
  });
  const outputDir = path.resolve(args['--output-dir']);
  mkdirSync(outputDir, { recursive: true });
  const receiptPath = path.join(outputDir, 'mirror-receipt.json');
  const checkpointPath = path.join(outputDir, 'checkpoint.json');
  const holdPath = path.join(outputDir, 'hold.json');
  atomicWriteJson(receiptPath, mirrorReceipt);
  atomicWriteJson(checkpointPath, state.checkpoint);
  putImmutableControlJson(
    env,
    `channels/${candidate.candidate.bridge.channel}/platforms/windows-x64/legacy-bridges/${candidate.candidate.bridge.tag}/checkpoints/${state.checkpoint.checkpoint_id.slice('sha256:'.length)}.json`,
    checkpointPath,
  );
  const currentAfterCheckpoint = snapshotCurrentPointer(env, currentKey);
  const finalProof = assertCurrentPointerUnchanged(currentBefore, currentAfterCheckpoint);
  const finalState = buildLegacyBridgeHold({
    candidate,
    verification,
    mirrorReceipt,
    currentPointer: finalProof,
    checkpoint: state.checkpoint,
  });
  atomicWriteJson(holdPath, finalState.hold);
  putImmutableControlJson(
    env,
    `channels/${candidate.candidate.bridge.channel}/platforms/windows-x64/legacy-bridges/${candidate.candidate.bridge.tag}/${finalState.hold.hold_id.slice('sha256:'.length)}.json`,
    holdPath,
  );
  atomicWriteJson(path.join(outputDir, 'current-pointer-proof.json'), finalProof);
  process.stdout.write(`${finalState.hold.hold_id}\n`);
  return { checkpoint: state.checkpoint, hold: finalState.hold, mirrorReceipt, currentPointer: finalProof };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
