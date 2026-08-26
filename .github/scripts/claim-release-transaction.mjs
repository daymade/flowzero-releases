#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  TRANSACTION_SCHEMA,
  canonicalJson,
  validateReleaseIntent,
} from './release-transaction.mjs';

export const TRANSACTION_OWNER_SCHEMA = 'flowzero.release_transaction_owner.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(['--transaction', '--github-output'].includes(key) && value, `invalid argument: ${key || '<missing>'}`);
    values[key] = value;
  }
  assert(values['--transaction'], '--transaction is required');
  assert(values['--github-output'], '--github-output is required');
  return values;
}

function requiredEnvironment(env) {
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'RUNNER_TEMP',
  ]) {
    assert(typeof env[name] === 'string' && env[name].trim(), `missing transaction claim configuration: ${name}`);
  }
  return env;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateTransaction(transaction) {
  assert(transaction?.schema === TRANSACTION_SCHEMA, 'release transaction schema is invalid');
  const intent = validateReleaseIntent(transaction.intent);
  assert(transaction.transaction_id === intent.transaction_id, 'release transaction identity mismatch');
  assert(/^\d+$/.test(String(transaction.attempt?.workflow_run_id || '')), 'release transaction owner run id is invalid');
  assert(Number.isSafeInteger(transaction.attempt?.workflow_run_attempt) && transaction.attempt.workflow_run_attempt > 0, 'release transaction owner run attempt is invalid');
  assert(/^[a-f0-9]{40}$/.test(transaction.attempt?.release_infrastructure_sha || ''), 'release transaction infrastructure SHA is invalid');
  assert(!Number.isNaN(Date.parse(transaction.created_at)), 'release transaction creation time is invalid');
  return { ...transaction, intent };
}

export function buildTransactionOwnerClaim(transaction) {
  const validated = validateTransaction(transaction);
  return {
    schema: TRANSACTION_OWNER_SCHEMA,
    transaction_id: validated.transaction_id,
    intent: validated.intent,
    owner: {
      workflow_run_id: validated.attempt.workflow_run_id,
      workflow_run_attempt: validated.attempt.workflow_run_attempt,
      release_infrastructure_sha: validated.attempt.release_infrastructure_sha,
    },
    claimed_at: validated.created_at,
  };
}

export function validateExistingTransactionOwner(existing, currentClaim) {
  assert(existing?.schema === TRANSACTION_OWNER_SCHEMA, 'existing release transaction owner schema is invalid');
  assert(existing.transaction_id === currentClaim.transaction_id, 'existing release transaction owner id mismatch');
  assert(
    canonicalJson(existing.intent) === canonicalJson(currentClaim.intent),
    'same release transaction id has different semantic intent',
  );
  assert(/^\d+$/.test(String(existing.owner?.workflow_run_id || '')), 'existing release transaction owner run id is invalid');
  assert(Number.isSafeInteger(existing.owner?.workflow_run_attempt) && existing.owner.workflow_run_attempt > 0, 'existing release transaction owner attempt is invalid');
  assert(/^[a-f0-9]{40}$/.test(existing.owner?.release_infrastructure_sha || ''), 'existing release transaction owner infrastructure SHA is invalid');
  assert(!Number.isNaN(Date.parse(existing.claimed_at)), 'existing release transaction owner time is invalid');
  return existing;
}

function sha256(value, encoding = 'hex') {
  return createHash('sha256').update(value).digest(encoding);
}

function r2Args(env, args) {
  return [
    's3api',
    ...args,
    '--endpoint-url', env.R2_ENDPOINT,
    '--output', 'json',
  ];
}

function readExistingClaim(env, objectKey, destinationPath, runCommand = run) {
  const result = runCommand('aws', r2Args(env, [
    'get-object',
    '--bucket', env.R2_BUCKET,
    '--key', objectKey,
    '--checksum-mode', 'ENABLED',
    destinationPath,
  ]), { allowFailure: true, env });
  if (result.status !== 0) return null;
  return {
    body: readFileSync(destinationPath, 'utf8'),
    response: parseJson(result.stdout || '{}', 'R2 get-object response'),
  };
}

function assertStoredClaimEvidence(stored, expectedBody) {
  const expectedHex = sha256(expectedBody);
  const expectedBase64 = sha256(expectedBody, 'base64');
  assert(stored.response?.Metadata?.sha256 === expectedHex, 'R2 transaction owner SHA-256 metadata mismatch');
  assert(stored.response?.ChecksumSHA256 === expectedBase64, 'R2 transaction owner server checksum mismatch');
  assert(Number(stored.response?.ContentLength) === Buffer.byteLength(expectedBody), 'R2 transaction owner size mismatch');
}

export function claimReleaseTransaction(transaction, {
  env = process.env,
  runCommand = run,
} = {}) {
  const config = requiredEnvironment(env);
  const claim = buildTransactionOwnerClaim(transaction);
  const transactionHex = claim.transaction_id.slice('sha256:'.length);
  const objectKey = `release-control/releases/${claim.intent.release.tag}/owner.json`;
  const claimBody = `${canonicalJson(claim)}\n`;
  const claimPath = path.join(config.RUNNER_TEMP, `flowzero-release-owner-${transactionHex}.json`);
  const existingPath = path.join(config.RUNNER_TEMP, `flowzero-release-owner-existing-${transactionHex}.json`);
  writeFileSync(claimPath, claimBody, { encoding: 'utf8', mode: 0o600 });
  const claimSha256Hex = sha256(claimBody);
  const claimSha256Base64 = sha256(claimBody, 'base64');

  const putResult = runCommand('aws', r2Args(config, [
    'put-object',
    '--bucket', config.R2_BUCKET,
    '--key', objectKey,
    '--body', claimPath,
    '--content-type', 'application/json',
    '--cache-control', 'no-store',
    '--metadata', `sha256=${claimSha256Hex}`,
    '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', claimSha256Base64,
    '--if-none-match', '*',
  ]), { allowFailure: true, env: config });

  if (putResult.status === 0) {
    const stored = readExistingClaim(config, objectKey, existingPath, runCommand);
    assert(stored, 'R2 transaction owner was not readable after create-only write');
    assert(stored.body === claimBody, 'R2 transaction owner changed after create-only write');
    assertStoredClaimEvidence(stored, claimBody);
    return {
      isOwner: true,
      ownerRunId: claim.owner.workflow_run_id,
      objectKey,
      claim,
    };
  }

  const stored = readExistingClaim(config, objectKey, existingPath, runCommand);
  if (!stored) {
    throw new Error(`R2 transaction owner create-only write failed without an existing owner: ${(putResult.stderr || putResult.stdout || '').trim()}`);
  }
  const existing = validateExistingTransactionOwner(parseJson(stored.body, 'existing R2 transaction owner'), claim);
  assertStoredClaimEvidence(stored, stored.body);
  return {
    isOwner: existing.owner.workflow_run_id === claim.owner.workflow_run_id,
    ownerRunId: existing.owner.workflow_run_id,
    objectKey,
    claim: existing,
  };
}

function writeOutputs(outputPath, result) {
  appendFileSync(outputPath, [
    `is_owner=${result.isOwner ? 'true' : 'false'}`,
    `owner_run_id=${result.ownerRunId}`,
    `owner_object_key=${result.objectKey}`,
    '',
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const transaction = parseJson(readFileSync(path.resolve(args['--transaction']), 'utf8'), 'release transaction');
  const result = claimReleaseTransaction(transaction);
  writeOutputs(path.resolve(args['--github-output']), result);
  process.stdout.write(`${JSON.stringify({
    is_owner: result.isOwner,
    owner_run_id: result.ownerRunId,
    owner_object_key: result.objectKey,
  })}\n`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release transaction claim failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
