#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProjectReleaseTag } from './release-tag-contract.mjs';

export const SCHEMA = 'flowzero.release_asset_identity.v1';

const SHA256_DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;

function requireObjectName(value) {
  if (
    typeof value !== 'string'
    || !value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw new Error('Release asset name must be a single non-empty path component');
  }
  return value;
}

function assertExactReleaseRoles(assets) {
  const counts = {
    dmg: assets.filter((asset) => asset.name.endsWith('.dmg')).length,
    zip: assets.filter((asset) => asset.name.endsWith('.zip')).length,
    setup: assets.filter((asset) => asset.name.endsWith('-Setup.exe')).length,
    nupkg: assets.filter((asset) => asset.name.endsWith('.nupkg')).length,
    releases: assets.filter((asset) => asset.name === 'RELEASES').length,
    macIntegrity: assets.filter((asset) => asset.name === 'mac-update-integrity.json').length,
  };
  const expectedNames = assets.filter((asset) => (
    asset.name.endsWith('.dmg')
    || asset.name.endsWith('.zip')
    || asset.name.endsWith('-Setup.exe')
    || asset.name.endsWith('.nupkg')
    || asset.name === 'RELEASES'
    || asset.name === 'mac-update-integrity.json'
  ));
  if (
    assets.length !== 6
    || expectedNames.length !== 6
    || Object.values(counts).some((count) => count !== 1)
  ) {
    throw new Error('Release must contain exactly one asset for each final delivery role');
  }
}

function fingerprintAssets(assets) {
  const canonical = assets
    .map((asset) => `${asset.name}\t${asset.size}\tsha256:${asset.sha256}\n`)
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildReleaseAssetIdentity(release, options = {}) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Release metadata must be an object');
  }
  if (typeof options.expectedTag === 'string' && release.tag_name !== options.expectedTag) {
    throw new Error(`Release tag mismatch: expected ${options.expectedTag}`);
  }
  parseProjectReleaseTag(release.tag_name);
  if (
    typeof options.expectedDraft === 'boolean'
    && release.draft !== options.expectedDraft
  ) {
    throw new Error(`Release draft state mismatch: expected ${options.expectedDraft}`);
  }
  if (
    typeof options.expectedImmutable === 'boolean'
    && release.immutable !== options.expectedImmutable
  ) {
    throw new Error(`Release immutable state mismatch: expected ${options.expectedImmutable}`);
  }
  if (!Array.isArray(release.assets)) {
    throw new Error('Release assets must be an array');
  }

  const names = new Set();
  const assets = release.assets.map((asset) => {
    const name = requireObjectName(asset?.name);
    if (names.has(name)) throw new Error(`Duplicate release asset name: ${name}`);
    names.add(name);
    if (asset.state !== 'uploaded') {
      throw new Error(`Release asset ${name} is not uploaded`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Release asset ${name} size must be a positive integer`);
    }
    const digestMatch = asset.digest?.match(SHA256_DIGEST_PATTERN);
    if (!digestMatch) {
      throw new Error(`Release asset ${name} is missing a SHA-256 digest`);
    }
    return { name, size: asset.size, sha256: digestMatch[1] };
  }).sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));

  assertExactReleaseRoles(assets);
  return {
    schema: SCHEMA,
    tag: release.tag_name,
    draft: release.draft,
    immutable: release.immutable,
    fingerprint: fingerprintAssets(assets),
    assets,
  };
}

function parseArguments(argv) {
  const allowed = new Set([
    '--release-json',
    '--expected-tag',
    '--expected-draft',
    '--expected-immutable',
    '--output',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error('Invalid release asset identity arguments');
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  for (const required of [
    '--release-json',
    '--expected-tag',
    '--expected-draft',
    '--expected-immutable',
    '--output',
  ]) {
    if (!values[required]) throw new Error(`Missing required argument: ${required}`);
  }
  if (!['true', 'false'].includes(values['--expected-draft'])) {
    throw new Error('--expected-draft must be true or false');
  }
  if (!['true', 'false'].includes(values['--expected-immutable'])) {
    throw new Error('--expected-immutable must be true or false');
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const release = JSON.parse(await readFile(path.resolve(args['--release-json']), 'utf8'));
  const identity = buildReleaseAssetIdentity(release, {
    expectedTag: args['--expected-tag'],
    expectedDraft: args['--expected-draft'] === 'true',
    expectedImmutable: args['--expected-immutable'] === 'true',
  });
  const output = path.resolve(args['--output']);
  await writeFile(output, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  process.stdout.write(`${identity.fingerprint}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
