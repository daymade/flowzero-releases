#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';
import { parseProjectReleaseTag } from './release-tag-contract.mjs';

export const CHECKPOINT_SCHEMA = 'flowzero.release_platform_checkpoint.v1';
export const CANDIDATE_SCHEMA = 'flowzero.release_platform_candidate.v1';
export const VERIFICATION_SCHEMA = 'flowzero.release_verification.v1';
export const MIRROR_RECEIPT_SCHEMA = 'flowzero.release_mirror_receipt.v1';
export const PHASES = Object.freeze(['build_created', 'platform_verified', 'mirrored']);
export const PLATFORM_ROLES = Object.freeze({
  'macos-arm64': Object.freeze([
    'macos_dmg',
    'macos_updater_zip',
    'macos_update_integrity',
  ]),
  'windows-x64': Object.freeze([
    'windows_setup',
    'windows_nupkg',
    'windows_releases',
  ]),
});
export const VERIFICATION_CONTRACTS = Object.freeze({
  macos_voice_context_v1: Object.freeze(['macos-voice-context']),
  macos_voice_context_v2: Object.freeze([
    'macos-voice-context',
    'macos-live-stepfun-timeline',
  ]),
  windows_installer_v1: Object.freeze(['windows-installer']),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hashEnvelope(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function resolveRequiredVerificationSuites(candidate) {
  const declared = candidate.verification_contract;
  if (candidate.platform === 'macos-arm64' && declared === undefined) {
    return VERIFICATION_CONTRACTS.macos_voice_context_v1;
  }
  if (candidate.platform === 'windows-x64' && declared === undefined) {
    return VERIFICATION_CONTRACTS.windows_installer_v1;
  }
  const suites = VERIFICATION_CONTRACTS[declared];
  assert(Array.isArray(suites), 'candidate verification contract is unsupported');
  if (candidate.platform === 'macos-arm64') {
    assert(declared.startsWith('macos_'), 'candidate verification contract does not match macOS');
  } else {
    assert(declared === 'windows_installer_v1', 'candidate verification contract does not match Windows');
  }
  return suites;
}

function assertNoTranscriptBearingKeys(value) {
  const forbidden = new Set(['text', 'raw_text', 'content', 'renderedTexts', 'expectedTexts']);
  const visit = current => {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(current)) {
      assert(!forbidden.has(key), `live StepFun verification contains transcript-bearing key: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

export function validateCandidateEnvelope(envelope) {
  assert(envelope?.schema === CANDIDATE_SCHEMA, 'candidate schema is unsupported');
  assert(/^sha256:[a-f0-9]{64}$/.test(envelope.candidate_id || ''), 'candidate id is invalid');
  const candidate = envelope.candidate;
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'candidate payload is missing');
  assert(Object.hasOwn(PLATFORM_ROLES, candidate.platform), 'candidate platform is unsupported');
  resolveRequiredVerificationSuites(candidate);
  assert(/^sha256:[a-f0-9]{64}$/.test(candidate.transaction_id || ''), 'candidate transaction id is invalid');
  assert(candidate.source?.repository === 'daymade/flowzero', 'candidate source repository is invalid');
  assert(/^[a-f0-9]{40}$/.test(candidate.source?.head_sha || ''), 'candidate source SHA is invalid');
  const parsedTag = parseProjectReleaseTag(candidate.release?.tag);
  assert(candidate.release.version === parsedTag.version, 'candidate release version is invalid');
  assert(candidate.release.channel === parsedTag.channel, 'candidate release channel is invalid');
  assert(['standard', 'offline'].includes(candidate.release.variant), 'candidate release variant is invalid');
  assert(/^[a-f0-9]{40}$/.test(candidate.attempt?.release_infrastructure_sha || ''), 'candidate release infrastructure SHA is invalid');
  assert(/^\d+$/.test(String(candidate.attempt?.workflow_run_id || '')), 'candidate workflow run id is invalid');
  assert(
    Number.isSafeInteger(Number(candidate.attempt?.workflow_run_attempt))
      && Number(candidate.attempt.workflow_run_attempt) > 0,
    'candidate workflow run attempt is invalid',
  );
  assert(Array.isArray(candidate.assets), 'candidate assets are missing');
  const roles = candidate.assets.map((asset) => asset.role);
  const expected = PLATFORM_ROLES[candidate.platform];
  assert(candidate.assets.length === expected.length, 'candidate asset count is invalid');
  for (const role of expected) {
    assert(roles.filter((candidateRole) => candidateRole === role).length === 1, `candidate role is missing or duplicated: ${role}`);
  }
  const names = new Set();
  for (const asset of candidate.assets) {
    assert(typeof asset.name === 'string' && asset.name && !asset.name.includes('/') && !asset.name.includes('\\'), 'candidate asset name is invalid');
    assert(!names.has(asset.name), `candidate asset name is duplicated: ${asset.name}`);
    names.add(asset.name);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `candidate asset size is invalid: ${asset.name}`);
    assert(/^[a-f0-9]{64}$/.test(asset.sha256 || ''), `candidate asset digest is invalid: ${asset.name}`);
  }
  if (candidate.platform === 'macos-arm64') {
    const zip = candidate.assets.find((asset) => asset.role === 'macos_updater_zip');
    const dmg = candidate.assets.find((asset) => asset.role === 'macos_dmg');
    const integrity = candidate.update?.mac_update_integrity;
    assert(
      integrity?.schema === 'flowzero.macos_update_integrity.v1'
      && integrity.version === candidate.release.version
      && integrity.file?.name === zip.name
      && integrity.file?.size === zip.size
      && integrity.file?.sha256 === zip.sha256
      && /^[A-Za-z0-9+/]{86}==$/.test(integrity.file?.sha512 || '')
      && zip.sha512 === integrity.file.sha512
      && integrity.dmg?.name === dmg.name
      && integrity.dmg?.size === dmg.size
      && integrity.dmg?.sha256 === dmg.sha256,
      'candidate macOS update metadata does not bind every updater asset field',
    );
  } else {
    const nupkg = candidate.assets.find((asset) => asset.role === 'windows_nupkg');
    const releases = candidate.update?.squirrel_releases;
    const rows = typeof releases === 'string' ? releases.trim().split(/\r?\n/u).filter(Boolean) : [];
    const columns = rows.length === 1 ? rows[0].split(/\s+/u) : [];
    assert(
      rows.length === 1
      && /^[a-f0-9]{40}$/i.test(columns[0] || '')
      && columns[0].toLowerCase() === nupkg.sha1
      && columns[1] === nupkg.name
      && columns[2] === String(nupkg.size),
      'candidate Windows RELEASES does not bind the exact nupkg',
    );
  }
  assert(hashEnvelope(candidate) === envelope.candidate_id, 'candidate content hash is invalid');
  return JSON.parse(JSON.stringify(envelope));
}

export function validateVerificationReceipt(receipt, candidateEnvelope) {
  assert(receipt?.schema === VERIFICATION_SCHEMA && receipt.status === 'pass', 'verification receipt did not pass');
  const candidate = candidateEnvelope.candidate;
  assert(receipt.platform === candidate.platform, 'verification platform mismatch');
  assert(receipt.version === candidate.release.version, 'verification version mismatch');
  assert(receipt.source_head_sha === candidate.source.head_sha, 'verification source SHA mismatch');
  const matchingSubjects = candidate.assets.filter((asset) => (
    asset.name === receipt.subject?.name
    && asset.sha256 === receipt.subject?.sha256
    && asset.size === receipt.subject?.size
  ));
  assert(matchingSubjects.length === 1, 'verification subject is not one exact candidate asset');
  const subject = matchingSubjects[0];
  assert(!Number.isNaN(Date.parse(receipt.verified_at)), 'verification receipt timestamp is invalid');
  const requiredSuites = resolveRequiredVerificationSuites(candidate);
  assert(requiredSuites.includes(receipt.suite), `platform verification does not allow ${receipt.suite}`);
  if (candidate.platform === 'macos-arm64') {
    assert(subject.role === 'macos_dmg', 'macOS verification subject must be the final DMG');
    const structure = receipt.evidence?.find(
      (entry) => entry.kind === 'macos_structure' && entry.status === 'pass',
    );
    assert(structure, 'macOS verification is missing packaged structure evidence');
    if (receipt.suite === 'macos-voice-context') {
      const runtime = receipt.evidence?.find(
        (entry) => entry.kind === 'packaged_pyannote_mps'
          && entry.status === 'pass'
          && String(entry.device || '').toLowerCase() === 'mps'
          && entry.cpu_inference_allowed === false,
      );
      assert(runtime, 'macOS verification is missing packaged pyannote MPS evidence');
      const business = receipt.evidence?.find(
        (entry) => entry.kind === 'packaged_local_multi_speaker_context' && entry.status === 'pass',
      );
      assert(business, 'macOS verification is missing the local multi-speaker business outcome');
      assert(
        business.speaker_count >= 2
        && business.history_turn_count >= 2
        && business.history_written === true
        && business.memory_written === true
        && business.fts_searchable === true
        && business.zero_process_residue === true,
        'macOS voice-context evidence is incomplete',
      );
      assert(
        business.ambient_user_python_required === false
        && business.ambient_huggingface_token_required === false,
        'macOS business verification depended on ambient runtime state',
      );
    } else {
      assertNoTranscriptBearingKeys(receipt);
      const live = receipt.evidence?.find(
        entry => entry.kind === 'packaged_live_stepfun_timeline' && entry.status === 'pass',
      );
      assert(live, 'macOS verification is missing live StepFun timeline evidence');
      assert(
        live.provider === 'stepfun'
        && live.model === 'stepaudio-2.5-asr'
        && live.transport === 'https_sse'
        && live.http_status === 200
        && live.request_id_present === true
        && live.timeline_origin === 'stepfun_timestamped_delta'
        && live.timeline_segment_count >= 1
        && live.timeline_duration_ms > 0
        && live.transcription_source === 'live_provider'
        && live.mock_inputs_present === false
        && live.runtime === 'pyannote_community1_mps'
        && String(live.device || '').toLowerCase() === 'mps'
        && live.cpu_inference_allowed === false
        && live.speaker_count >= 2
        && live.history_turn_count >= 2
        && live.history_written === true
        && live.memory_written === true
        && live.fts_searchable === true
        && live.zero_process_residue === true,
        'macOS live StepFun timeline evidence is incomplete',
      );
    }
  } else {
    assert(subject.role === 'windows_setup', 'Windows verification subject must be the signed Setup executable');
    const signature = receipt.evidence?.find(
      (entry) => entry.kind === 'windows_authenticode'
        && entry.status === 'pass'
        && entry.timestamp_present === true,
    );
    assert(signature, 'Windows verification is missing valid timestamped Authenticode evidence');
    const installer = receipt.evidence?.find(
      (entry) => entry.kind === 'windows_installer' && entry.status === 'pass',
    );
    assert(installer, 'Windows verification is missing installer smoke evidence');
  }
  return JSON.parse(JSON.stringify(receipt));
}

export function validateVerificationSet(verifications, candidateEnvelope) {
  const requiredSuites = resolveRequiredVerificationSuites(candidateEnvelope.candidate);
  assert(
    verifications.length === requiredSuites.length,
    `platform_verified checkpoint requires ${requiredSuites.length} release verification receipt(s)`,
  );
  const validated = verifications.map(receipt => validateVerificationReceipt(receipt, candidateEnvelope));
  const suites = validated.map(receipt => receipt.suite);
  assert(new Set(suites).size === suites.length, 'platform verification suites are duplicated');
  assert(
    requiredSuites.every(suite => suites.includes(suite)),
    'platform verification suite set is incomplete',
  );
  return validated;
}

export function validateMirrorReceipt(receipt, candidateEnvelope) {
  assert(receipt?.schema === MIRROR_RECEIPT_SCHEMA, 'mirror receipt schema is unsupported');
  assert(receipt.candidate_id === candidateEnvelope.candidate_id, 'mirror receipt candidate mismatch');
  assert(receipt.transaction_id === candidateEnvelope.candidate.transaction_id, 'mirror receipt transaction mismatch');
  assert(receipt.platform === candidateEnvelope.candidate.platform, 'mirror receipt platform mismatch');
  assert(!Number.isNaN(Date.parse(receipt.mirrored_at)), 'mirror receipt timestamp is invalid');
  assert(Array.isArray(receipt.origins) && receipt.origins.length === 2, 'mirror receipt origins are missing or duplicated');
  for (const origin of ['r2', 'oss']) {
    const matchingOrigins = receipt.origins.filter((entry) => entry.origin === origin);
    assert(matchingOrigins.length === 1, `mirror receipt must contain exactly one ${origin} origin`);
    const objects = matchingOrigins[0].objects;
    assert(
      Array.isArray(objects) && objects.length === candidateEnvelope.candidate.assets.length,
      `mirror receipt ${origin} object set is incomplete or duplicated`,
    );
    for (const asset of candidateEnvelope.candidate.assets) {
      const matches = objects.filter((entry) => entry.name === asset.name);
      assert(matches.length === 1, `mirror receipt must contain exactly one ${origin}/${asset.name}`);
      const object = matches[0];
      const expectedKey = `releases/${candidateEnvelope.candidate.release.tag}/${asset.name}`;
      const expectedR2Checksum = `sha256:${Buffer.from(asset.sha256, 'hex').toString('base64')}`;
      const normalizedEtag = String(object?.etag || '').replaceAll('"', '').toLowerCase();
      assert(
        object
        && object.size === asset.size
        && object.sha256 === asset.sha256
        && object.key === expectedKey
        && typeof object.etag === 'string'
        && object.etag.length > 0
        && (origin === 'r2'
          ? object.server_checksum === expectedR2Checksum
          : /^md5:[a-f0-9]{32}$/.test(object.server_checksum || '')
            && object.server_checksum === `md5:${normalizedEtag}`)
        && object.public_head === true
        && object.public_range === true,
        `mirror receipt does not prove ${origin}/${asset.name}`,
      );
    }
  }
  return JSON.parse(JSON.stringify(receipt));
}

function validateParent(parent, { phase, candidateEnvelope }) {
  if (phase === 'build_created') {
    assert(parent === null, 'build_created checkpoint must not have a parent');
    return null;
  }
  assert(parent?.schema === CHECKPOINT_SCHEMA, 'checkpoint parent is missing');
  assert(hashEnvelope(parent.checkpoint) === parent.checkpoint_id, 'checkpoint parent hash is invalid');
  const expectedParentPhase = PHASES[PHASES.indexOf(phase) - 1];
  assert(parent.checkpoint.phase === expectedParentPhase, `checkpoint parent phase must be ${expectedParentPhase}`);
  assert(parent.checkpoint.candidate_id === candidateEnvelope.candidate_id, 'checkpoint parent candidate mismatch');
  assert(parent.checkpoint.transaction_id === candidateEnvelope.candidate.transaction_id, 'checkpoint parent transaction mismatch');
  return parent;
}

export function buildPlatformCheckpoint({
  phase,
  candidate: rawCandidate,
  parent = null,
  verifications = [],
  mirrorReceipt = null,
  createdAt = new Date().toISOString(),
}) {
  assert(PHASES.includes(phase), `unsupported checkpoint phase: ${phase}`);
  const candidate = validateCandidateEnvelope(rawCandidate);
  const validatedParent = validateParent(parent, { phase, candidateEnvelope: candidate });
  let validatedVerifications = [];
  let validatedMirrorReceipt = null;
  if (phase !== 'build_created') {
    validatedVerifications = validateVerificationSet(verifications, candidate);
  } else {
    assert(verifications.length === 0, 'build_created checkpoint cannot contain verification receipts');
  }
  if (phase === 'mirrored') {
    validatedMirrorReceipt = validateMirrorReceipt(mirrorReceipt, candidate);
  } else {
    assert(mirrorReceipt === null, `${phase} checkpoint cannot contain a mirror receipt`);
  }
  assert(!Number.isNaN(Date.parse(createdAt)), 'checkpoint created_at is invalid');
  const checkpoint = {
    transaction_id: candidate.candidate.transaction_id,
    platform: candidate.candidate.platform,
    phase,
    parent_checkpoint_id: validatedParent?.checkpoint_id || null,
    candidate_id: candidate.candidate_id,
    candidate,
    verifications: validatedVerifications,
    mirror_receipt: validatedMirrorReceipt,
    created_at: createdAt,
  };
  return {
    schema: CHECKPOINT_SCHEMA,
    checkpoint_id: hashEnvelope(checkpoint),
    checkpoint,
  };
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

function parseArguments(argv) {
  const values = { verifications: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${key || '<empty>'} requires a value`);
    if (key === '--verification') {
      values.verifications.push(value);
    } else if (['--phase', '--candidate', '--parent', '--mirror-receipt', '--output'].includes(key)) {
      if (values[key]) throw new Error(`duplicate argument: ${key}`);
      values[key] = value;
    } else {
      throw new Error(`unknown argument: ${key}`);
    }
    index += 1;
  }
  for (const key of ['--phase', '--candidate', '--output']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const candidate = JSON.parse(await readFile(path.resolve(args['--candidate']), 'utf8'));
  const parent = args['--parent']
    ? JSON.parse(await readFile(path.resolve(args['--parent']), 'utf8'))
    : null;
  const verifications = await Promise.all(args.verifications.map(async (file) => (
    JSON.parse(await readFile(path.resolve(file), 'utf8'))
  )));
  const mirrorReceipt = args['--mirror-receipt']
    ? JSON.parse(await readFile(path.resolve(args['--mirror-receipt']), 'utf8'))
    : null;
  const result = buildPlatformCheckpoint({
    phase: args['--phase'],
    candidate,
    parent,
    verifications,
    mirrorReceipt,
  });
  await atomicWriteJson(args['--output'], result);
  process.stdout.write(`${result.checkpoint_id}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
