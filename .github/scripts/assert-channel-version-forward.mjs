#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseChannelReleaseTag } from './release-tag-contract.mjs';

export function parseChannelVersion(tag, channel) {
  return parseChannelReleaseTag(tag, channel).parts;
}

function compareParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function assertChannelVersionForward({
  channel,
  targetTag,
  currentManifest = null,
  allowDowngrade = false,
}) {
  if (typeof allowDowngrade !== 'boolean') {
    throw new Error('allowDowngrade must be boolean');
  }
  const target = parseChannelVersion(targetTag, channel);
  if (currentManifest === null) return { status: 'no_current', targetTag };
  if (!currentManifest || typeof currentManifest !== 'object' || Array.isArray(currentManifest)) {
    throw new Error('Current channel manifest must be an object');
  }
  if (
    currentManifest.schema !== 'flowzero.update_channel_manifest.v1'
    || currentManifest.channel !== channel
  ) {
    throw new Error('Current channel manifest identity does not match the requested channel');
  }
  if (currentManifest.state === 'no_release') {
    return { status: 'replacing_no_release', targetTag };
  }
  if (currentManifest.state !== 'published') {
    throw new Error(`Unknown current channel state: ${String(currentManifest.state)}`);
  }
  const currentTag = currentManifest.tag;
  const current = parseChannelVersion(currentTag, channel);
  const comparison = compareParts(target, current);
  if (comparison < 0 && !allowDowngrade) {
    throw new Error(`Refusing channel downgrade from ${currentTag} to ${targetTag}`);
  }
  return {
    status: comparison < 0 ? 'explicit_downgrade' : comparison === 0 ? 'idempotent' : 'forward',
    currentTag,
    targetTag,
  };
}

function parseArguments(argv) {
  const allowed = new Set([
    '--channel',
    '--target-tag',
    '--current-manifest',
    '--allow-downgrade',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error('Invalid channel version arguments');
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  for (const required of ['--channel', '--target-tag', '--allow-downgrade']) {
    if (!values[required]) throw new Error(`Missing required argument: ${required}`);
  }
  if (!['true', 'false'].includes(values['--allow-downgrade'])) {
    throw new Error('--allow-downgrade must be true or false');
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const currentManifest = args['--current-manifest']
    ? JSON.parse(await readFile(path.resolve(args['--current-manifest']), 'utf8'))
    : null;
  const result = assertChannelVersionForward({
    channel: args['--channel'],
    targetTag: args['--target-tag'],
    currentManifest,
    allowDowngrade: args['--allow-downgrade'] === 'true',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
