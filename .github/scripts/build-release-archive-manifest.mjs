#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';
import {
  validateCandidateEnvelope,
  validateVerificationReceipt,
} from './release-platform-checkpoint.mjs';

export const SCHEMA = 'flowzero.release_archive_manifest.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function buildReleaseArchiveManifest({ transaction, entries }) {
  assert(transaction?.schema === 'flowzero.release_transaction.v1', 'release transaction schema is invalid');
  assert(Array.isArray(entries), 'archive entries must be an array');
  const byPlatform = new Map();
  for (const entry of entries) {
    const candidate = validateCandidateEnvelope(entry.candidate);
    const verification = validateVerificationReceipt(entry.verification, candidate);
    const platform = candidate.candidate.platform;
    assert(!byPlatform.has(platform), `duplicate archive platform: ${platform}`);
    assert(candidate.candidate.transaction_id === transaction.transaction_id, 'archive candidate transaction mismatch');
    byPlatform.set(platform, { candidate, verification });
  }
  const requested = transaction.intent.requested_platforms;
  assert(
    requested.length === byPlatform.size && requested.every((platform) => byPlatform.has(platform)),
    'archive platforms do not exactly match the release intent',
  );
  const archive = {
    transaction_id: transaction.transaction_id,
    source: transaction.intent.source,
    release: transaction.intent.release,
    release_infrastructure: transaction.attempt,
    platforms: requested.map((platform) => {
      const entry = byPlatform.get(platform);
      return {
        platform,
        candidate: entry.candidate,
        verification: entry.verification,
      };
    }),
  };
  return {
    schema: SCHEMA,
    archive_id: `sha256:${createHash('sha256').update(canonicalJson(archive)).digest('hex')}`,
    archive,
  };
}

export function validateReleaseArchiveManifest(manifest) {
  assert(manifest?.schema === SCHEMA, 'release archive manifest schema is invalid');
  const archive = manifest.archive;
  assert(archive && typeof archive === 'object' && !Array.isArray(archive), 'release archive payload is missing');
  const expectedId = `sha256:${createHash('sha256').update(canonicalJson(archive)).digest('hex')}`;
  assert(manifest.archive_id === expectedId, 'release archive content hash is invalid');
  assert(/^sha256:[a-f0-9]{64}$/.test(archive.transaction_id || ''), 'release archive transaction id is invalid');
  assert(/^[a-f0-9]{40}$/.test(archive.source?.head_sha || ''), 'release archive source SHA is invalid');
  assert(Array.isArray(archive.platforms) && archive.platforms.length > 0, 'release archive platforms are missing');
  const seen = new Set();
  for (const entry of archive.platforms) {
    assert(!seen.has(entry.platform), `duplicate release archive platform: ${entry.platform}`);
    seen.add(entry.platform);
    const candidate = validateCandidateEnvelope(entry.candidate);
    assert(candidate.candidate.platform === entry.platform, 'release archive platform/candidate mismatch');
    assert(candidate.candidate.transaction_id === archive.transaction_id, 'release archive candidate transaction mismatch');
    assert(canonicalJson(candidate.candidate.source) === canonicalJson(archive.source), 'release archive candidate source mismatch');
    assert(canonicalJson(candidate.candidate.release) === canonicalJson(archive.release), 'release archive candidate release mismatch');
    validateVerificationReceipt(entry.verification, candidate);
  }
  return JSON.parse(JSON.stringify(manifest));
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

function parseArguments(argv) {
  const values = { candidates: [], verifications: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${key || '<empty>'} requires a value`);
    if (key === '--candidate') values.candidates.push(value);
    else if (key === '--verification') values.verifications.push(value);
    else if (key === '--transaction' || key === '--output') values[key] = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  assert(values['--transaction'], 'missing --transaction');
  assert(values['--output'], 'missing --output');
  assert(values.candidates.length === values.verifications.length, 'candidate/verification counts differ');
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const transaction = JSON.parse(await readFile(path.resolve(args['--transaction']), 'utf8'));
  const entries = await Promise.all(args.candidates.map(async (candidatePath, index) => ({
    candidate: JSON.parse(await readFile(path.resolve(candidatePath), 'utf8')),
    verification: JSON.parse(await readFile(path.resolve(args.verifications[index]), 'utf8')),
  })));
  const result = buildReleaseArchiveManifest({ transaction, entries });
  await atomicWriteJson(args['--output'], result);
  process.stdout.write(`${result.archive_id}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
