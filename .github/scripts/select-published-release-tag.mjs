#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectPublishedReleaseTag(releasePages, channel) {
  if (!['stable', 'beta'].includes(channel)) {
    throw new Error('Channel must be stable or beta');
  }
  if (!Array.isArray(releasePages) || releasePages.some((page) => !Array.isArray(page))) {
    throw new Error('Paginated releases must be an array of page arrays');
  }

  const expectedPrerelease = channel === 'beta';
  for (const page of releasePages) {
    for (const release of page) {
      if (!release || typeof release !== 'object' || Array.isArray(release)) {
        throw new Error('Release entry must be an object');
      }
      if (
        release.draft === false
        && release.prerelease === expectedPrerelease
      ) {
        if (typeof release.tag_name !== 'string' || !release.tag_name.trim()) {
          throw new Error('Published release tag_name must be a non-empty string');
        }
        return release.tag_name.trim();
      }
    }
  }
  return '';
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--releases-json', '--channel']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error('Invalid published release arguments');
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  for (const required of allowed) {
    if (!values[required]) throw new Error(`Missing required argument: ${required}`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const releasePages = JSON.parse(
    await readFile(path.resolve(args['--releases-json']), 'utf8'),
  );
  const tag = selectPublishedReleaseTag(releasePages, args['--channel']);
  process.stdout.write(`${tag}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
