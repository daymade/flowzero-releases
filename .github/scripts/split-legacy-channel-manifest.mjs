#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function oneAsset(assets, predicate, label) {
  const matches = assets.filter(predicate);
  assert(matches.length === 1, `legacy channel must contain exactly one ${label}`);
  return matches[0];
}

function roleAsset(asset, role) {
  return {
    role,
    name: asset.name,
    content_type: asset.content_type,
    size: asset.size,
    sha256: asset.sha256,
  };
}

export function splitLegacyManifest({ legacy, platform, sourceHeadSha }) {
  assert(legacy?.schema === 'flowzero.update_channel_manifest.v1', 'legacy manifest schema is invalid');
  assert(legacy.state === 'published', 'legacy migration requires a published manifest');
  assert(['macos-arm64', 'windows-x64'].includes(platform), 'migration platform is invalid');
  assert(/^[a-f0-9]{40}$/.test(sourceHeadSha || ''), 'migration source SHA is invalid');
  const transactionIdentity = {
    migration: 'legacy_combined_v1',
    channel: legacy.channel,
    tag: legacy.tag,
    source_head_sha: sourceHeadSha,
  };
  const transactionId = `sha256:${createHash('sha256').update(canonicalJson(transactionIdentity)).digest('hex')}`;
  let assets;
  let update;
  if (platform === 'macos-arm64') {
    const dmg = oneAsset(legacy.assets, (asset) => asset.name.endsWith('.dmg'), 'DMG');
    const zip = oneAsset(legacy.assets, (asset) => asset.name.endsWith('.zip'), 'updater ZIP');
    const integrity = oneAsset(legacy.assets, (asset) => asset.name === 'mac-update-integrity.json', 'mac integrity asset');
    assert(legacy.mac_update_integrity?.file?.name === zip.name, 'legacy Mac integrity ZIP mismatch');
    assert(legacy.mac_update_integrity?.dmg?.name === dmg.name, 'legacy Mac integrity DMG mismatch');
    assets = [
      roleAsset(dmg, 'macos_dmg'),
      { ...roleAsset(zip, 'macos_updater_zip'), sha512: legacy.mac_update_integrity.file.sha512 },
      roleAsset(integrity, 'macos_update_integrity'),
    ];
    update = { mac_update_integrity: legacy.mac_update_integrity };
  } else {
    const setup = oneAsset(legacy.assets, (asset) => asset.name.endsWith('-Setup.exe'), 'Setup.exe');
    const nupkg = oneAsset(legacy.assets, (asset) => asset.name.endsWith('.nupkg'), 'nupkg');
    const releases = oneAsset(legacy.assets, (asset) => asset.name === 'RELEASES', 'RELEASES');
    assert(typeof legacy.squirrel_releases === 'string' && legacy.squirrel_releases.includes(nupkg.name), 'legacy RELEASES nupkg mismatch');
    assets = [
      roleAsset(setup, 'windows_setup'),
      roleAsset(nupkg, 'windows_nupkg'),
      roleAsset(releases, 'windows_releases'),
    ];
    update = { squirrel_releases: legacy.squirrel_releases };
  }
  const checkpointIdentity = { transaction_id: transactionId, platform, assets, update };
  return {
    schema: 'flowzero.update_platform_manifest.v1',
    channel: legacy.channel,
    platform,
    state: 'published',
    tag: legacy.tag,
    version: legacy.tag.slice(1),
    published_at: legacy.published_at,
    notes: legacy.notes,
    transaction_id: transactionId,
    checkpoint_id: `sha256:${createHash('sha256').update(canonicalJson(checkpointIdentity)).digest('hex')}`,
    source_head_sha: sourceHeadSha,
    assets,
    update,
    verified_mirrors: [{ origin: 'r2', object_count: assets.length }, { origin: 'oss', object_count: assets.length }],
    migration: {
      from_schema: legacy.schema,
      evidence_scope: 'previously_published_immutable_release',
    },
  };
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

export async function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  for (const key of ['--legacy-manifest', '--platform', '--source-head-sha', '--output']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  const legacy = JSON.parse(await readFile(path.resolve(values['--legacy-manifest']), 'utf8'));
  const result = splitLegacyManifest({
    legacy,
    platform: values['--platform'],
    sourceHeadSha: values['--source-head-sha'],
  });
  await atomicWriteJson(values['--output'], result);
  process.stdout.write(`${result.platform}:${result.tag}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
