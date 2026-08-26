import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main as initializeEmptyPlatformChannel } from './initialize-empty-platform-channel.mjs';
import { putImmutableJson } from './promote-platform-channel.mjs';
import {
  verifyChannelCanary,
  verifyChannelCanaryWithReceipt,
} from './verify-channel-canary.mjs';

const digestHex = 'a'.repeat(64);
const digestBase64 = Buffer.from(digestHex, 'hex').toString('base64');
const matchingHead = {
  ContentLength: 12,
  Metadata: { sha256: digestHex },
  ChecksumSHA256: digestBase64,
};

test('immutable small state is create-or-prove after a concurrent or partial write', () => {
  let reads = 0;
  const result = putImmutableJson({}, 'state.json', '/tmp/state.json', digestHex, digestBase64, 12, {
    r2Head: () => (reads++ === 0 ? null : matchingHead),
    run: () => ({ status: 1, stderr: 'precondition failed' }),
  });
  assert.equal(result, matchingHead);
  assert.throws(() => putImmutableJson({}, 'state.json', '/tmp/state.json', digestHex, digestBase64, 12, {
    r2Head: () => ({ ...matchingHead, Metadata: { sha256: 'b'.repeat(64) } }),
    run: () => ({ status: 0 }),
  }), /digest conflict/u);
});

test('empty initialization refuses a platform that already has published snapshots', () => {
  const env = {
    RUNNER_TEMP: '/tmp',
    R2_ENDPOINT: 'https://r2.example.test',
    R2_BUCKET: 'releases',
    R2_PUBLIC_BASE_URL: 'https://downloads.example.test',
  };
  assert.throws(() => initializeEmptyPlatformChannel([
    '--channel', 'beta',
    '--platform', 'macos-arm64',
    '--confirm-empty', 'true',
  ], env, {
    r2Head: () => null,
    run: () => ({ status: 0, stdout: JSON.stringify({ KeyCount: 1 }) }),
  }), /published platform snapshots/u);
});

test('no_release canary requires the user-facing platform route to return 204', async () => {
  const requests = [];
  const result = await verifyChannelCanary({
    channel: 'beta',
    platform: 'macos-arm64',
    state: 'no_release',
    fetchImplementation: async (url) => {
      requests.push(url);
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(result, { platform: 'macos-arm64', state: 'no_release' });
  assert.equal(requests.length, 1);
  await assert.rejects(verifyChannelCanary({
    channel: 'beta',
    platform: 'windows-x64',
    state: 'no_release',
    fetchImplementation: async () => new Response('still published', { status: 200 }),
  }), /HTTP 200/u);
});

test('canary writes a durable pass or fail receipt before returning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tinkle_flowzero-canary-'));
  const passPath = path.join(root, 'pass.json');
  await verifyChannelCanaryWithReceipt({
    channel: 'beta',
    platform: 'macos-arm64',
    state: 'no_release',
    output: passPath,
    checkedAt: '2026-08-26T00:00:00Z',
    fetchImplementation: async () => new Response(null, { status: 204 }),
  });
  const passed = JSON.parse(await readFile(passPath, 'utf8'));
  assert.equal(passed.status, 'pass');
  assert.equal(passed.evidence.state, 'no_release');

  const failPath = path.join(root, 'fail.json');
  await assert.rejects(verifyChannelCanaryWithReceipt({
    channel: 'beta',
    platform: 'windows-x64',
    state: 'no_release',
    output: failPath,
    checkedAt: '2026-08-26T00:00:01Z',
    fetchImplementation: async () => new Response('still published', { status: 200 }),
  }), /HTTP 200/u);
  const failed = JSON.parse(await readFile(failPath, 'utf8'));
  assert.equal(failed.status, 'fail');
  assert.match(failed.error, /HTTP 200/u);
});
