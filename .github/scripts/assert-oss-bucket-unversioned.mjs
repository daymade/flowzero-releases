#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertOssBucketUnversioned(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OSS bucket versioning response must be a JSON object');
  }
  const status = payload.Status;
  if (status === undefined || status === null || status === '') return true;
  if (status === 'Enabled' || status === 'Suspended') {
    throw new Error(
      `OSS bucket versioning is ${status}; forbid-overwrite cannot protect immutable release keys`,
    );
  }
  throw new Error(`Unknown OSS bucket versioning status: ${String(status)}`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--input') {
    throw new Error('Usage: assert-oss-bucket-unversioned --input <versioning.json>');
  }
  const payload = JSON.parse(await readFile(path.resolve(argv[1]), 'utf8'));
  assertOssBucketUnversioned(payload);
  process.stdout.write('OSS bucket is unversioned\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
