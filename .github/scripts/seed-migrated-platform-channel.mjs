#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCurrentReleaseTagAllowed } from './check-current-release-tombstone.mjs';
import { r2Head, verifyPublicOrigin } from './mirror-release-assets.mjs';
import {
  putCurrentJson,
  putImmutableJson,
  readCurrent,
} from './promote-platform-channel.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  assert(values['--manifest'], 'missing --manifest');
  assert(values['--confirm-migration'] === 'true', '--confirm-migration true is required');
  for (const name of [
    'RUNNER_TEMP',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
  ]) assert(env[name], `missing migration configuration: ${name}`);
  const manifestPath = path.resolve(values['--manifest']);
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert(manifest?.schema === 'flowzero.update_platform_manifest.v1', 'migration manifest schema is invalid');
  assert(manifest.migration?.from_schema === 'flowzero.update_channel_manifest.v1', 'manifest is not an explicit legacy migration');
  await assertCurrentReleaseTagAllowed({
    tag: manifest.tag,
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
  });
  const baseKey = `channels/${manifest.channel}/platforms/${manifest.platform}`;
  const immutableKey = `${baseKey}/releases/${manifest.tag}.json`;
  const currentKey = `${baseKey}/current.json`;
  const before = readCurrent(env, currentKey);
  if (before.manifest) {
    assert(
      JSON.stringify(before.manifest) === JSON.stringify(manifest),
      `refusing to overwrite existing platform pointer: ${currentKey}`,
    );
    process.stdout.write(`platform migration already complete for ${manifest.channel}/${manifest.platform}\n`);
    return manifest;
  }
  const digestHex = createHash('sha256').update(bytes).digest('hex');
  const digestBase64 = createHash('sha256').update(bytes).digest('base64');
  putImmutableJson(env, immutableKey, manifestPath, digestHex, digestBase64, bytes.length);
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${immutableKey}`, bytes.length);
  putCurrentJson(env, currentKey, manifestPath, digestHex, digestBase64, null);
  const current = r2Head(env, currentKey);
  assert(current?.ContentLength === bytes.length, 'migrated current pointer size mismatch');
  assert(current?.Metadata?.sha256 === digestHex, 'migrated current pointer digest mismatch');
  assert(current?.ChecksumSHA256 === digestBase64, 'migrated current pointer checksum mismatch');
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${currentKey}?migration=${digestHex}`, bytes.length);
  process.stdout.write(`seeded migrated platform channel ${manifest.channel}/${manifest.platform}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
