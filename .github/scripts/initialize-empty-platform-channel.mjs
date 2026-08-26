#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNoReleasePlatformManifest } from './generate-platform-channel-manifest.mjs';
import { r2Head, run, verifyPublicOrigin } from './mirror-release-assets.mjs';
import {
  putCurrentJson,
  putImmutableJson,
} from './promote-platform-channel.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--channel', '--platform', '--confirm-empty'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  assert(values['--confirm-empty'] === 'true', '--confirm-empty true is required');
  return values;
}

export function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const headObject = dependencies.r2Head || r2Head;
  const runCommand = dependencies.run || run;
  const putImmutable = dependencies.putImmutableJson || putImmutableJson;
  const putCurrent = dependencies.putCurrentJson || putCurrentJson;
  const verifyPublic = dependencies.verifyPublicOrigin || verifyPublicOrigin;
  for (const name of ['RUNNER_TEMP', 'R2_ENDPOINT', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL']) {
    assert(env[name], `missing initialization configuration: ${name}`);
  }
  const args = parseArguments(argv);
  const manifest = buildNoReleasePlatformManifest({
    channel: args['--channel'],
    platform: args['--platform'],
  });
  const baseKey = `channels/${manifest.channel}/platforms/${manifest.platform}`;
  const immutableKey = `${baseKey}/states/no-release.json`;
  const currentKey = `${baseKey}/current.json`;
  assert(!headObject(env, currentKey), `platform channel already exists: ${currentKey}`);
  for (const suffix of ['releases', 'checkpoints']) {
    const existing = runCommand('aws', [
      's3api', 'list-objects-v2',
      '--bucket', env.R2_BUCKET,
      '--prefix', `${baseKey}/${suffix}/`,
      '--max-keys', '1',
      '--endpoint-url', env.R2_ENDPOINT,
      '--output', 'json',
    ]);
    const index = JSON.parse(existing.stdout || '{}');
    assert(Number(index.KeyCount || index.Contents?.length || 0) === 0, 'published platform snapshots or checkpoints already exist; use an explicit recovery or withdrawal transition');
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digestHex = createHash('sha256').update(bytes).digest('hex');
  const digestBase64 = createHash('sha256').update(bytes).digest('base64');
  const filePath = path.join(env.RUNNER_TEMP, `tinkle_${manifest.channel}-${manifest.platform}-no-release.json`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  putImmutable(env, immutableKey, filePath, digestHex, digestBase64, bytes.length);
  verifyPublic(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${immutableKey}`, bytes.length);
  putCurrent(env, currentKey, filePath, digestHex, digestBase64, null);
  const current = headObject(env, currentKey);
  assert(current?.ContentLength === bytes.length, 'initialized current pointer size mismatch');
  assert(current?.Metadata?.sha256 === digestHex, 'initialized current pointer digest mismatch');
  assert(current?.ChecksumSHA256 === digestBase64, 'initialized current pointer checksum mismatch');
  verifyPublic(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${currentKey}?initial=${digestHex}`, bytes.length);
  process.stdout.write(`initialized ${manifest.channel}/${manifest.platform} as no_release\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
