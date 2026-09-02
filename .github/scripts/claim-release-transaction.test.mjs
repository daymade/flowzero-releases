import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTransactionOwnerClaim,
  claimReleaseTransaction,
  validateExistingTransactionOwner,
} from './claim-release-transaction.mjs';
import { buildReleaseTransaction, canonicalJson } from './release-transaction.mjs';

const sourceSha = 'a'.repeat(40);
const infraSha = 'b'.repeat(40);
function transaction(runId = '41') {
  const intent = {
    schema: 'flowzero.release_intent.v1',
    source: { repository: 'daymade/flowzero', head_sha: sourceSha },
    release: { version: '1.2.3-beta.4', tag: 'v1.2.3-beta.4', channel: 'beta', variant: 'standard' },
    requested_platforms: ['macos-arm64'],
    promotion_policy: { mode: 'platform_independent' },
    archive_policy: { mode: 'eventual_bundle', required_platforms: ['macos-arm64'] },
  };
  intent.transaction_id = `sha256:${createHash('sha256').update(canonicalJson(intent)).digest('hex')}`;
  return buildReleaseTransaction({
    intent,
    releaseInfrastructureSha: infraSha,
    workflowRunId: runId,
    workflowRunAttempt: 1,
    createdAt: '2026-08-26T16:00:00.000Z',
  });
}

function fakeEnvironment(root) {
  return {
    AWS_ACCESS_KEY_ID: 'test-access',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    R2_ENDPOINT: 'https://r2.example.test',
    R2_BUCKET: 'flowzero-releases',
    RUNNER_TEMP: root,
  };
}

function responseForBody(body) {
  return JSON.stringify({
    ContentLength: Buffer.byteLength(body),
    Metadata: { sha256: createHash('sha256').update(body).digest('hex') },
    ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
  });
}

function fakeR2(initial = new Map()) {
  const objects = new Map(initial);
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    const operation = args[1];
    const key = args[args.indexOf('--key') + 1];
    if (operation === 'head-object') {
      const body = objects.get(key);
      return body
        ? { status: 0, stdout: responseForBody(body), stderr: '' }
        : { status: 1, stdout: '', stderr: 'NotFound' };
    }
    if (operation === 'put-object') {
      if (objects.has(key)) return { status: 255, stdout: '', stderr: 'PreconditionFailed' };
      objects.set(key, readFileSync(args[args.indexOf('--body') + 1], 'utf8'));
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (operation === 'get-object') {
      const body = objects.get(key);
      if (!body) return { status: 1, stdout: '', stderr: 'NotFound' };
      const endpointIndex = args.indexOf('--endpoint-url');
      const destination = args.at(-1) === 'json' ? args[endpointIndex - 1] : args.at(-1);
      writeFileSync(destination, body);
      return { status: 0, stdout: responseForBody(body), stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  return { objects, calls, runCommand };
}

test('creates one durable R2 owner with a conditional write and verifies readback', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowzero-claim-test-'));
  const { calls, runCommand } = fakeR2();
  const result = claimReleaseTransaction(transaction('41'), {
    env: fakeEnvironment(root),
    runCommand,
  });
  assert.equal(result.isOwner, true);
  assert.equal(result.ownerRunId, '41');
  assert.equal(result.objectKey, 'release-control/releases/v1.2.3-beta.4/owner.json');
  assert.ok(calls.some((args) => args.includes('--if-none-match') && args.includes('*')));
});

test('same token and intent returns the original owner without a second side effect', () => {
  const firstClaim = buildTransactionOwnerClaim(transaction('41'));
  const existingBody = `${JSON.stringify(firstClaim)}\n`;
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowzero-claim-test-'));
  const ownerKey = 'release-control/releases/v1.2.3-beta.4/owner.json';
  const { runCommand } = fakeR2(new Map([[ownerKey, existingBody]]));
  const result = claimReleaseTransaction(transaction('42'), {
    env: fakeEnvironment(root),
    runCommand,
  });
  assert.equal(result.isOwner, false);
  assert.equal(result.ownerRunId, '41');
});

test('same transaction id with different semantic intent fails closed', () => {
  const current = buildTransactionOwnerClaim(transaction('41'));
  const conflicting = structuredClone(current);
  conflicting.intent.release.variant = 'offline';
  assert.throws(
    () => validateExistingTransactionOwner(conflicting, current),
    /different semantic intent/u,
  );
});
