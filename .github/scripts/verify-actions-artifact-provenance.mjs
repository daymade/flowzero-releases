#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ARTIFACT_PROVENANCE_SCHEMA = 'flowzero.actions_artifact_provenance.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const allowed = new Set([
    '--candidate-artifact',
    '--verification-artifact',
    '--verification-run',
    '--source-run-id',
    '--verification-run-id',
    '--candidate-artifact-id',
    '--verification-artifact-id',
    '--platform',
    '--toolkit-sha',
    '--output',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values[key]) throw new Error(`invalid argument: ${key || '<empty>'}`);
    values[key] = value;
  }
  for (const key of allowed) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

export function validateActionsArtifactProvenance({
  candidateArtifact,
  verificationArtifact,
  verificationRun,
  sourceRunId,
  verificationRunId,
  candidateArtifactId,
  verificationArtifactId,
  platform,
  toolkitSha,
}) {
  for (const [label, value] of [
    ['source run', sourceRunId],
    ['verification run', verificationRunId],
    ['candidate artifact', candidateArtifactId],
    ['verification artifact', verificationArtifactId],
  ]) {
    assert(/^\d+$/.test(String(value || '')), `${label} ID is invalid`);
  }
  assert(['macos-arm64', 'windows-x64'].includes(platform), 'recovery platform is invalid');
  assert(/^[a-f0-9]{40}$/.test(toolkitSha || ''), 'recovery toolkit SHA is invalid');
  assert(String(candidateArtifact?.id) === String(candidateArtifactId), 'candidate artifact ID mismatch');
  assert(String(candidateArtifact?.workflow_run?.id) === String(sourceRunId), 'candidate artifact run mismatch');
  assert(candidateArtifact?.expired === false, 'candidate artifact is expired');
  const candidateNamePattern = platform === 'macos-arm64' ? /^macos-final-/u : /^windows-final-/u;
  assert(candidateNamePattern.test(candidateArtifact?.name || ''), 'candidate artifact name is invalid');
  assert(String(verificationArtifact?.id) === String(verificationArtifactId), 'verification artifact ID mismatch');
  assert(String(verificationArtifact?.workflow_run?.id) === String(verificationRunId), 'verification artifact run mismatch');
  assert(verificationArtifact?.expired === false, 'verification artifact is expired');
  assert(String(verificationRun?.id) === String(verificationRunId), 'verification workflow run mismatch');
  assert(verificationRun?.status === 'completed', 'verification workflow is not complete');

  const separateVerificationRun = String(verificationRunId) !== String(sourceRunId);
  if (separateVerificationRun) {
    assert(platform === 'macos-arm64', 'Windows verification must come from its original release run');
    assert(verificationRun.path === '.github/workflows/reverify-macos-business.yml', 'verification workflow path is untrusted');
    assert(verificationRun.event === 'workflow_dispatch', 'verification workflow event is untrusted');
    assert(verificationRun.head_branch === 'main', 'verification workflow branch is untrusted');
    assert(verificationRun.head_sha === toolkitSha, 'verification workflow toolkit SHA mismatch');
    assert(verificationRun.conclusion === 'success', 'verification workflow did not succeed');
    assert(
      verificationArtifact.name === `macos-business-reverification-${verificationRunId}-${verificationRun.run_attempt}`,
      'verification artifact name does not bind the exact run attempt',
    );
  } else {
    assert(verificationRun.path === '.github/workflows/release.yml', 'source verification workflow path is untrusted');
    const verificationNamePattern = platform === 'macos-arm64'
      ? /^macos-verification-/u
      : /^windows-verification-/u;
    assert(verificationNamePattern.test(verificationArtifact?.name || ''), 'source verification artifact name is invalid');
  }

  return {
    schema: ARTIFACT_PROVENANCE_SCHEMA,
    platform,
    candidate: {
      artifact_id: String(candidateArtifactId),
      run_id: String(sourceRunId),
      name: candidateArtifact.name,
    },
    verification: {
      artifact_id: String(verificationArtifactId),
      run_id: String(verificationRunId),
      name: verificationArtifact.name,
      workflow_path: verificationRun.path,
      event: verificationRun.event,
      head_branch: verificationRun.head_branch,
      head_sha: verificationRun.head_sha,
      run_attempt: Number(verificationRun.run_attempt),
      conclusion: verificationRun.conclusion,
    },
  };
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `tinkle_${path.basename(resolved)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const readJson = async (filePath) => JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
  const provenance = validateActionsArtifactProvenance({
    candidateArtifact: await readJson(args['--candidate-artifact']),
    verificationArtifact: await readJson(args['--verification-artifact']),
    verificationRun: await readJson(args['--verification-run']),
    sourceRunId: args['--source-run-id'],
    verificationRunId: args['--verification-run-id'],
    candidateArtifactId: args['--candidate-artifact-id'],
    verificationArtifactId: args['--verification-artifact-id'],
    platform: args['--platform'],
    toolkitSha: args['--toolkit-sha'],
  });
  await atomicWriteJson(args['--output'], provenance);
  process.stdout.write(`${provenance.verification.workflow_path}:${provenance.verification.run_id}\n`);
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
