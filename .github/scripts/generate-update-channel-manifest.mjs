#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'flowzero.update_channel_manifest.v1';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/;

function assertObjectName(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw new Error(`${label} must be a non-empty object name`);
  }
}

function releaseVersion(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error('Release tag must start with v');
  }
  const version = tag.slice(1);
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Release tag is not SemVer-compatible: ${tag}`);
  }
  return version;
}

function expectedPrerelease(channel) {
  if (!['stable', 'beta'].includes(channel)) {
    throw new Error('Channel must be stable or beta');
  }
  return channel === 'beta';
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error('Published release assets must be non-empty');
  }

  const names = new Set();
  return assets
    .map((asset, index) => {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
        throw new Error(`Release asset ${index} must be an object`);
      }
      assertObjectName(asset.name, `Release asset ${index} name`);
      if (names.has(asset.name)) {
        throw new Error(`Duplicate release asset name: ${asset.name}`);
      }
      names.add(asset.name);
      if (typeof asset.content_type !== 'string' || asset.content_type.length === 0) {
        throw new Error(`Release asset ${asset.name} is missing content_type`);
      }
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
        throw new Error(`Release asset ${asset.name} size must be a positive integer`);
      }
      const digestMatch = asset.digest?.match(SHA256_PATTERN);
      if (!digestMatch) {
        throw new Error(`Release asset ${asset.name} is missing a SHA-256 digest`);
      }

      return {
        name: asset.name,
        content_type: asset.content_type,
        size: asset.size,
        sha256: digestMatch[1],
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assetByName(assets, name) {
  const asset = assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Published release is missing ${name}`);
  return asset;
}

export function buildChannelManifest({
  release,
  channel,
  macUpdateIntegrity,
  squirrelReleases,
  macIntegrityByteLength,
  squirrelReleasesByteLength,
}) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Release metadata must be an object');
  }
  if (release.draft !== false) {
    throw new Error('Channel manifest can only be generated from a published release');
  }
  if (release.prerelease !== expectedPrerelease(channel)) {
    throw new Error(`Release prerelease flag does not match ${channel} channel`);
  }

  const version = releaseVersion(release.tag_name);
  if ((channel === 'beta') !== version.includes('-')) {
    throw new Error(`Release tag ${release.tag_name} does not belong to ${channel}`);
  }
  if (
    typeof release.published_at !== 'string'
    || Number.isNaN(Date.parse(release.published_at))
  ) {
    throw new Error('Published release is missing published_at');
  }

  const assets = normalizeAssets(release.assets);
  const macIntegrityAsset = assetByName(assets, 'mac-update-integrity.json');
  const releasesAsset = assetByName(assets, 'RELEASES');
  if (macIntegrityAsset.size !== macIntegrityByteLength) {
    throw new Error('mac-update-integrity.json byte length does not match the release asset');
  }
  if (releasesAsset.size !== squirrelReleasesByteLength) {
    throw new Error('RELEASES byte length does not match the release asset');
  }

  if (
    !macUpdateIntegrity
    || macUpdateIntegrity.schema !== 'flowzero.macos_update_integrity.v1'
    || macUpdateIntegrity.version !== version
    || !macUpdateIntegrity.file
  ) {
    throw new Error('mac-update-integrity.json does not match the published release');
  }
  assertObjectName(macUpdateIntegrity.file.name, 'macOS updater ZIP name');
  const updaterZip = assetByName(assets, macUpdateIntegrity.file.name);
  if (updaterZip.size !== macUpdateIntegrity.file.size) {
    throw new Error('macOS updater ZIP size does not match the release asset');
  }

  const nupkgAssets = assets.filter((asset) => asset.name.toLowerCase().endsWith('.nupkg'));
  if (nupkgAssets.length !== 1) {
    throw new Error(`Expected exactly one nupkg asset, found ${nupkgAssets.length}`);
  }
  if (!squirrelReleases.includes(nupkgAssets[0].name)) {
    throw new Error('RELEASES does not reference the published nupkg');
  }

  return {
    schema: SCHEMA,
    channel,
    state: 'published',
    tag: release.tag_name,
    published_at: release.published_at,
    notes: typeof release.body === 'string' ? release.body : '',
    assets,
    mac_update_integrity: macUpdateIntegrity,
    squirrel_releases: squirrelReleases,
  };
}

function parseArguments(argv) {
  const allowed = new Set([
    '--release-json',
    '--channel',
    '--mac-integrity',
    '--releases',
    '--output',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value) {
      throw new Error(
        'Usage: generate-update-channel-manifest '
        + '--release-json <file> --channel <stable|beta> '
        + '--mac-integrity <file> --releases <file> --output <file>',
      );
    }
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  for (const key of allowed) {
    if (!values[key]) throw new Error(`Missing required argument: ${key}`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const releaseBuffer = await readFile(path.resolve(args['--release-json']));
  const macIntegrityBuffer = await readFile(path.resolve(args['--mac-integrity']));
  const releasesBuffer = await readFile(path.resolve(args['--releases']));
  const manifest = buildChannelManifest({
    release: JSON.parse(releaseBuffer.toString('utf8')),
    channel: args['--channel'],
    macUpdateIntegrity: JSON.parse(macIntegrityBuffer.toString('utf8')),
    squirrelReleases: releasesBuffer.toString('utf8'),
    macIntegrityByteLength: macIntegrityBuffer.byteLength,
    squirrelReleasesByteLength: releasesBuffer.byteLength,
  });
  const output = path.resolve(args['--output']);
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`Generated ${output} for ${manifest.tag}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
