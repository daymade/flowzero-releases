#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCurrentReleaseTagWithdrawn } from './check-current-release-tombstone.mjs';
import { buildNoReleasePlatformManifest } from './generate-platform-channel-manifest.mjs';
import { atomicWriteJson, r2Head, verifyPublicOrigin } from './mirror-release-assets.mjs';
import {
  putCurrentJson,
  putImmutableJson,
  readCurrent,
} from './promote-platform-channel.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--channel', '--platform', '--withdrawn-tag', '--confirm-withdrawal', '--output'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--channel', '--platform', '--withdrawn-tag', '--confirm-withdrawal', '--output']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  assert(values['--confirm-withdrawal'] === values['--withdrawn-tag'], 'confirm-withdrawal must exactly equal the withdrawn tag');
  return values;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  for (const name of [
    'RUNNER_TEMP',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
  ]) assert(env[name], `missing withdrawal configuration: ${name}`);
  const args = parseArguments(argv);
  const tag = args['--withdrawn-tag'];
  const tombstone = await assertCurrentReleaseTagWithdrawn({
    tag,
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
  });
  const baseKey = `channels/${args['--channel']}/platforms/${args['--platform']}`;
  const currentKey = `${baseKey}/current.json`;
  const before = readCurrent(env, currentKey);
  assert(before.head && before.manifest, `platform channel does not exist: ${currentKey}`);
  const manifest = {
    ...buildNoReleasePlatformManifest({
      channel: args['--channel'],
      platform: args['--platform'],
    }),
    transition: {
      kind: 'withdrawal',
      from_tag: tag,
      withdrawn_on: tombstone.withdrawn_on,
      reason: tombstone.reason,
    },
  };
  const alreadyWithdrawn = before.manifest.state === 'no_release';
  if (alreadyWithdrawn) {
    assert(
      JSON.stringify(before.manifest) === JSON.stringify(manifest),
      'platform is no_release for a different transition',
    );
  } else {
    assert(before.manifest.state === 'published', `unexpected platform state: ${before.manifest.state}`);
    assert(before.manifest.tag === tag, `platform current tag is ${before.manifest.tag}, not ${tag}`);
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digestHex = createHash('sha256').update(bytes).digest('hex');
  const digestBase64 = createHash('sha256').update(bytes).digest('base64');
  const filePath = path.join(env.RUNNER_TEMP, `tinkle_withdraw-${args['--channel']}-${args['--platform']}.json`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  const immutableKey = `${baseKey}/states/withdrawn-${tag}.json`;
  putImmutableJson(env, immutableKey, filePath, digestHex, digestBase64, bytes.length);
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${immutableKey}`, bytes.length);
  if (!alreadyWithdrawn) {
    putCurrentJson(env, currentKey, filePath, digestHex, digestBase64, before.head);
  }
  const current = r2Head(env, currentKey);
  assert(current?.ContentLength === bytes.length, 'withdrawn current pointer size mismatch');
  assert(current?.Metadata?.sha256 === digestHex, 'withdrawn current pointer digest mismatch');
  assert(current?.ChecksumSHA256 === digestBase64, 'withdrawn current pointer checksum mismatch');
  verifyPublicOrigin(`${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${currentKey}?withdrawal=${digestHex}`, bytes.length);
  const receipt = {
    schema: 'flowzero.platform_withdrawal_receipt.v1',
    channel: args['--channel'],
    platform: args['--platform'],
    withdrawn_tag: tag,
    immutable_key: immutableKey,
    current_key: currentKey,
    manifest_sha256: digestHex,
    status: alreadyWithdrawn ? 'already_withdrawn' : 'withdrawn',
    withdrawn_at: new Date().toISOString(),
  };
  atomicWriteJson(args['--output'], receipt);
  process.stdout.write(`withdrew ${tag} from ${receipt.channel}/${receipt.platform}\n`);
  return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Platform withdrawal failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
