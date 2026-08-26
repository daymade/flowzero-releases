import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildManualReleaseIntent,
  buildReleaseTransaction,
  canonicalJson,
  releaseIntentFromEvent,
  validateReleaseIntent,
} from './release-transaction.mjs';
import {
  buildPlatformCheckpoint,
} from './release-platform-checkpoint.mjs';
import { splitLegacyManifest } from './split-legacy-channel-manifest.mjs';
import {
  buildReleaseArchiveManifest,
  validateReleaseArchiveManifest,
} from './build-release-archive-manifest.mjs';
import {
  buildPlatformChannelManifest,
} from './generate-platform-channel-manifest.mjs';
import { buildOssPutObjectArgs } from './mirror-release-assets.mjs';
import { validatePlatformArtifactRecovery } from './validate-platform-artifact-recovery.mjs';
import { assertRecoveryToolkitOnMain } from './assert-recovery-toolkit-on-main.mjs';

const contentId = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const sha = character => character.repeat(64);
const sourceSha = 'a'.repeat(40);
const infraSha = 'b'.repeat(40);

function intent(overrides = {}) {
  const identity = {
    schema: 'flowzero.release_intent.v1',
    source: { repository: 'daymade/flowzero', head_sha: sourceSha },
    release: {
      version: '1.2.3-beta.4',
      tag: 'v1.2.3-beta.4',
      channel: 'beta',
      variant: 'standard',
    },
    requested_platforms: ['macos-arm64', 'windows-x64'],
    promotion_policy: { mode: 'platform_independent' },
    archive_policy: {
      mode: 'eventual_bundle',
      required_platforms: ['macos-arm64', 'windows-x64'],
    },
    ...overrides,
  };
  return { ...identity, transaction_id: contentId(identity) };
}

function macCandidate(releaseIntent, { verificationContract } = {}) {
  const candidate = {
    transaction_id: releaseIntent.transaction_id,
    platform: 'macos-arm64',
    ...(verificationContract ? { verification_contract: verificationContract } : {}),
    source: releaseIntent.source,
    release: releaseIntent.release,
    attempt: {
      release_infrastructure_sha: infraSha,
      workflow_run_id: '123',
      workflow_run_attempt: 1,
    },
    assets: [
      {
        role: 'macos_dmg',
        name: 'Flowzero.dmg',
        content_type: 'application/x-apple-diskimage',
        size: 300,
        sha256: sha('1'),
      },
      {
        role: 'macos_updater_zip',
        name: 'Flowzero.zip',
        content_type: 'application/zip',
        size: 200,
        sha256: sha('2'),
        sha512: Buffer.alloc(64, 2).toString('base64'),
      },
      {
        role: 'macos_update_integrity',
        name: 'mac-update-integrity.json',
        content_type: 'application/json',
        size: 100,
        sha256: sha('3'),
      },
    ],
    update: {
      mac_update_integrity: {
        schema: 'flowzero.macos_update_integrity.v1',
        version: '1.2.3-beta.4',
        file: {
          name: 'Flowzero.zip',
          size: 200,
          sha256: sha('2'),
          sha512: Buffer.alloc(64, 2).toString('base64'),
        },
        dmg: { name: 'Flowzero.dmg', size: 300, sha256: sha('1') },
      },
    },
  };
  return {
    schema: 'flowzero.release_platform_candidate.v1',
    candidate_id: contentId(candidate),
    candidate,
  };
}

function macVerification(candidate) {
  return {
    schema: 'flowzero.release_verification.v1',
    status: 'pass',
    suite: 'macos-voice-context',
    version: candidate.candidate.release.version,
    source_head_sha: candidate.candidate.source.head_sha,
    platform: 'macos-arm64',
    subject: { name: 'Flowzero.dmg', size: 300, sha256: sha('1') },
    evidence: [
      { kind: 'macos_structure', status: 'pass' },
      {
        kind: 'packaged_pyannote_mps',
        status: 'pass',
        device: 'mps',
        cpu_inference_allowed: false,
      },
      {
        kind: 'packaged_local_multi_speaker_context',
        status: 'pass',
        speaker_count: 2,
        history_turn_count: 2,
        history_written: true,
        memory_written: true,
        fts_searchable: true,
        zero_process_residue: true,
        ambient_user_python_required: false,
        ambient_huggingface_token_required: false,
      },
    ],
    verified_at: '2026-08-26T00:00:00Z',
  };
}

function macLiveVerification(candidate, overrides = {}) {
  return {
    schema: 'flowzero.release_verification.v1',
    status: 'pass',
    suite: 'macos-live-stepfun-timeline',
    version: candidate.candidate.release.version,
    source_head_sha: candidate.candidate.source.head_sha,
    platform: 'macos-arm64',
    subject: { name: 'Flowzero.dmg', size: 300, sha256: sha('1') },
    evidence: [
      { kind: 'macos_structure', status: 'pass' },
      {
        kind: 'packaged_live_stepfun_timeline',
        status: 'pass',
        provider: 'stepfun',
        model: 'stepaudio-2.5-asr',
        transport: 'https_sse',
        http_status: 200,
        request_id_present: true,
        timeline_origin: 'stepfun_timestamped_delta',
        timeline_segment_count: 3,
        timeline_duration_ms: 15534,
        transcription_source: 'stepfun_sse',
        mock_inputs_present: false,
        runtime: 'pyannote_community1_mps',
        device: 'mps',
        cpu_inference_allowed: false,
        speaker_count: 2,
        history_turn_count: 2,
        history_written: true,
        memory_written: true,
        fts_searchable: true,
        zero_process_residue: true,
        ...overrides,
      },
    ],
    verified_at: '2026-08-26T00:00:00Z',
  };
}

function windowsCandidate(releaseIntent) {
  const nupkgName = 'Flowzero-1.2.3-beta4-full.nupkg';
  const candidate = {
    transaction_id: releaseIntent.transaction_id,
    platform: 'windows-x64',
    source: releaseIntent.source,
    release: releaseIntent.release,
    attempt: {
      release_infrastructure_sha: infraSha,
      workflow_run_id: '123',
      workflow_run_attempt: 1,
    },
    assets: [
      {
        role: 'windows_setup',
        name: 'Flowzero-1.2.3-beta.4-Setup.exe',
        content_type: 'application/vnd.microsoft.portable-executable',
        size: 300,
        sha256: sha('4'),
      },
      {
        role: 'windows_nupkg',
        name: nupkgName,
        content_type: 'application/octet-stream',
        size: 200,
        sha256: sha('5'),
        sha1: 'd'.repeat(40),
      },
      {
        role: 'windows_releases',
        name: 'RELEASES',
        content_type: 'application/octet-stream',
        size: 100,
        sha256: sha('6'),
      },
    ],
    update: {
      squirrel_releases: `${'d'.repeat(40)} ${nupkgName} 200\n`,
    },
  };
  return {
    schema: 'flowzero.release_platform_candidate.v1',
    candidate_id: contentId(candidate),
    candidate,
  };
}

function windowsVerification(candidate) {
  const setup = candidate.candidate.assets.find((asset) => asset.role === 'windows_setup');
  return {
    schema: 'flowzero.release_verification.v1',
    status: 'pass',
    suite: 'windows-installer',
    version: candidate.candidate.release.version,
    source_head_sha: candidate.candidate.source.head_sha,
    platform: 'windows-x64',
    subject: { name: setup.name, size: setup.size, sha256: setup.sha256 },
    evidence: [
      { kind: 'windows_authenticode', status: 'pass', timestamp_present: true },
      { kind: 'windows_installer', status: 'pass' },
    ],
    verified_at: '2026-08-26T00:00:00Z',
  };
}

function mirrorReceipt(candidate) {
  return {
    schema: 'flowzero.release_mirror_receipt.v1',
    candidate_id: candidate.candidate_id,
    transaction_id: candidate.candidate.transaction_id,
    platform: candidate.candidate.platform,
    mirrored_at: '2026-08-26T00:00:00Z',
    origins: [
      {
        origin: 'r2',
        objects: candidate.candidate.assets.map(({ name, size, sha256 }) => ({
          name,
          key: `releases/${candidate.candidate.release.tag}/${name}`,
          size,
          sha256,
          server_checksum: `sha256:${Buffer.from(sha256, 'hex').toString('base64')}`,
          etag: `"${sha256.slice(0, 32)}"`,
          public_head: true,
          public_range: true,
        })),
      },
      {
        origin: 'oss',
        objects: candidate.candidate.assets.map(({ name, size, sha256 }, index) => {
          const md5 = String(index + 1).repeat(32);
          return {
            name,
            key: `releases/${candidate.candidate.release.tag}/${name}`,
            size,
            sha256,
            server_checksum: `md5:${md5}`,
            etag: `"${md5}"`,
            public_head: true,
            public_range: true,
          };
        }),
      },
    ],
  };
}

test('validates the same content-addressed intent emitted by the source repository', () => {
  const releaseIntent = intent();
  assert.deepEqual(validateReleaseIntent(releaseIntent), releaseIntent);
  const transaction = buildReleaseTransaction({
    intent: releaseIntent,
    releaseInfrastructureSha: infraSha,
    workflowRunId: '123',
    workflowRunAttempt: 1,
    createdAt: '2026-08-26T00:00:00Z',
  });
  assert.equal(transaction.transaction_id, releaseIntent.transaction_id);
  assert.equal(transaction.attempt.release_infrastructure_sha, infraSha);
  assert.throws(
    () => validateReleaseIntent({ ...releaseIntent, transaction_id: `sha256:${sha('9')}` }),
    /transaction id/,
  );
});

test('binds mirror recovery to one accepted artifact pair and the requested source run', () => {
  const candidate = macCandidate(intent());
  const recovery = validatePlatformArtifactRecovery({
    candidate,
    verifications: [macVerification(candidate)],
    sourceRunId: '123',
    candidateArtifactId: '456',
    verificationArtifactId: '789',
    toolkitSha: 'c'.repeat(40),
    channel: 'beta',
    platform: 'macos-arm64',
  });
  assert.equal(recovery.candidate_id, candidate.candidate_id);
  assert.equal(recovery.version, '1.2.3-beta.4');
  assert.equal(recovery.original_release_infrastructure_sha, infraSha);

  const v2Candidate = macCandidate(intent(), {
    verificationContract: 'macos_voice_context_v2'
  });
  const v2Recovery = validatePlatformArtifactRecovery({
    candidate: v2Candidate,
    verifications: [macVerification(v2Candidate), macLiveVerification(v2Candidate)],
    sourceRunId: '123',
    candidateArtifactId: '456',
    verificationArtifactId: '789',
    toolkitSha: 'c'.repeat(40),
    channel: 'beta',
    platform: 'macos-arm64',
  });
  assert.deepEqual(v2Recovery.verification_suites, [
    'macos-voice-context',
    'macos-live-stepfun-timeline',
  ]);
  assert.throws(() => validatePlatformArtifactRecovery({
    candidate: v2Candidate,
    verifications: [macVerification(v2Candidate)],
    sourceRunId: '123',
    candidateArtifactId: '456',
    verificationArtifactId: '789',
    toolkitSha: 'c'.repeat(40),
    channel: 'beta',
    platform: 'macos-arm64',
  }), /requires 2 release verification/u);

  for (const overrides of [
    { sourceRunId: '124' },
    { channel: 'stable' },
    { platform: 'windows-x64' },
  ]) {
    assert.throws(() => validatePlatformArtifactRecovery({
      candidate,
      verifications: [macVerification(candidate)],
      sourceRunId: '123',
      candidateArtifactId: '456',
      verificationArtifactId: '789',
      toolkitSha: 'c'.repeat(40),
      channel: 'beta',
      platform: 'macos-arm64',
      ...overrides,
    }), /does not match|requested source run/u);
  }
});

test('accepts only a recovery toolkit commit already contained in trusted main', () => {
  const calls = [];
  const accepted = assertRecoveryToolkitOnMain({
    toolkitSha: 'c'.repeat(40),
    mainSha: 'd'.repeat(40),
    runGit: (args) => {
      calls.push(args);
      return { status: 0, stderr: '' };
    },
  });
  assert.equal(accepted.toolkit_sha, 'c'.repeat(40));
  assert.deepEqual(calls, [
    ['cat-file', '-e', `${'c'.repeat(40)}^{commit}`],
    ['merge-base', '--is-ancestor', 'c'.repeat(40), 'd'.repeat(40)],
  ]);
  assert.throws(() => assertRecoveryToolkitOnMain({
    toolkitSha: 'c'.repeat(40),
    mainSha: 'd'.repeat(40),
    runGit: (args) => ({ status: args[0] === 'cat-file' ? 0 : 1, stderr: '' }),
  }), /not an ancestor/u);
});

test('uses only ossutil 2.3.0 put-object flags and keeps post-write MD5 proof', () => {
  const args = buildOssPutObjectArgs({
    ALIYUN_OSS_ACCESS_KEY_ID: 'id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com',
    ALIYUN_OSS_REGION: 'cn-beijing',
    ALIYUN_OSS_BUCKET: 'bucket',
  }, {
    filePath: '/tmp/candidate.dmg',
    content_type: 'application/x-apple-diskimage',
    sha256: sha('7'),
  }, 'releases/v1.2.3/candidate.dmg');

  assert.deepEqual(args.slice(0, 2), ['api', 'put-object']);
  assert.equal(args.includes('--content-md5'), false);
  for (const flag of [
    '--bucket', '--key', '--body', '--content-type', '--cache-control',
    '--metadata', '--forbid-overwrite',
  ]) {
    assert.equal(args.includes(flag), true, `missing OSS upload flag: ${flag}`);
  }
});

test('restores a manual Actions entry without weakening immutable source identity', () => {
  const manual = buildManualReleaseIntent({
    version: '1.2.3-beta.4',
    headSha: sourceSha,
    platforms: 'all',
    variant: 'standard',
  });
  assert.deepEqual(manual.requested_platforms, ['macos-arm64', 'windows-x64']);
  assert.deepEqual(validateReleaseIntent(manual), manual);
  assert.deepEqual(releaseIntentFromEvent({
    ref: 'refs/heads/main',
    inputs: {
      version: '1.2.3-beta.4',
      head_sha: sourceSha,
      transaction_id: manual.transaction_id,
      platforms: 'all',
      variant: 'standard',
    },
  }), manual);
  assert.throws(
    () => releaseIntentFromEvent({
      ref: 'refs/heads/feature',
      inputs: {
        version: '1.2.3-beta.4',
        head_sha: sourceSha,
        transaction_id: manual.transaction_id,
        platforms: 'all',
        variant: 'standard',
      },
    }),
    /infrastructure ref must be main/u,
  );
  assert.throws(
    () => releaseIntentFromEvent({
      ref: 'refs/heads/main',
      inputs: {
        version: '1.2.3-beta.4',
        head_sha: sourceSha,
        transaction_id: `sha256:${'0'.repeat(64)}`,
        platforms: 'all',
        variant: 'standard',
      },
    }),
    /transaction ID mismatch/u,
  );
});

test('archives the full candidate and verification contract for durable repair', () => {
  const releaseIntent = intent({ requested_platforms: ['macos-arm64'], archive_policy: {
    mode: 'eventual_bundle',
    required_platforms: ['macos-arm64'],
  } });
  const transaction = buildReleaseTransaction({
    intent: releaseIntent,
    releaseInfrastructureSha: infraSha,
    workflowRunId: '123',
    workflowRunAttempt: 1,
    createdAt: '2026-08-26T00:00:00Z',
  });
  const candidate = macCandidate(releaseIntent);
  const archive = buildReleaseArchiveManifest({
    transaction,
    entries: [{ candidate, verification: macVerification(candidate) }],
  });
  assert.equal(
    validateReleaseArchiveManifest(archive).archive.platforms[0].candidate.candidate_id,
    candidate.candidate_id,
  );
  const tampered = structuredClone(archive);
  tampered.archive.platforms[0].verification.evidence = [];
  tampered.archive_id = contentId(tampered.archive);
  assert.throws(() => validateReleaseArchiveManifest(tampered), /verification/u);
});

test('rejects non-canonical tags at intent and candidate ingress', () => {
  for (const [version, tag] of [
    ['01.2.3', 'v01.2.3'],
    ['1.2.3-rc.1', 'v1.2.3-rc.1'],
    ['1.2.3-beta.01', 'v1.2.3-beta.01'],
  ]) {
    const base = intent();
    const identity = {
      ...base,
      release: { ...base.release, version, tag, channel: version.includes('-') ? 'beta' : 'stable' },
    };
    delete identity.transaction_id;
    const malformed = { ...identity, transaction_id: contentId(identity) };
    assert.throws(() => validateReleaseIntent(malformed), /canonical/u);
    assert.throws(
      () => buildPlatformCheckpoint({ phase: 'build_created', candidate: macCandidate(malformed) }),
      /canonical/u,
    );
  }
});

test('rejects candidates whose updater metadata is missing or detached from assets', () => {
  const withoutUpdate = macCandidate(intent());
  delete withoutUpdate.candidate.update;
  withoutUpdate.candidate_id = contentId(withoutUpdate.candidate);
  assert.throws(
    () => buildPlatformCheckpoint({ phase: 'build_created', candidate: withoutUpdate }),
    /update metadata/u,
  );

  const wrongSha512 = macCandidate(intent());
  wrongSha512.candidate.update.mac_update_integrity.file.sha512 = Buffer.alloc(64, 9).toString('base64');
  wrongSha512.candidate_id = contentId(wrongSha512.candidate);
  assert.throws(
    () => buildPlatformCheckpoint({ phase: 'build_created', candidate: wrongSha512 }),
    /update metadata/u,
  );
});

test('advances macOS independently through build, business verification, mirror, and channel manifest', () => {
  const candidate = macCandidate(intent());
  const built = buildPlatformCheckpoint({
    phase: 'build_created',
    candidate,
    createdAt: '2026-08-26T00:00:01Z',
  });
  const verified = buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [macVerification(candidate)],
    createdAt: '2026-08-26T00:00:02Z',
  });
  const mirrored = buildPlatformCheckpoint({
    phase: 'mirrored',
    candidate,
    parent: verified,
    verifications: [macVerification(candidate)],
    mirrorReceipt: mirrorReceipt(candidate),
    createdAt: '2026-08-26T00:00:03Z',
  });
  const manifest = buildPlatformChannelManifest({
    checkpoint: mirrored,
    notes: 'Mac can move while Windows remains pending.',
    publishedAt: '2026-08-26T00:00:04Z',
  });

  assert.equal(manifest.platform, 'macos-arm64');
  assert.equal(manifest.tag, 'v1.2.3-beta.4');
  assert.equal(manifest.variant, 'standard');
  assert.equal(manifest.checkpoint_id, mirrored.checkpoint_id);
  assert.equal(manifest.assets.length, 3);
});

test('macOS v2 requires distinct fixture and live StepFun verification receipts', () => {
  const candidate = macCandidate(intent(), { verificationContract: 'macos_voice_context_v2' });
  const built = buildPlatformCheckpoint({ phase: 'build_created', candidate });
  const fixture = macVerification(candidate);
  const live = macLiveVerification(candidate);

  assert.doesNotThrow(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [fixture, live],
  }));
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [fixture],
  }), /requires 2 release verification/u);
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [live],
  }), /requires 2 release verification/u);
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [fixture, fixture],
  }), /duplicated/u);

  for (const overrides of [
    { mock_inputs_present: true },
    { timeline_origin: 'fixture' },
    { provider: 'doubao' },
    { timeline_segment_count: 0 },
    { cpu_inference_allowed: true },
  ]) {
    assert.throws(() => buildPlatformCheckpoint({
      phase: 'platform_verified',
      candidate,
      parent: built,
      verifications: [fixture, macLiveVerification(candidate, overrides)],
    }), /live StepFun timeline evidence is incomplete/u);
  }

  const transcriptLeak = macLiveVerification(candidate);
  transcriptLeak.evidence[1].text = 'must not be public';
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [fixture, transcriptLeak],
  }), /transcript-bearing key/u);
});

test('validates the exact Windows Squirrel candidate and timestamped installer receipt', () => {
  const candidate = windowsCandidate(intent());
  const built = buildPlatformCheckpoint({ phase: 'build_created', candidate });
  assert.doesNotThrow(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [windowsVerification(candidate)],
  }));
  const missingTimestamp = windowsVerification(candidate);
  missingTimestamp.evidence[0].timestamp_present = false;
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [missingTimestamp],
  }), /timestamped Authenticode/u);
  const extraRow = windowsCandidate(intent());
  extraRow.candidate.update.squirrel_releases += `${'d'.repeat(40)} obsolete.nupkg 200\n`;
  extraRow.candidate_id = contentId(extraRow.candidate);
  assert.throws(
    () => buildPlatformCheckpoint({ phase: 'build_created', candidate: extraRow }),
    /exact nupkg/u,
  );
  const nonCanonicalSize = windowsCandidate(intent());
  nonCanonicalSize.candidate.update.squirrel_releases = `${'d'.repeat(40)} Flowzero-1.2.3-beta4-full.nupkg 0200\n`;
  nonCanonicalSize.candidate_id = contentId(nonCanonicalSize.candidate);
  assert.throws(
    () => buildPlatformCheckpoint({ phase: 'build_created', candidate: nonCanonicalSize }),
    /exact nupkg/u,
  );
});

test('refuses to promote macOS without the packaged local multi-speaker business outcome', () => {
  const candidate = macCandidate(intent());
  const built = buildPlatformCheckpoint({ phase: 'build_created', candidate });
  const receipt = macVerification(candidate);
  receipt.evidence = receipt.evidence.filter(
    (entry) => entry.kind !== 'packaged_local_multi_speaker_context',
  );
  assert.throws(
    () => buildPlatformCheckpoint({
      phase: 'platform_verified',
      candidate,
      parent: built,
      verifications: [receipt],
    }),
    /multi-speaker business outcome/,
  );
});

test('rejects weak macOS verification subjects and incomplete business evidence', () => {
  const candidate = macCandidate(intent());
  const zip = candidate.candidate.assets.find((asset) => asset.role === 'macos_updater_zip');
  const wrongSubject = macVerification(candidate);
  wrongSubject.subject = { name: zip.name, size: zip.size, sha256: zip.sha256 };
  assert.throws(() => buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: buildPlatformCheckpoint({ phase: 'build_created', candidate }),
    verifications: [wrongSubject],
  }), /final DMG/u);

  for (const missingKind of ['packaged_pyannote_mps', 'macos_structure']) {
    const receipt = macVerification(candidate);
    receipt.evidence = receipt.evidence.filter((entry) => entry.kind !== missingKind);
    assert.throws(() => buildPlatformCheckpoint({
      phase: 'platform_verified',
      candidate,
      parent: buildPlatformCheckpoint({ phase: 'build_created', candidate }),
      verifications: [receipt],
    }), /verification is missing/u);
  }
});

test('refuses phase skipping and mirror receipts that do not prove every object', () => {
  const candidate = macCandidate(intent());
  const built = buildPlatformCheckpoint({ phase: 'build_created', candidate });
  assert.throws(
    () => buildPlatformCheckpoint({
      phase: 'mirrored',
      candidate,
      parent: built,
      verifications: [macVerification(candidate)],
      mirrorReceipt: mirrorReceipt(candidate),
    }),
    /parent phase/,
  );
  const verified = buildPlatformCheckpoint({
    phase: 'platform_verified',
    candidate,
    parent: built,
    verifications: [macVerification(candidate)],
  });
  const incomplete = mirrorReceipt(candidate);
  incomplete.origins[1].objects.pop();
  assert.throws(
    () => buildPlatformCheckpoint({
      phase: 'mirrored',
      candidate,
      parent: verified,
      verifications: [macVerification(candidate)],
      mirrorReceipt: incomplete,
    }),
    /incomplete|does not prove/,
  );
  const wrongChecksum = mirrorReceipt(candidate);
  wrongChecksum.origins[0].objects[0].server_checksum = 'sha256:invalid';
  assert.throws(
    () => buildPlatformCheckpoint({
      phase: 'mirrored',
      candidate,
      parent: verified,
      verifications: [macVerification(candidate)],
      mirrorReceipt: wrongChecksum,
    }),
    /does not prove/,
  );
});

test('legacy Windows migration preserves the exact Squirrel SHA-1 binding', () => {
  const nupkgName = 'Flowzero-1.2.3-beta4-full.nupkg';
  const nupkgSha1 = 'd'.repeat(40);
  const legacy = {
    schema: 'flowzero.update_channel_manifest.v1',
    channel: 'beta',
    state: 'published',
    tag: 'v1.2.3-beta.4',
    published_at: '2026-08-26T00:00:00Z',
    notes: 'Legacy beta',
    assets: [
      {
        name: 'Flowzero-1.2.3-beta.4-Setup.exe',
        content_type: 'application/octet-stream',
        size: 300,
        sha256: sha('4'),
      },
      {
        name: nupkgName,
        content_type: 'application/octet-stream',
        size: 200,
        sha256: sha('5'),
      },
      {
        name: 'RELEASES',
        content_type: 'application/octet-stream',
        size: 100,
        sha256: sha('6'),
      },
    ],
    squirrel_releases: `${nupkgSha1} ${nupkgName} 200\n`,
  };
  const migrated = splitLegacyManifest({
    legacy,
    platform: 'windows-x64',
    sourceHeadSha: sourceSha,
  });
  assert.equal(
    migrated.assets.find((asset) => asset.role === 'windows_nupkg').sha1,
    nupkgSha1,
  );
  assert.equal(migrated.variant, 'standard');

  assert.throws(() => splitLegacyManifest({
    legacy: {
      ...legacy,
      squirrel_releases: `${legacy.squirrel_releases}${nupkgSha1} obsolete.nupkg 200\n`,
    },
    platform: 'windows-x64',
    sourceHeadSha: sourceSha,
  }), /one exact nupkg row/u);
});
