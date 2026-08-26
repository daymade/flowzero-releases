#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertChannelVersionForward } from './assert-channel-version-forward.mjs';
import { readCurrent } from './promote-platform-channel.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--channel', '--platform', '--target-tag', '--allow-downgrade'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--channel', '--platform', '--target-tag', '--allow-downgrade']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  assert(['stable', 'beta'].includes(values['--channel']), 'channel is invalid');
  assert(['macos-arm64', 'windows-x64'].includes(values['--platform']), 'platform is invalid');
  assert(['true', 'false'].includes(values['--allow-downgrade']), 'allow-downgrade is invalid');
  return values;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  for (const name of [
    'RUNNER_TEMP',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
  ]) {
    assert(typeof env[name] === 'string' && env[name].trim(), `missing ordering configuration: ${name}`);
  }
  const args = parseArguments(argv);
  const currentKey = `channels/${args['--channel']}/platforms/${args['--platform']}/current.json`;
  const current = readCurrent(env, currentKey);
  const result = assertChannelVersionForward({
    channel: args['--channel'],
    platform: args['--platform'],
    targetTag: args['--target-tag'],
    currentManifest: current.manifest,
    allowDowngrade: args['--allow-downgrade'] === 'true',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Platform ordering preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

