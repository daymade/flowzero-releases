import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildChannelManifest,
  buildNoReleaseChannelManifest,
  SCHEMA,
} from './generate-update-channel-manifest.mjs';

const updaterZip = 'Flowzero-darwin-arm64-0.1.2-beta.7.zip';
const dmg = 'Flowzero-0.1.2-beta.7-arm64.dmg';
const nupkg = 'Flowzero-0.1.2-beta7-full.nupkg';
const macUpdateIntegrity = {
  schema: 'flowzero.macos_update_integrity.v1',
  version: '0.1.2-beta.7',
  file: {
    name: updaterZip,
    size: 100,
    sha512: Buffer.alloc(64, 2).toString('base64'),
    sha256: '1'.repeat(64),
  },
  dmg: {
    name: dmg,
    size: 300,
    sha256: '5'.repeat(64),
  },
};
const squirrelReleases = `hash ${nupkg} 200\n`;
const macIntegrityContent = `${JSON.stringify(macUpdateIntegrity, null, 2)}\n`;
const macIntegritySha256 = createHash('sha256').update(macIntegrityContent).digest('hex');
const squirrelReleasesSha256 = createHash('sha256').update(squirrelReleases).digest('hex');
const release = {
  tag_name: 'v0.1.2-beta.7',
  draft: false,
  prerelease: true,
  published_at: '2026-07-16T10:58:30Z',
  body: 'Internal beta',
  assets: [
    {
      name: updaterZip,
      content_type: 'application/zip',
      size: 100,
      digest: `sha256:${'1'.repeat(64)}`,
    },
    {
      name: nupkg,
      content_type: 'application/octet-stream',
      size: 200,
      digest: `sha256:${'2'.repeat(64)}`,
    },
    {
      name: dmg,
      content_type: 'application/x-apple-diskimage',
      size: 300,
      digest: `sha256:${'5'.repeat(64)}`,
    },
    {
      name: 'mac-update-integrity.json',
      content_type: 'application/json',
      size: Buffer.byteLength(macIntegrityContent),
      digest: `sha256:${macIntegritySha256}`,
    },
    {
      name: 'RELEASES',
      content_type: 'application/octet-stream',
      size: Buffer.byteLength(squirrelReleases),
      digest: `sha256:${squirrelReleasesSha256}`,
    },
  ],
};

const build = (overrides = {}) => buildChannelManifest({
  release,
  channel: 'beta',
  macUpdateIntegrity,
  squirrelReleases,
  macIntegrityByteLength: Buffer.byteLength(macIntegrityContent),
  squirrelReleasesByteLength: Buffer.byteLength(squirrelReleases),
  macIntegritySha256,
  squirrelReleasesSha256,
  ...overrides,
});

test('generates a deterministic published channel snapshot', () => {
  const manifest = build();

  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.channel, 'beta');
  assert.equal(manifest.state, 'published');
  assert.equal(manifest.tag, release.tag_name);
  assert.equal(manifest.assets.find((asset) => asset.name === nupkg)?.sha256, '2'.repeat(64));
  assert.deepEqual(manifest.mac_update_integrity, macUpdateIntegrity);
  assert.equal(manifest.squirrel_releases, squirrelReleases);
});

test('rejects draft releases and channel drift', () => {
  assert.throws(
    () => build({ release: { ...release, draft: true } }),
    /published release/,
  );
  assert.throws(
    () => build({ channel: 'stable' }),
    /prerelease flag/,
  );
});

test('rejects sidecar and updater evidence that does not match assets', () => {
  assert.throws(
    () => build({ squirrelReleasesByteLength: 1 }),
    /byte length/,
  );
  assert.throws(
    () => build({
      macUpdateIntegrity: {
        ...macUpdateIntegrity,
        version: '0.1.2-beta.6',
      },
    }),
    /does not match/,
  );
  assert.throws(
    () => build({ squirrelReleases: 'missing package' }),
    /does not reference/,
  );
  const sameLengthSidecar = macIntegrityContent.replace('  "schema"', ' \t"schema"');
  assert.equal(Buffer.byteLength(sameLengthSidecar), Buffer.byteLength(macIntegrityContent));
  assert.throws(
    () => build({
      macIntegritySha256: createHash('sha256').update(sameLengthSidecar).digest('hex'),
    }),
    /content does not match/,
  );
  const sameLengthReleases = squirrelReleases.replace('hash', 'HASH');
  assert.equal(Buffer.byteLength(sameLengthReleases), Buffer.byteLength(squirrelReleases));
  assert.throws(
    () => build({
      squirrelReleases: sameLengthReleases,
      squirrelReleasesSha256: createHash('sha256').update(sameLengthReleases).digest('hex'),
    }),
    /content does not match/,
  );
  assert.throws(
    () => build({
      macUpdateIntegrity: {
        ...macUpdateIntegrity,
        file: { ...macUpdateIntegrity.file, sha256: '9'.repeat(64) },
      },
    }),
    /ZIP integrity/,
  );
  assert.throws(
    () => build({
      macUpdateIntegrity: {
        ...macUpdateIntegrity,
        dmg: { ...macUpdateIntegrity.dmg, sha256: '9'.repeat(64) },
      },
    }),
    /DMG integrity/,
  );
});

test('generates a deterministic explicit no-release channel snapshot', () => {
  assert.deepEqual(buildNoReleaseChannelManifest('stable'), {
    schema: SCHEMA,
    channel: 'stable',
    state: 'no_release',
  });
});

test('rejects an invalid no-release channel', () => {
  assert.throws(
    () => buildNoReleaseChannelManifest('nightly'),
    /stable or beta/,
  );
});
