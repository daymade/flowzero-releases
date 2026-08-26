#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertChannelVersionForward } from './assert-channel-version-forward.mjs';
import { assertCurrentReleaseTagAllowed } from './check-current-release-tombstone.mjs';
import { buildPlatformChannelManifest } from './generate-platform-channel-manifest.mjs';
import {
  atomicWriteJson,
  r2Head,
  run,
  verifyPublicOrigin,
} from './mirror-release-assets.mjs';

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
  return { head, manifest: JSON.parse(readFileSync(target, 'utf8')) };
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
  const condition = previousHead
    ? ['--if-match', previousHead.ETag]
    : ['--if-none-match', '*'];
  runCommand('aws', [
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
  ]);
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
    if (!['--manifest', '--checkpoint', '--allow-downgrade', '--output'].includes(key) || !value) {
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
  putCurrentJson(env, currentKey, manifestPath, digestHex, digestBase64, before.head);
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
