import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertImmutableReleasePolicy,
  assertReleaseIdentity,
  getRelease,
  getReleaseById,
  run,
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

const releaseTag = 'v1.2.3-beta.4';
const releaseSubjectSha = 'a'.repeat(40);
const releaseRepository = 'daymade/flowzero-releases';
const releaseAttestationPath = `repos/${releaseRepository}/attestations/sha1:${releaseSubjectSha}?per_page=100&predicate_type=release`;
const githubAttestationResponse = JSON.stringify({
  attestations: [{ initiator: 'github', bundle_url: 'https://example.invalid/release-attestation' }],
});
const emptyAttestationResponse = JSON.stringify({ attestations: [] });

test('release attestation verification succeeds after a structured query without sleeping', async () => {
  const calls = [];
  const sleeps = [];
  const results = [
    { status: 0, stdout: githubAttestationResponse, stderr: '' },
    { status: 0, stdout: 'verified\n', stderr: '' },
  ];
  const result = await verifyReleaseAttestation(releaseRepository, releaseTag, {
    subjectSha: releaseSubjectSha,
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return results.shift();
    },
    sleep: async (delayMs) => sleeps.push(delayMs),
    now: () => 0,
    writeStatus: () => {},
  });

  assert.deepEqual(result, { attempts: 1, elapsed_ms: 0 });
  assert.deepEqual(sleeps, []);
  assert.deepEqual(calls, [
    {
      command: 'gh',
      args: ['api', releaseAttestationPath],
      options: { allowFailure: true, timeout: 120_000 },
    },
    {
      command: 'gh',
      args: ['release', 'verify', releaseTag, '--repo', releaseRepository],
      options: { allowFailure: true, timeout: 120_000 },
    },
  ]);
});

test('structured zero-attestation responses retry without upload or publication calls', async () => {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  const results = [
    { status: 0, stdout: emptyAttestationResponse, stderr: '' },
    { status: 0, stdout: emptyAttestationResponse, stderr: '' },
    { status: 0, stdout: githubAttestationResponse, stderr: '' },
    { status: 0, stdout: 'verified\n', stderr: '' },
  ];
  const result = await verifyReleaseAttestation(releaseRepository, releaseTag, {
    subjectSha: releaseSubjectSha,
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
  assert.deepEqual(calls.map(({ args }) => args), [
    ['api', releaseAttestationPath],
    ['api', releaseAttestationPath],
    ['api', releaseAttestationPath],
    ['release', 'verify', releaseTag, '--repo', releaseRepository],
  ]);
  assert.equal(calls.some(({ args }) => args.includes('upload') || args.includes('PATCH')), false);
});

test('an existing same-SHA attestation retries only the exact filtered-tag absence', async () => {
  let clock = 0;
  const sleeps = [];
  const results = [
    { status: 0, stdout: githubAttestationResponse, stderr: '' },
    { status: 1, stdout: '', stderr: `no attestations found for release ${releaseTag} in flowzero-releases` },
    { status: 0, stdout: githubAttestationResponse, stderr: '' },
    { status: 0, stdout: 'verified\n', stderr: '' },
  ];
  const result = await verifyReleaseAttestation(releaseRepository, releaseTag, {
    subjectSha: releaseSubjectSha,
    runCommand: () => results.shift(),
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      clock += delayMs;
    },
    now: () => clock,
    retryDelaysMs: [5],
    writeStatus: () => {},
  });
  assert.deepEqual(result, { attempts: 2, elapsed_ms: 5 });
  assert.deepEqual(sleeps, [5]);
});

test('structured attestation query errors fail immediately and preserve the original error', async (t) => {
  for (const detail of ['HTTP 403: Resource not accessible by integration', 'unexpected EOF']) {
    await t.test(detail, async () => {
      let calls = 0;
      let sleeps = 0;
      await assert.rejects(
        verifyReleaseAttestation(releaseRepository, releaseTag, {
          subjectSha: releaseSubjectSha,
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

test('malformed structured attestation responses fail instead of becoming pending', async () => {
  await assert.rejects(
    verifyReleaseAttestation(releaseRepository, releaseTag, {
      subjectSha: releaseSubjectSha,
      runCommand: () => ({ status: 0, stdout: '{}', stderr: '' }),
      now: () => 0,
      writeStatus: () => {},
    }),
    /attestation query is invalid/u,
  );
});

test('release verification terminal errors never retry after the API proves attestations exist', async (t) => {
  const terminalDetails = [
    `no attestations for tag ${releaseTag} (sha1:${releaseSubjectSha})`,
    `no attestations found for release ${releaseTag} in owner/flowzero-releases`,
    `no attestations found for release ${releaseTag} in flowzero-releases\nHTTP 403`,
    'duplicate attestations found',
    'error parsing attestation envelope',
    'failed to verify attestations',
  ];
  for (const detail of terminalDetails) {
    await t.test(detail, async () => {
      let calls = 0;
      let sleeps = 0;
      await assert.rejects(
        verifyReleaseAttestation(releaseRepository, releaseTag, {
          subjectSha: releaseSubjectSha,
          runCommand: () => {
            calls += 1;
            return calls === 1
              ? { status: 0, stdout: githubAttestationResponse, stderr: '' }
              : { status: 1, stdout: '', stderr: detail };
          },
          sleep: async () => { sleeps += 1; },
          now: () => 0,
          writeStatus: () => {},
        }),
        (error) => error.message.includes(detail),
      );
      assert.equal(calls, 2);
      assert.equal(sleeps, 0);
    });
  }
});

test('release attestation pending state times out within the fixed deadline', async () => {
  let clock = 0;
  let calls = 0;
  const sleeps = [];

  await assert.rejects(
    verifyReleaseAttestation(releaseRepository, releaseTag, {
      subjectSha: releaseSubjectSha,
      runCommand: () => {
        calls += 1;
        return { status: 0, stdout: emptyAttestationResponse, stderr: '' };
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
      && /attempts=3 elapsed_ms=100/u.test(error.message)
      && /zero github-initiated attestations/u.test(error.message)
      && /rerun the failed archive-release job/u.test(error.message)
      && /without uploading or publishing again/u.test(error.message)
    ),
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [40, 40, 20]);
});

test('a stuck gh child is hard-bounded by the command timeout', () => {
  const startedAt = Date.now();
  assert.throws(
    () => run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 25 }),
    (error) => error.code === 'ETIMEDOUT',
  );
  assert.ok(Date.now() - startedAt < 500);
});

test('a timed-out attestation query reports the resumable archive timeout', async () => {
  const timeoutError = Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  await assert.rejects(
    verifyReleaseAttestation(releaseRepository, releaseTag, {
      subjectSha: releaseSubjectSha,
      runCommand: () => { throw timeoutError; },
      now: () => 0,
      timeoutMs: 10,
      writeStatus: () => {},
    }),
    (error) => (
      /timed out/u.test(error.message)
      && error.message.includes(timeoutError.message)
      && /without uploading or publishing again/u.test(error.message)
    ),
  );
});
