#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

async function sha512Base64(filePath) {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('error', reject)
      .on('end', resolve)
      .pipe(hash, { end: false });
  });
  hash.end();
  return hash.digest('base64');
}

export async function buildIntegrityManifest({ assetRoot, version }) {
  if (!VERSION_PATTERN.test(version ?? '')) {
    throw new Error(`Version must be SemVer without a v prefix: ${version ?? '(missing)'}`);
  }

  const files = await findFiles(assetRoot);
  const zipFiles = files.filter((filePath) => filePath.toLowerCase().endsWith('.zip'));
  if (zipFiles.length !== 1) {
    throw new Error(`Expected exactly one macOS updater ZIP, found ${zipFiles.length}`);
  }

  const zipPath = zipFiles[0];
  const fileInfo = await stat(zipPath);
  if (!fileInfo.isFile() || fileInfo.size <= 0) {
    throw new Error(`macOS updater ZIP is empty or invalid: ${zipPath}`);
  }

  const fileName = path.basename(zipPath);
  if (!fileName.includes(version)) {
    throw new Error(`macOS updater ZIP name does not contain release version ${version}: ${fileName}`);
  }

  return {
    schema: SCHEMA,
    version,
    file: {
      name: fileName,
      size: fileInfo.size,
      sha512: await sha512Base64(zipPath),
    },
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--asset-root', '--version', '--output'].includes(key) || !value) {
      throw new Error('Usage: generate-macos-update-integrity --asset-root <dir> --version <semver> --output <file>');
    }
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const assetRoot = path.resolve(args['--asset-root']);
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
