#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const SCHEMA = 'flowzero.macos_update_integrity.v1';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function findFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinks are forbidden in the macOS release artifact tree: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await findFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function hashFile(filePath, algorithm, encoding) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('error', reject)
      .on('end', resolve)
      .pipe(hash, { end: false });
  });
  hash.end();
  return hash.digest(encoding);
}

export async function buildIntegrityManifest({ assetRoot, version }) {
  if (!VERSION_PATTERN.test(version ?? '')) {
    throw new Error(`Version must be SemVer without a v prefix: ${version ?? '(missing)'}`);
  }

  const files = await findFiles(assetRoot);
  const zipFiles = files.filter((filePath) => filePath.toLowerCase().endsWith('.zip'));
  const dmgFiles = files.filter((filePath) => filePath.toLowerCase().endsWith('.dmg'));
  if (zipFiles.length !== 1) {
    throw new Error(`Expected exactly one macOS updater ZIP, found ${zipFiles.length}`);
  }
  if (dmgFiles.length !== 1) {
    throw new Error(`Expected exactly one macOS DMG, found ${dmgFiles.length}`);
  }

  const zipPath = zipFiles[0];
  const dmgPath = dmgFiles[0];
  const zipInfo = await stat(zipPath);
  const dmgInfo = await stat(dmgPath);
  if (!zipInfo.isFile() || zipInfo.size <= 0) {
    throw new Error(`macOS updater ZIP is empty or invalid: ${zipPath}`);
  }
  if (!dmgInfo.isFile() || dmgInfo.size <= 0) {
    throw new Error(`macOS DMG is empty or invalid: ${dmgPath}`);
  }

  const zipName = path.basename(zipPath);
  const dmgName = path.basename(dmgPath);
  if (!zipName.includes(version)) {
    throw new Error(`macOS updater ZIP name does not contain release version ${version}: ${zipName}`);
  }
  if (!dmgName.includes(version)) {
    throw new Error(`macOS DMG name does not contain release version ${version}: ${dmgName}`);
  }

  return {
    schema: SCHEMA,
    version,
    file: {
      name: zipName,
      size: zipInfo.size,
      sha512: await hashFile(zipPath, 'sha512', 'base64'),
      sha256: await hashFile(zipPath, 'sha256', 'hex'),
    },
    dmg: {
      name: dmgName,
      size: dmgInfo.size,
      sha256: await hashFile(dmgPath, 'sha256', 'hex'),
    },
  };
}

export async function verifyIntegrityManifest({ assetRoot, manifest }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('macOS integrity manifest must be a JSON object');
  }
  if (manifest.schema !== SCHEMA) {
    throw new Error(`Unsupported macOS integrity schema: ${String(manifest.schema)}`);
  }
  const actual = await buildIntegrityManifest({ assetRoot, version: manifest.version });
  if (!isDeepStrictEqual(actual, manifest)) {
    throw new Error('macOS release assets do not match mac-update-integrity.json');
  }
  return actual;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--asset-root', '--version', '--output', '--manifest'].includes(key) || !value) {
      throw new Error(
        'Usage: generate-macos-update-integrity '
        + '--asset-root <dir> (--version <semver> --output <file> | --manifest <file>)',
      );
    }
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  if (!values['--asset-root']) throw new Error('Missing required argument: --asset-root');
  const verifyMode = Boolean(values['--manifest']);
  if (verifyMode && (values['--version'] || values['--output'])) {
    throw new Error('--manifest cannot be combined with --version or --output');
  }
  if (!verifyMode && (!values['--version'] || !values['--output'])) {
    throw new Error('Generation requires --version and --output');
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const assetRoot = path.resolve(args['--asset-root']);
  if (args['--manifest']) {
    const manifestPath = path.resolve(args['--manifest']);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const verified = await verifyIntegrityManifest({ assetRoot, manifest });
    process.stdout.write(`Verified ${manifestPath} for ${verified.file.name} and ${verified.dmg.name}\n`);
    return;
  }
  const output = path.resolve(args['--output']);
  const manifest = await buildIntegrityManifest({
    assetRoot,
    version: args['--version'],
  });

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`Generated ${output} for ${manifest.file.name}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
