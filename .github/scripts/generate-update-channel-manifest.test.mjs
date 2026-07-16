import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChannelManifest,
  SCHEMA,
} from './generate-update-channel-manifest.mjs';

const updaterZip = 'Flowzero-darwin-arm64-0.1.2-beta.7.zip';
const nupkg = 'Flowzero-0.1.2-beta7-full.nupkg';
const macUpdateIntegrity = {
  schema: 'flowzero.macos_update_integrity.v1',
  version: '0.1.2-beta.7',
  file: {
    name: updaterZip,
    size: 100,
    sha512: Buffer.alloc(64, 2).toString('base64'),
  },
};
const squirrelReleases = `hash ${nupkg} 200\n`;
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
      name: 'mac-update-integrity.json',
      content_type: 'application/json',
      size: 250,
      digest: `sha256:${'3'.repeat(64)}`,
    },
    {
      name: 'RELEASES',
      content_type: 'application/octet-stream',
      size: Buffer.byteLength(squirrelReleases),
      digest: `sha256:${'4'.repeat(64)}`,
    },
  ],
};

const build = (overrides = {}) => buildChannelManifest({
  release,
  channel: 'beta',
  macUpdateIntegrity,
  squirrelReleases,
  macIntegrityByteLength: 250,
  squirrelReleasesByteLength: Buffer.byteLength(squirrelReleases),
  ...overrides,
});

test('generates a deterministic published channel snapshot', () => {
  const manifest = build();

  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.channel, 'beta');
  assert.equal(manifest.state, 'published');
  assert.equal(manifest.tag, release.tag_name);
  assert.equal(manifest.assets[0].name, nupkg);
  assert.equal(manifest.assets[0].sha256, '2'.repeat(64));
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
});
