#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReleaseArchiveManifest } from './build-release-archive-manifest.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function atomicWriteJson(filePath, value) {
  const output = path.resolve(filePath);
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `tinkle_${path.basename(output)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, output);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--transaction', '--input-root', '--output-root'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--transaction', '--input-root', '--output-root']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const transaction = JSON.parse(readFileSync(path.resolve(args['--transaction']), 'utf8'));
  const inputRoot = path.resolve(args['--input-root']);
  const outputRoot = path.resolve(args['--output-root']);
  assert(!existsSync(outputRoot) || readdirSync(outputRoot).length === 0, 'archive output root must be empty');
  mkdirSync(outputRoot, { recursive: true });
  const entries = transaction.intent.requested_platforms.map((platform) => {
    const platformRoot = path.join(inputRoot, platform);
    const candidatePath = path.join(platformRoot, 'final', 'evidence', 'candidate.json');
    const verificationPath = path.join(platformRoot, 'verification', 'verification.json');
    assert(existsSync(candidatePath), `archive candidate is missing for ${platform}`);
    assert(existsSync(verificationPath), `archive verification is missing for ${platform}`);
    return {
      candidate: JSON.parse(readFileSync(candidatePath, 'utf8')),
      verification: JSON.parse(readFileSync(verificationPath, 'utf8')),
      ...(existsSync(path.join(platformRoot, 'verification', 'compatibility-binding.json'))
        ? {
          windowsLegacyBridge: {
            binding: JSON.parse(readFileSync(path.join(platformRoot, 'verification', 'compatibility-binding.json'), 'utf8')),
            hold: JSON.parse(readFileSync(path.join(platformRoot, 'verification', 'bridge-hold.json'), 'utf8')),
          },
        }
        : {}),
      artifactsRoot: path.join(platformRoot, 'final', 'artifacts'),
    };
  });
  const archiveManifest = buildReleaseArchiveManifest({ transaction, entries });
  for (let index = 0; index < entries.length; index += 1) {
    for (const asset of archiveManifest.archive.platforms[index].candidate.candidate.assets) {
      const source = path.join(entries[index].artifactsRoot, asset.name);
      const destination = path.join(outputRoot, asset.name);
      assert(existsSync(source), `archive asset is missing: ${asset.name}`);
      assert(!existsSync(destination), `archive asset name collision: ${asset.name}`);
      copyFileSync(source, destination);
    }
  }
  const manifestPath = path.join(outputRoot, 'release-manifest.json');
  atomicWriteJson(manifestPath, archiveManifest);
  process.stdout.write(`${manifestPath}\n`);
  return { manifestPath, archiveManifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
