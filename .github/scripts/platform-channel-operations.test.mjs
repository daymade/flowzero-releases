import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main as initializeEmptyPlatformChannel } from './initialize-empty-platform-channel.mjs';
import {
  advanceCurrentPointerOnce,
  putImmutableJson,
  putCurrentJson,
} from './promote-platform-channel.mjs';
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

test('two promotion invocations perform exactly one current pointer write', () => {
  const targetManifest = {
    schema: 'flowzero.update_platform_manifest.v1',
    channel: 'beta',
    platform: 'windows-x64',
    state: 'published',
    tag: 'v0.1.3-beta.2',
    version: '0.1.3-beta.2',
    transaction_id: `sha256:${'a'.repeat(64)}`,
    checkpoint_id: `sha256:${'b'.repeat(64)}`,
    published_at: '2026-09-02T00:00:00.000Z',
    assets: [],
  };
  const targetBytes = Buffer.from(`${JSON.stringify(targetManifest)}\n`);
  const targetDigestHex = createHash('sha256').update(targetBytes).digest('hex');
  const targetDigestBase64 = createHash('sha256').update(targetBytes).digest('base64');
  let state = { head: null, manifest: null };
  let writes = 0;
  const invoke = () => advanceCurrentPointerOnce({
    before: state,
    targetManifest,
    targetBytes,
    targetDigestHex,
    targetDigestBase64,
    write: () => {
      writes += 1;
      state = {
        head: {
          ContentLength: targetBytes.length,
          Metadata: { sha256: targetDigestHex },
          ChecksumSHA256: targetDigestBase64,
        },
        bytes: targetBytes,
        body_sha256: targetDigestHex,
        manifest: targetManifest,
      };
      return { write_performed: true, recovered_after_lost_response: false };
    },
  });
  assert.equal(invoke().write_performed, true);
  assert.equal(invoke().write_performed, false);
  assert.equal(writes, 1);
});

test('lost current CAS response is closed by an independent exact readback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flowzero-current-cas-'));
  const filePath = path.join(root, 'current.json');
  const bytes = Buffer.from('{"state":"published"}\n');
  await writeFile(filePath, bytes);
  const digestHexValue = createHash('sha256').update(bytes).digest('hex');
  const digestBase64Value = createHash('sha256').update(bytes).digest('base64');
  let calls = 0;
  const result = putCurrentJson(
    { R2_BUCKET: 'test', R2_ENDPOINT: 'https://r2.example.test' },
    'channels/beta/platforms/windows-x64/current.json',
    filePath,
    digestHexValue,
    digestBase64Value,
    null,
    {
      run: () => {
        calls += 1;
        return { status: 1, stderr: 'connection reset after request body' };
      },
      readCurrent: () => ({
        head: {
          ContentLength: bytes.length,
          Metadata: { sha256: digestHexValue },
          ChecksumSHA256: digestBase64Value,
        },
        bytes,
        body_sha256: digestHexValue,
        manifest: { state: 'published' },
      }),
    },
  );
  assert.deepEqual(result, { write_performed: true, recovered_after_lost_response: true });
  assert.equal(calls, 1);
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
