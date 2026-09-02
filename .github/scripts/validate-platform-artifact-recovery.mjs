#!/usr/bin/env node

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateCandidateEnvelope,
  validateVerificationSet,
} from './release-platform-checkpoint.mjs';

export const RECOVERY_INPUT_SCHEMA = 'flowzero.release_platform_artifact_recovery.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validatePlatformArtifactRecovery({
  candidate: rawCandidate,
  verifications: rawVerifications,
  sourceRunId,
  verificationRunId,
  actionsProvenance,
  candidateArtifactId,
  verificationArtifactId,
  toolkitSha,
  channel,
  platform,
}) {
  assert(/^\d+$/.test(String(sourceRunId || '')), 'source run ID is invalid');
  assert(/^\d+$/.test(String(verificationRunId || '')), 'verification run ID is invalid');
  assert(/^\d+$/.test(String(candidateArtifactId || '')), 'candidate artifact ID is invalid');
  assert(/^\d+$/.test(String(verificationArtifactId || '')), 'verification artifact ID is invalid');
  assert(/^[a-f0-9]{40}$/.test(toolkitSha || ''), 'recovery toolkit SHA is invalid');
  assert(['stable', 'beta'].includes(channel), 'recovery channel is invalid');
  assert(['macos-arm64', 'windows-x64'].includes(platform), 'recovery platform is invalid');
  assert(
    actionsProvenance?.schema === 'flowzero.actions_artifact_provenance.v1'
    && actionsProvenance.platform === platform
    && actionsProvenance.candidate?.run_id === String(sourceRunId)
    && actionsProvenance.candidate?.artifact_id === String(candidateArtifactId)
    && actionsProvenance.verification?.run_id === String(verificationRunId)
    && actionsProvenance.verification?.artifact_id === String(verificationArtifactId),
    'Actions artifact provenance does not match recovery inputs',
  );

  const candidate = validateCandidateEnvelope(rawCandidate);
  const verifications = validateVerificationSet(rawVerifications, candidate);
  assert(
    String(candidate.candidate.attempt.workflow_run_id) === String(sourceRunId),
    'candidate was not produced by the requested source run',
  );
  assert(candidate.candidate.release.channel === channel, 'recovery channel does not match candidate');
  assert(candidate.candidate.platform === platform, 'recovery platform does not match candidate');

  return {
    schema: RECOVERY_INPUT_SCHEMA,
    source_run_id: String(sourceRunId),
    verification_run_id: String(verificationRunId),
    candidate_artifact_id: String(candidateArtifactId),
    verification_artifact_id: String(verificationArtifactId),
    actions_provenance: actionsProvenance,
    verification_suites: verifications.map(receipt => receipt.suite),
    recovery_toolkit_sha: toolkitSha,
    original_release_infrastructure_sha:
      candidate.candidate.attempt.release_infrastructure_sha,
    transaction_id: candidate.candidate.transaction_id,
    candidate_id: candidate.candidate_id,
    source_head_sha: candidate.candidate.source.head_sha,
    channel,
    platform,
    tag: candidate.candidate.release.tag,
    version: candidate.candidate.release.version,
  };
}

function parseArguments(argv) {
  const values = { '--verification': [] };
  const allowed = new Set([
    '--candidate',
    '--verification',
    '--source-run-id',
    '--verification-run-id',
    '--actions-provenance',
    '--candidate-artifact-id',
    '--verification-artifact-id',
    '--toolkit-sha',
    '--channel',
    '--platform',
    '--output',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || (key !== '--verification' && values[key])) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    if (key === '--verification') values[key].push(value);
    else values[key] = value;
  }
  for (const key of allowed) {
    if (!values[key] || (Array.isArray(values[key]) && values[key].length === 0)) {
      throw new Error(`missing argument: ${key}`);
    }
  }
  return values;
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `tinkle_${path.basename(resolved)}.${process.pid}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const candidate = JSON.parse(await readFile(path.resolve(args['--candidate']), 'utf8'));
  const verifications = await Promise.all(args['--verification'].map(async verificationPath => (
    JSON.parse(await readFile(path.resolve(verificationPath), 'utf8'))
  )));
  const actionsProvenance = JSON.parse(await readFile(path.resolve(args['--actions-provenance']), 'utf8'));
  const recovery = validatePlatformArtifactRecovery({
    candidate,
    verifications,
    sourceRunId: args['--source-run-id'],
    verificationRunId: args['--verification-run-id'],
    actionsProvenance,
    candidateArtifactId: args['--candidate-artifact-id'],
    verificationArtifactId: args['--verification-artifact-id'],
    toolkitSha: args['--toolkit-sha'],
    channel: args['--channel'],
    platform: args['--platform'],
  });
  await atomicWriteJson(args['--output'], recovery);
  process.stdout.write(`${recovery.platform}:${recovery.tag}\n`);
  return recovery;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
