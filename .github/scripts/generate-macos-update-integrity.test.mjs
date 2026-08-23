import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildIntegrityManifest,
  main,
  SCHEMA,
  verifyIntegrityManifest,
} from './generate-macos-update-integrity.mjs';

test('generates a deterministic SHA-512 integrity manifest for the only updater ZIP', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowzero-mac-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  await mkdir(path.join(artifactRoot, 'zip', 'darwin', 'arm64'), { recursive: true });
  await writeFile(
    path.join(artifactRoot, 'zip', 'darwin', 'arm64', 'Flowzero-darwin-arm64-1.2.3-beta.4.zip'),
    'signed-app-zip',
  );
  await writeFile(path.join(artifactRoot, 'Flowzero-1.2.3-beta.4-arm64.dmg'), 'signed-app-dmg');

  const manifest = await buildIntegrityManifest({ assetRoot: artifactRoot, version: '1.2.3-beta.4' });

  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.version, '1.2.3-beta.4');
  assert.equal(manifest.file.name, 'Flowzero-darwin-arm64-1.2.3-beta.4.zip');
  assert.equal(manifest.file.size, 14);
  assert.match(manifest.file.sha512, /^[A-Za-z0-9+/]{86}==$/);
  assert.match(manifest.file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.dmg.name, 'Flowzero-1.2.3-beta.4-arm64.dmg');
  assert.equal(manifest.dmg.size, 14);
  assert.match(manifest.dmg.sha256, /^[a-f0-9]{64}$/);
});

test('writes JSON that is also valid YAML and rejects ambiguous updater ZIPs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowzero-mac-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'Flowzero-darwin-arm64-1.2.3.zip'), 'one');
  await writeFile(path.join(artifactRoot, 'Flowzero-1.2.3-arm64.dmg'), 'dmg');
  const output = path.join(root, 'metadata', 'mac-update-integrity.json');

  await main(['--asset-root', artifactRoot, '--version', '1.2.3', '--output', output]);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).version, '1.2.3');

  await writeFile(path.join(artifactRoot, 'duplicate-1.2.3.zip'), 'two');
  await assert.rejects(
    buildIntegrityManifest({ assetRoot: artifactRoot, version: '1.2.3' }),
    /exactly one/,
  );
});

test('verifies both downloaded macOS assets and rejects a changed DMG', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowzero-mac-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'Flowzero-darwin-arm64-1.2.3.zip'), 'zip');
  const dmgPath = path.join(root, 'Flowzero-1.2.3-arm64.dmg');
  await writeFile(dmgPath, 'dmg');

  const manifest = await buildIntegrityManifest({ assetRoot: root, version: '1.2.3' });
  await assert.doesNotReject(verifyIntegrityManifest({ assetRoot: root, manifest }));

  await writeFile(dmgPath, 'changed-dmg');
  await assert.rejects(
    verifyIntegrityManifest({ assetRoot: root, manifest }),
    /do not match/,
  );
});
