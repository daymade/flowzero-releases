#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertOssBucketUnversioned } from './assert-oss-bucket-unversioned.mjs';
import { assertCurrentReleaseTagAllowed } from './check-current-release-tombstone.mjs';
import { validateCandidateEnvelope } from './release-platform-checkpoint.mjs';

export const MIRROR_RECEIPT_SCHEMA = 'flowzero.release_mirror_receipt.v1';
const OSSUTIL_VERSION = '2.3.0';
const OSSUTIL_SHA256 = '3ae4d9fc85a7a6e9f5654d1599766f1a3a42a3692870887b5ae9338d582ef65a';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function requiredEnvironment(env = process.env) {
  const names = [
    'RUNNER_TEMP',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
    'ALIYUN_OSS_ACCESS_KEY_ID',
    'ALIYUN_OSS_ACCESS_KEY_SECRET',
    'ALIYUN_OSS_ENDPOINT',
    'ALIYUN_OSS_REGION',
    'ALIYUN_OSS_BUCKET',
    'ALIYUN_OSS_PUBLIC_BASE_URL',
  ];
  for (const name of names) assert(typeof env[name] === 'string' && env[name].trim(), `missing mirror configuration: ${name}`);
  return env;
}

export function run(command, args, { capture = true, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

export function hashFile(filePath, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(filePath)).digest(encoding);
}

export function validateAssetDirectory(candidateEnvelope, assetRoot) {
  const candidate = validateCandidateEnvelope(candidateEnvelope);
  const root = path.resolve(assetRoot);
  assert(existsSync(root) && statSync(root).isDirectory(), `asset root is missing: ${root}`);
  const expected = candidate.candidate.assets.map((asset) => asset.name).sort();
  const actual = readdirSync(root, { withFileTypes: true }).map((entry) => {
    assert(entry.isFile(), `asset root contains a non-file entry: ${entry.name}`);
    return entry.name;
  }).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'asset root does not exactly match the candidate manifest');
  const files = candidate.candidate.assets.map((asset) => {
    const filePath = path.join(root, asset.name);
    assert(statSync(filePath).size === asset.size, `candidate asset size changed: ${asset.name}`);
    assert(hashFile(filePath, 'sha256') === asset.sha256, `candidate asset digest changed: ${asset.name}`);
    return {
      ...asset,
      filePath,
      md5Hex: hashFile(filePath, 'md5'),
      sha256Base64: hashFile(filePath, 'sha256', 'base64'),
    };
  });
  return { candidate, files };
}

export function ensureOssutil(env) {
  const archive = path.join(env.RUNNER_TEMP, `ossutil-${OSSUTIL_VERSION}-linux-amd64.zip`);
  const root = path.join(env.RUNNER_TEMP, `ossutil-${OSSUTIL_VERSION}-linux-amd64`);
  const binary = path.join(root, 'ossutil');
  if (!existsSync(binary)) {
    run('curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--output', archive,
      `https://gosspublic.alicdn.com/ossutil/v2/${OSSUTIL_VERSION}/ossutil-${OSSUTIL_VERSION}-linux-amd64.zip`,
    ]);
    assert(hashFile(archive, 'sha256') === OSSUTIL_SHA256, 'ossutil archive digest mismatch');
    run('unzip', ['-q', archive, '-d', env.RUNNER_TEMP]);
  }
  assert(existsSync(binary), 'ossutil binary is missing after extraction');
  return binary;
}

export function ossArgs(env) {
  return [
    '--access-key-id', env.ALIYUN_OSS_ACCESS_KEY_ID,
    '--access-key-secret', env.ALIYUN_OSS_ACCESS_KEY_SECRET,
    '--endpoint', env.ALIYUN_OSS_ENDPOINT,
    '--region', env.ALIYUN_OSS_REGION,
    '--sign-version', 'v4',
    '--ignore-env-var',
    '--user-agent', 'flowzero-release-ci',
  ];
}

export function assertImmutableMirrorStorage(binary, env) {
  const versioning = parseJsonResult(run(binary, [
    'api', 'get-bucket-versioning',
    '--bucket', env.ALIYUN_OSS_BUCKET,
    '--output-format', 'json',
    '--quiet',
    ...ossArgs(env),
  ]), 'OSS bucket versioning');
  assertOssBucketUnversioned(versioning);
}

function parseJsonResult(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

export function verifyPublicOrigin(url, expectedSize) {
  const head = run('curl', [
    '--fail', '--silent', '--show-error', '--retry', '12', '--retry-all-errors',
    '--retry-delay', '5', '--head', '--write-out', '%{http_code} %{size_download} %{content_type} %{header_json}',
    '--output', '/dev/null', url,
  ]).stdout;
  assert(head.startsWith('200 '), `public HEAD failed for ${url}`);
  const contentLength = /"content-length":\["(\d+)"\]/i.exec(head)?.[1];
  assert(Number(contentLength) === expectedSize, `public content length mismatch for ${url}`);
  const range = run('curl', [
    '--fail', '--silent', '--show-error', '--retry', '12', '--retry-all-errors',
    '--retry-delay', '5', '--range', '0-0', '--max-filesize', '1',
    '--write-out', '%{http_code} %{size_download}', '--output', '/dev/null', url,
  ]).stdout.trim();
  assert(range === '206 1', `public range contract failed for ${url}: ${range}`);
  return { public_head: true, public_range: true };
}

export function r2Head(env, objectKey) {
  const result = run('aws', [
    's3api', 'head-object',
    '--bucket', env.R2_BUCKET,
    '--key', objectKey,
    '--endpoint-url', env.R2_ENDPOINT,
    '--checksum-mode', 'ENABLED',
    '--output', 'json',
  ], { allowFailure: true });
  return result.status === 0 ? parseJsonResult(result, 'R2 head-object') : null;
}

export function mirrorToR2(env, asset, objectKey) {
  let head = r2Head(env, objectKey);
  if (!head) {
    const upload = run('aws', [
      's3api', 'put-object',
      '--bucket', env.R2_BUCKET,
      '--key', objectKey,
      '--body', asset.filePath,
      '--endpoint-url', env.R2_ENDPOINT,
      '--content-type', asset.content_type,
      '--cache-control', 'public, max-age=31536000, immutable',
      '--metadata', `sha256=${asset.sha256}`,
      '--checksum-algorithm', 'SHA256',
      '--checksum-sha256', asset.sha256Base64,
      '--if-none-match', '*',
      '--output', 'json',
    ], { allowFailure: true });
    if (upload.status !== 0) {
      head = r2Head(env, objectKey);
      if (!head) throw new Error(`R2 create-only upload failed for ${asset.name}: ${upload.stderr}`);
    } else {
      head = r2Head(env, objectKey);
    }
  }
  assert(head.ContentLength === asset.size, `R2 size mismatch for ${asset.name}`);
  assert(head.Metadata?.sha256 === asset.sha256, `R2 SHA-256 metadata mismatch for ${asset.name}`);
  assert(head.ChecksumSHA256 === asset.sha256Base64, `R2 server checksum mismatch for ${asset.name}`);
  const publicEvidence = verifyPublicOrigin(
    `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}`,
    asset.size,
  );
  return {
    name: asset.name,
    key: objectKey,
    size: asset.size,
    sha256: asset.sha256,
    server_checksum: `sha256:${head.ChecksumSHA256}`,
    etag: head.ETag,
    ...publicEvidence,
  };
}

function ossHead(binary, env, objectKey) {
  const result = run(binary, [
    'api', 'head-object',
    '--bucket', env.ALIYUN_OSS_BUCKET,
    '--key', objectKey,
    '--output-format', 'json',
    '--quiet',
    ...ossArgs(env),
  ], { allowFailure: true });
  return result.status === 0 ? parseJsonResult(result, 'OSS head-object') : null;
}

export function buildOssPutObjectArgs(env, asset, objectKey) {
  // ossutil 2.3.0 exposes no --content-md5 flag for `api put-object` even
  // though Content-MD5 exists in the REST API. End-state integrity remains
  // independently proven below by size, immutable SHA-256 metadata, and the
  // PutObject ETag matching the local MD5 before the public transport probes.
  return [
    'api', 'put-object',
    '--bucket', env.ALIYUN_OSS_BUCKET,
    '--key', objectKey,
    '--body', `file://${asset.filePath}`,
    '--content-type', asset.content_type,
    '--cache-control', 'public, max-age=31536000, immutable',
    '--metadata', `sha256=${asset.sha256}`,
    '--forbid-overwrite', 'true',
    ...ossArgs(env),
  ];
}

function headerValue(payload, name) {
  const headers = payload?.Header || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key]?.[0] : null;
}

export function mirrorToOss(binary, env, asset, objectKey) {
  let head = ossHead(binary, env, objectKey);
  if (!head) {
    const upload = run(binary, buildOssPutObjectArgs(env, asset, objectKey), {
      allowFailure: true,
    });
    if (upload.status !== 0) {
      head = ossHead(binary, env, objectKey);
      if (!head) throw new Error(`OSS create-only upload failed for ${asset.name}: ${upload.stderr}`);
    } else {
      head = ossHead(binary, env, objectKey);
    }
  }
  assert(Number(headerValue(head, 'Content-Length')) === asset.size, `OSS size mismatch for ${asset.name}`);
  assert(headerValue(head, 'X-Oss-Meta-Sha256') === asset.sha256, `OSS SHA-256 metadata mismatch for ${asset.name}`);
  const etag = String(headerValue(head, 'ETag') || '').replaceAll('"', '').toLowerCase();
  assert(etag === asset.md5Hex, `OSS server MD5 mismatch for ${asset.name}`);
  const publicEvidence = verifyPublicOrigin(
    `${env.ALIYUN_OSS_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}`,
    asset.size,
  );
  return {
    name: asset.name,
    key: objectKey,
    size: asset.size,
    sha256: asset.sha256,
    server_checksum: `md5:${etag}`,
    etag: headerValue(head, 'ETag'),
    ...publicEvidence,
  };
}

export function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, resolved);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--candidate', '--asset-root', '--output'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--candidate', '--asset-root', '--output']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

export function buildMirrorReceipt(candidate, origins) {
  return {
    schema: MIRROR_RECEIPT_SCHEMA,
    candidate_id: candidate.candidate_id,
    transaction_id: candidate.candidate.transaction_id,
    platform: candidate.candidate.platform,
    origins,
    mirrored_at: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), envInput = process.env) {
  const args = parseArguments(argv);
  const env = requiredEnvironment(envInput);
  const candidateInput = JSON.parse(readFileSync(path.resolve(args['--candidate']), 'utf8'));
  const { candidate, files } = validateAssetDirectory(candidateInput, args['--asset-root']);
  await assertCurrentReleaseTagAllowed({
    tag: candidate.candidate.release.tag,
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
  });
  const binary = ensureOssutil(env);
  assertImmutableMirrorStorage(binary, env);
  const tag = candidate.candidate.release.tag;
  const r2Objects = [];
  const ossObjects = [];
  for (const asset of files) {
    assert(asset.size <= 5 * 1024 * 1024 * 1024, `single-request mirror limit exceeded: ${asset.name}`);
    const objectKey = `releases/${tag}/${asset.name}`;
    r2Objects.push(mirrorToR2(env, asset, objectKey));
    ossObjects.push(mirrorToOss(binary, env, asset, objectKey));
  }
  const receipt = buildMirrorReceipt(candidate, [
    { origin: 'r2', objects: r2Objects },
    { origin: 'oss', objects: ossObjects },
  ]);
  atomicWriteJson(args['--output'], receipt);
  process.stdout.write(`mirrored ${candidate.candidate.platform} candidate ${candidate.candidate_id}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
