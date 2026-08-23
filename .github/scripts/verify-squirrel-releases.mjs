#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA1_PATTERN = /^[a-f0-9]{40}$/iu;

export function verifySquirrelReleases({ releasesText, nupkgName, nupkgBytes }) {
  if (typeof releasesText !== 'string') throw new Error('RELEASES content must be text');
  if (
    typeof nupkgName !== 'string'
    || !nupkgName.endsWith('.nupkg')
    || nupkgName.includes('/')
    || nupkgName.includes('\\')
  ) {
    throw new Error('nupkgName must be one nupkg basename');
  }
  if (!Buffer.isBuffer(nupkgBytes) || nupkgBytes.length === 0) {
    throw new Error('nupkg bytes must be non-empty');
  }
  const lines = releasesText.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length !== 1) {
    throw new Error(`RELEASES must contain exactly one non-empty record, found ${lines.length}`);
  }
  const tokens = lines[0].trim().split(/\s+/u);
  if (tokens.length !== 3) throw new Error('RELEASES record must contain SHA-1, filename, and size');
  const [declaredSha1, declaredName, declaredSizeText] = tokens;
  if (!SHA1_PATTERN.test(declaredSha1)) throw new Error('RELEASES SHA-1 is invalid');
  if (declaredName !== nupkgName) throw new Error('RELEASES filename does not exactly match nupkg');
  if (!/^\d+$/u.test(declaredSizeText)) throw new Error('RELEASES size is invalid');
  const declaredSize = Number(declaredSizeText);
  if (!Number.isSafeInteger(declaredSize) || declaredSize !== nupkgBytes.length) {
    throw new Error('RELEASES size does not match nupkg bytes');
  }
  const actualSha1 = createHash('sha1').update(nupkgBytes).digest('hex');
  if (declaredSha1.toLowerCase() !== actualSha1) {
    throw new Error('RELEASES SHA-1 does not match nupkg bytes');
  }
  return { name: declaredName, size: declaredSize, sha1: actualSha1 };
}

function parseArguments(argv) {
  const allowed = new Set(['--releases', '--nupkg']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error('Invalid Squirrel RELEASES arguments');
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  for (const required of ['--releases', '--nupkg']) {
    if (!values[required]) throw new Error(`Missing required argument: ${required}`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const nupkgPath = path.resolve(args['--nupkg']);
  const result = verifySquirrelReleases({
    releasesText: await readFile(path.resolve(args['--releases']), 'utf8'),
    nupkgName: path.basename(nupkgPath),
    nupkgBytes: await readFile(nupkgPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
