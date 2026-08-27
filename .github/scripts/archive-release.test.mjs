import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertImmutableReleasePolicy,
  assertReleaseIdentity,
  getRelease,
  getReleaseById,
  verifyReleaseAttestation,
  verifyReleaseAssets,
} from './archive-release.mjs';

const manifest = {
  archive: {
    release: { tag: 'v1.2.3-beta.4', channel: 'beta' },
    release_infrastructure: { release_infrastructure_sha: 'a'.repeat(40) },
  },
};
const expected = [{ name: 'Flowzero.dmg', size: 100, sha256: 'b'.repeat(64) }];

test('archive publication requires the immutable state promised to operators', () => {
  assert.throws(() => assertImmutableReleasePolicy({ enabled: false }), /not enabled/u);
  assert.deepEqual(assertImmutableReleasePolicy({ enabled: true }), { enabled: true });
  const release = {
    tag_name: 'v1.2.3-beta.4',
    target_commitish: 'a'.repeat(40),
    prerelease: true,
    draft: false,
    immutable: false,
  };
  assert.throws(
    () => assertReleaseIdentity(release, manifest, { expectedDraft: false, expectedImmutable: true }),
    /immutable state mismatch/u,
  );
  assert.doesNotThrow(() => assertReleaseIdentity(
    { ...release, immutable: true },
    manifest,
    { expectedDraft: false, expectedImmutable: true },
  ));
});

test('archive assets must be uploaded and match their frozen size and digest', () => {
  const release = {
    assets: [{
      name: 'Flowzero.dmg',
      state: 'uploaded',
      size: 100,
      digest: `sha256:${'b'.repeat(64)}`,
    }],
  };
  assert.match(verifyReleaseAssets(release, expected), /^[a-f0-9]{64}$/u);
  assert.throws(
    () => verifyReleaseAssets({
      assets: [{ ...release.assets[0], state: 'new' }],
    }, expected),
    /not uploaded/u,
  );
});

test('archive resume finds an authenticated draft when the tag endpoint hides it', () => {
  const draft = { id: 42, tag_name: 'v1.2.3-beta.4', draft: true };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    tag_name: `v0.0.${index + 1}`,
    draft: false,
  }));
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    if (args[1].includes('/releases/tags/')) {
      return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    return { status: 0, stdout: JSON.stringify([firstPage, [draft]]), stderr: '' };
  };

  assert.deepEqual(getRelease('daymade/flowzero-releases', draft.tag_name, { runCommand }), draft);
  assert.deepEqual(calls[1], [
    'api', '--paginate', '--slurp', 'repos/daymade/flowzero-releases/releases?per_page=100',
  ]);
});

test('archive resume rejects duplicate drafts split across release pages', () => {
  const tag = 'v1.2.3-beta.4';
  const runCommand = (_command, args) => {
    if (args[1].includes('/releases/tags/')) {
      return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    return {
      status: 0,
      stdout: JSON.stringify([
        [{ id: 41, tag_name: tag, draft: true }],
        [{ id: 42, tag_name: tag, draft: true }],
      ]),
      stderr: '',
    };
  };

  assert.throws(
    () => getRelease('daymade/flowzero-releases', tag, { runCommand }),
    /multiple GitHub releases found/u,
  );
});

test('archive refreshes an existing draft by immutable release ID', () => {
  const draft = { id: 42, tag_name: 'v1.2.3-beta.4', draft: true };
  const runCommand = (_command, args) => {
    assert.equal(args[1], 'repos/daymade/flowzero-releases/releases/42');
    return { status: 0, stdout: JSON.stringify(draft), stderr: '' };
  };

  assert.deepEqual(getReleaseById('daymade/flowzero-releases', 42, { runCommand }), draft);
});

test('release attestation verification succeeds immediately without sleeping', async () => {
  const calls = [];
  const sleeps = [];
  const result = await verifyReleaseAttestation('daymade/flowzero-releases', 'v1.2.3-beta.4', {
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'verified\n', stderr: '' };
    },
    sleep: async (delayMs) => sleeps.push(delayMs),
    now: () => 0,
    writeStatus: () => {},
  });

  assert.deepEqual(result, { attempts: 1, elapsed_ms: 0 });
  assert.deepEqual(sleeps, []);
  assert.deepEqual(calls, [{
    command: 'gh',
    args: ['release', 'verify', 'v1.2.3-beta.4', '--repo', 'daymade/flowzero-releases'],
    options: { allowFailure: true },
  }]);
});

test('release attestation verification retries only the exact pending state', async () => {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  const results = [
    { status: 1, stdout: '', stderr: `no attestations for tag v1.2.3-beta.4 (sha1:${'a'.repeat(40)})` },
    { status: 1, stdout: '', stderr: `no attestations found for tag v1.2.3-beta.4 (sha1:${'a'.repeat(40)})` },
    { status: 0, stdout: 'verified\n', stderr: '' },
  ];
  const result = await verifyReleaseAttestation('daymade/flowzero-releases', 'v1.2.3-beta.4', {
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return results.shift();
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      clock += delayMs;
    },
    now: () => clock,
    retryDelaysMs: [2_000, 4_000, 8_000],
    writeStatus: () => {},
  });

  assert.deepEqual(result, { attempts: 3, elapsed_ms: 6_000 });
  assert.deepEqual(sleeps, [2_000, 4_000]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call, {
      command: 'gh',
      args: ['release', 'verify', 'v1.2.3-beta.4', '--repo', 'daymade/flowzero-releases'],
      options: { allowFailure: true },
    });
  }
});

test('both official release-attestation absence forms are retryable for the exact target', async (t) => {
  const pendingDetails = [
    `no attestations for tag v1.2.3-beta.4 (sha1:${'a'.repeat(40)})`,
    'no attestations found for release v1.2.3-beta.4 in daymade/flowzero-releases',
  ];
  for (const detail of pendingDetails) {
    await t.test(detail, async () => {
      let clock = 0;
      let calls = 0;
      const result = await verifyReleaseAttestation('daymade/flowzero-releases', 'v1.2.3-beta.4', {
        runCommand: () => {
          calls += 1;
          return calls === 1
            ? { status: 1, stdout: '', stderr: detail }
            : { status: 0, stdout: 'verified', stderr: '' };
        },
        sleep: async (delayMs) => { clock += delayMs; },
        now: () => clock,
        retryDelaysMs: [1],
        writeStatus: () => {},
      });
      assert.equal(result.attempts, 2);
    });
  }
});

test('release attestation verification fails immediately for terminal errors', async (t) => {
  const terminalDetails = [
    'HTTP 403: Resource not accessible by integration',
    'unexpected EOF',
    'duplicate attestations found',
    'error parsing attestation envelope',
    'failed to verify attestations',
    `no attestations for tag v9.9.9 (sha1:${'a'.repeat(40)})`,
    'no attestations found for release v1.2.3-beta.4 in other/repository',
  ];
  for (const detail of terminalDetails) {
    await t.test(detail, async () => {
      let calls = 0;
      let sleeps = 0;
      await assert.rejects(
        verifyReleaseAttestation('daymade/flowzero-releases', 'v1.2.3-beta.4', {
          runCommand: () => {
            calls += 1;
            return { status: 1, stdout: '', stderr: detail };
          },
          sleep: async () => { sleeps += 1; },
          now: () => 0,
          writeStatus: () => {},
        }),
        (error) => error.message.includes(detail),
      );
      assert.equal(calls, 1);
      assert.equal(sleeps, 0);
    });
  }
});

test('release attestation pending state times out within the fixed deadline', async () => {
  let clock = 0;
  let calls = 0;
  const sleeps = [];
  const pending = `no attestations for tag v1.2.3-beta.4 (sha1:${'a'.repeat(40)})`;

  await assert.rejects(
    verifyReleaseAttestation('daymade/flowzero-releases', 'v1.2.3-beta.4', {
      runCommand: () => {
        calls += 1;
        return { status: 1, stdout: '', stderr: pending };
      },
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        clock += delayMs;
      },
      now: () => clock,
      timeoutMs: 100,
      retryDelaysMs: [40],
      writeStatus: () => {},
    }),
    (error) => (
      /timed out/u.test(error.message)
      && /attempts=4 elapsed_ms=100/u.test(error.message)
      && error.message.includes(pending)
      && /rerun the failed archive-release job/u.test(error.message)
      && /without uploading or publishing again/u.test(error.message)
    ),
  );
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [40, 40, 20]);
});
