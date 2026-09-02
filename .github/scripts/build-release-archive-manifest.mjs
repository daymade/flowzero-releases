#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  validateReleaseTransaction,
} from './release-transaction.mjs';
import {
  validateCandidateAgainstTransaction,
  validateCandidateEnvelope,
  validateVerificationSet,
} from './release-platform-checkpoint.mjs';
import {
  validateLegacyBridgeCompatibilityBinding,
  validateLegacyBridgeHold,
} from './windows-legacy-bridge-contract.mjs';

export const SCHEMA = 'flowzero.release_archive_manifest.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function buildReleaseArchiveManifest({ transaction, entries }) {
  transaction = validateReleaseTransaction(transaction);
  assert(Array.isArray(entries), 'archive entries must be an array');
  const byPlatform = new Map();
  for (const entry of entries) {
    const candidate = validateCandidateEnvelope(entry.candidate);
    const rawVerifications = entry.verifications
      ?? (entry.verification === undefined ? [] : [entry.verification]);
    const verifications = validateVerificationSet(rawVerifications, candidate);
    const platform = candidate.candidate.platform;
    assert(!byPlatform.has(platform), `duplicate archive platform: ${platform}`);
    validateCandidateAgainstTransaction(candidate, transaction);
    let windowsLegacyBridge = null;
    if (candidate.candidate.update?.windows_legacy_bridge !== undefined) {
      assert(entry.windowsLegacyBridge, 'archive Windows bridge evidence is missing');
      const hold = validateLegacyBridgeHold(entry.windowsLegacyBridge.hold);
      const binding = validateLegacyBridgeCompatibilityBinding(entry.windowsLegacyBridge.binding, {
        hold,
        targetCandidate: candidate,
      });
      windowsLegacyBridge = { binding, hold };
    } else {
      assert(entry.windowsLegacyBridge === undefined, 'archive contains unexpected Windows bridge evidence');
    }
    byPlatform.set(platform, { candidate, verifications, windowsLegacyBridge });
  }
  const requested = transaction.intent.requested_platforms;
  assert(
    requested.length === byPlatform.size && requested.every((platform) => byPlatform.has(platform)),
    'archive platforms do not exactly match the release intent',
  );
  const archive = {
    transaction_id: transaction.transaction_id,
    release_transaction: transaction,
    source: transaction.intent.source,
    release: transaction.intent.release,
    ...(transaction.intent.windows_signing_policy
      ? { windows_signing_policy: transaction.intent.windows_signing_policy }
      : {}),
    release_infrastructure: transaction.attempt,
    platforms: requested.map((platform) => {
      const entry = byPlatform.get(platform);
      return {
        platform,
        candidate: entry.candidate,
        verifications: entry.verifications,
        ...(entry.windowsLegacyBridge ? { windows_legacy_bridge: entry.windowsLegacyBridge } : {}),
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
  const releaseTransaction = archive.release_transaction === undefined
    ? null
    : validateReleaseTransaction(archive.release_transaction);
  if (releaseTransaction) {
    assert(releaseTransaction.transaction_id === archive.transaction_id, 'release archive transaction projection mismatch');
    assert(canonicalJson(releaseTransaction.intent.source) === canonicalJson(archive.source), 'release archive source projection mismatch');
    assert(canonicalJson(releaseTransaction.intent.release) === canonicalJson(archive.release), 'release archive release projection mismatch');
    assert(canonicalJson(releaseTransaction.attempt) === canonicalJson(archive.release_infrastructure), 'release archive infrastructure projection mismatch');
    assert(
      releaseTransaction.intent.windows_signing_policy === archive.windows_signing_policy,
      'release archive signing policy projection mismatch',
    );
  }
  const seen = new Set();
  let requiresReleaseTransaction = false;
  for (const entry of archive.platforms) {
    assert(!seen.has(entry.platform), `duplicate release archive platform: ${entry.platform}`);
    seen.add(entry.platform);
    const candidate = validateCandidateEnvelope(entry.candidate);
    if (candidate.candidate.verification_contract === 'windows_installer_v2') {
      requiresReleaseTransaction = true;
    }
    assert(candidate.candidate.platform === entry.platform, 'release archive platform/candidate mismatch');
    assert(candidate.candidate.transaction_id === archive.transaction_id, 'release archive candidate transaction mismatch');
    assert(canonicalJson(candidate.candidate.source) === canonicalJson(archive.source), 'release archive candidate source mismatch');
    assert(canonicalJson(candidate.candidate.release) === canonicalJson(archive.release), 'release archive candidate release mismatch');
    if (entry.platform === 'windows-x64') {
      assert(
        candidate.candidate.update?.windows_signing_policy === archive.windows_signing_policy,
        'release archive Windows signing policy mismatch',
      );
    }
    if (releaseTransaction) validateCandidateAgainstTransaction(candidate, releaseTransaction);
    const rawVerifications = entry.verifications
      ?? (entry.verification === undefined ? [] : [entry.verification]);
    assert(
      !(entry.verifications !== undefined && entry.verification !== undefined),
      'release archive verification projection is ambiguous',
    );
    validateVerificationSet(rawVerifications, candidate);
    if (candidate.candidate.update?.windows_legacy_bridge !== undefined) {
      assert(entry.windows_legacy_bridge, 'release archive Windows bridge evidence is missing');
      const hold = validateLegacyBridgeHold(entry.windows_legacy_bridge.hold);
      validateLegacyBridgeCompatibilityBinding(entry.windows_legacy_bridge.binding, {
        hold,
        targetCandidate: candidate,
      });
    } else {
      assert(entry.windows_legacy_bridge === undefined, 'release archive contains unexpected Windows bridge evidence');
    }
  }
  assert(!requiresReleaseTransaction || releaseTransaction !== null, 'Windows v2 release archive is missing its immutable release transaction');
  if (releaseTransaction) {
    assert(
      canonicalJson(releaseTransaction.intent.requested_platforms) === canonicalJson([...seen]),
      'release archive platform projection mismatch',
    );
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
    verifications: [JSON.parse(await readFile(path.resolve(args.verifications[index]), 'utf8'))],
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
