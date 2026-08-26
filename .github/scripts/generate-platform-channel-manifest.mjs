#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';
import {
  CHECKPOINT_SCHEMA,
  validateCandidateEnvelope,
  validateMirrorReceipt,
} from './release-platform-checkpoint.mjs';

export const SCHEMA = 'flowzero.update_platform_manifest.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function buildNoReleasePlatformManifest({ channel, platform }) {
  assert(['stable', 'beta'].includes(channel), 'channel is invalid');
  assert(['macos-arm64', 'windows-x64'].includes(platform), 'platform is invalid');
  return { schema: SCHEMA, channel, platform, state: 'no_release' };
}

export function buildPlatformChannelManifest({
  checkpoint,
  notes,
  publishedAt = new Date().toISOString(),
}) {
  assert(checkpoint?.schema === CHECKPOINT_SCHEMA, 'checkpoint schema is unsupported');
  const expectedCheckpointId = `sha256:${createHash('sha256')
    .update(canonicalJson(checkpoint.checkpoint))
    .digest('hex')}`;
  assert(checkpoint.checkpoint_id === expectedCheckpointId, 'checkpoint id is invalid');
  assert(checkpoint.checkpoint.phase === 'mirrored', 'platform channel requires a mirrored checkpoint');
  const candidate = validateCandidateEnvelope(checkpoint.checkpoint.candidate);
  validateMirrorReceipt(checkpoint.checkpoint.mirror_receipt, candidate);
  const resolvedNotes = notes === undefined
    ? `Flowzero ${candidate.candidate.release.tag} for ${candidate.candidate.platform}`
    : notes;
  assert(typeof resolvedNotes === 'string' && resolvedNotes.trim(), 'notes must be a non-empty string');
  assert(!Number.isNaN(Date.parse(publishedAt)), 'publishedAt is invalid');
  const payload = candidate.candidate;
  return {
    schema: SCHEMA,
    channel: payload.release.channel,
    platform: payload.platform,
    state: 'published',
    tag: payload.release.tag,
    version: payload.release.version,
    variant: payload.release.variant,
    published_at: publishedAt,
    notes: resolvedNotes,
    transaction_id: payload.transaction_id,
    checkpoint_id: checkpoint.checkpoint_id,
    source_head_sha: payload.source.head_sha,
    assets: payload.assets,
    update: payload.update,
    verified_mirrors: checkpoint.checkpoint.mirror_receipt.origins.map((origin) => ({
      origin: origin.origin,
      object_count: origin.objects.length,
    })),
  };
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--checkpoint', '--notes-file', '--published-at', '--state', '--channel', '--platform', '--output'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    if (values[key]) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
  }
  if (!values['--output']) throw new Error('missing argument: --output');
  const state = values['--state'] || 'published';
  if (state === 'published' && !values['--checkpoint']) throw new Error('published state requires --checkpoint');
  if (state === 'no_release' && (!values['--channel'] || !values['--platform'])) {
    throw new Error('no_release state requires --channel and --platform');
  }
  values.state = state;
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  let manifest;
  if (args.state === 'no_release') {
    manifest = buildNoReleasePlatformManifest({
      channel: args['--channel'],
      platform: args['--platform'],
    });
  } else {
    const checkpoint = JSON.parse(await readFile(path.resolve(args['--checkpoint']), 'utf8'));
    const notes = args['--notes-file']
      ? await readFile(path.resolve(args['--notes-file']), 'utf8')
      : undefined;
    manifest = buildPlatformChannelManifest({
      checkpoint,
      notes,
      publishedAt: args['--published-at'] || new Date().toISOString(),
    });
  }
  await atomicWriteJson(args['--output'], manifest);
  process.stdout.write(`${manifest.platform}:${manifest.tag || 'no_release'}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
