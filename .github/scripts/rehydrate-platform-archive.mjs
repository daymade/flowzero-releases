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
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateReleaseArchiveManifest } from './build-release-archive-manifest.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, { input, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--tag', '--platform', '--output-root'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--tag', '--platform', '--output-root']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  assert(['macos-arm64', 'windows-x64'].includes(values['--platform']), 'platform is invalid');
  return values;
}

function assertRemoteArchive(release, manifest, manifestPath) {
  assert(release.tag_name === manifest.archive.release.tag, 'GitHub archive tag mismatch');
  assert(release.draft === false && release.immutable === true, 'GitHub archive is not immutable');
  const expected = [
    ...manifest.archive.platforms.flatMap((entry) => entry.candidate.candidate.assets),
    {
      name: 'release-manifest.json',
      size: statSync(manifestPath).size,
      sha256: sha256File(manifestPath),
    },
  ];
  assert(release.assets?.length === expected.length, 'GitHub archive asset count mismatch');
  for (const asset of expected) {
    const remote = release.assets.find((entry) => entry.name === asset.name);
    assert(remote?.state === 'uploaded', `GitHub archive asset is not uploaded: ${asset.name}`);
    assert(remote.size === asset.size, `GitHub archive asset size mismatch: ${asset.name}`);
    assert(remote.digest === `sha256:${asset.sha256}`, `GitHub archive asset digest mismatch: ${asset.name}`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArguments(argv);
  assert(env.GITHUB_REPOSITORY === 'daymade/flowzero-releases', 'archive repair is running in the wrong repository');
  assert(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.trim(), 'GH_TOKEN is required');
  const outputRoot = path.resolve(args['--output-root']);
  assert(!existsSync(outputRoot) || readdirSync(outputRoot).length === 0, 'archive repair output root must be empty');
  mkdirSync(outputRoot, { recursive: true });
  const assetsRoot = path.join(outputRoot, 'artifacts');
  const evidenceRoot = path.join(outputRoot, 'evidence');
  mkdirSync(assetsRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });

  run('gh', [
    'release', 'download', args['--tag'],
    '--repo', env.GITHUB_REPOSITORY,
    '--pattern', 'release-manifest.json',
    '--dir', outputRoot,
  ]);
  const manifestPath = path.join(outputRoot, 'release-manifest.json');
  const manifest = validateReleaseArchiveManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  assert(manifest.archive.release.tag === args['--tag'], 'requested tag does not match release manifest');
  const platformEntry = manifest.archive.platforms.find((entry) => entry.platform === args['--platform']);
  assert(platformEntry, `release archive does not contain ${args['--platform']}`);

  const release = JSON.parse(run('gh', [
    'api', `repos/${env.GITHUB_REPOSITORY}/releases/tags/${args['--tag']}`,
  ]).stdout);
  assertRemoteArchive(release, manifest, manifestPath);
  run('gh', ['release', 'verify', args['--tag'], '--repo', env.GITHUB_REPOSITORY]);

  for (const asset of platformEntry.candidate.candidate.assets) {
    run('gh', [
      'release', 'download', args['--tag'],
      '--repo', env.GITHUB_REPOSITORY,
      '--pattern', asset.name,
      '--dir', assetsRoot,
    ]);
    const filePath = path.join(assetsRoot, asset.name);
    assert(existsSync(filePath) && statSync(filePath).isFile(), `archive asset is missing: ${asset.name}`);
    assert(statSync(filePath).size === asset.size, `archive asset size changed: ${asset.name}`);
    assert(sha256File(filePath) === asset.sha256, `archive asset digest changed: ${asset.name}`);
  }
  writeFileSync(
    path.join(evidenceRoot, 'candidate.json'),
    `${JSON.stringify(platformEntry.candidate, null, 2)}\n`,
  );
  if (platformEntry.windows_legacy_bridge) {
    writeFileSync(
      path.join(evidenceRoot, 'compatibility-binding.json'),
      `${JSON.stringify(platformEntry.windows_legacy_bridge.binding, null, 2)}\n`,
    );
    writeFileSync(
      path.join(evidenceRoot, 'bridge-hold.json'),
      `${JSON.stringify(platformEntry.windows_legacy_bridge.hold, null, 2)}\n`,
    );
  }
  writeFileSync(
    path.join(evidenceRoot, 'verification.json'),
    `${JSON.stringify(platformEntry.verification, null, 2)}\n`,
  );
  process.stdout.write(`rehydrated ${args['--tag']} ${args['--platform']} from immutable GitHub archive\n`);
  return platformEntry;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Archive rehydration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
