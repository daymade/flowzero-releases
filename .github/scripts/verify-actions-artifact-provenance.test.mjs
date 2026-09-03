import assert from 'node:assert/strict';
import test from 'node:test';
import { validateActionsArtifactProvenance } from './verify-actions-artifact-provenance.mjs';

const toolkitSha = 'a'.repeat(40);

function inputs(overrides = {}) {
  return {
    candidateArtifact: {
      id: 101,
      name: 'macos-final-transaction-1',
      expired: false,
      workflow_run: { id: 11 },
    },
    verificationArtifact: {
      id: 202,
      name: 'macos-business-reverification-22-3',
      expired: false,
      workflow_run: { id: 22 },
    },
    verificationRun: {
      id: 22,
      path: '.github/workflows/reverify-macos-business.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: toolkitSha,
      status: 'completed',
      conclusion: 'success',
      run_attempt: 3,
    },
    sourceRunId: '11',
    verificationRunId: '22',
    candidateArtifactId: '101',
    verificationArtifactId: '202',
    platform: 'macos-arm64',
    toolkitSha,
    ...overrides,
  };
}

test('binds a separate verification artifact to the trusted main reverification run and attempt', () => {
  const result = validateActionsArtifactProvenance(inputs());
  assert.equal(result.verification.workflow_path, '.github/workflows/reverify-macos-business.yml');
  assert.equal(result.verification.run_attempt, 3);
});

test('rejects arbitrary run identity, branch, toolkit, conclusion, and artifact ownership', () => {
  for (const patch of [
    { verificationRun: { ...inputs().verificationRun, path: '.github/workflows/other.yml' } },
    { verificationRun: { ...inputs().verificationRun, head_branch: 'feature' } },
    { verificationRun: { ...inputs().verificationRun, head_sha: 'b'.repeat(40) } },
    { verificationRun: { ...inputs().verificationRun, conclusion: 'failure' } },
    { verificationArtifact: { ...inputs().verificationArtifact, workflow_run: { id: 999 } } },
    { verificationArtifact: { ...inputs().verificationArtifact, name: 'copied-receipts' } },
  ]) {
    assert.throws(() => validateActionsArtifactProvenance(inputs(patch)));
  }
});

test('accepts an original release verification artifact from the same source run', () => {
  const result = validateActionsArtifactProvenance(inputs({
    verificationRunId: '11',
    verificationArtifact: {
      id: 202,
      name: 'macos-verification-transaction-1',
      expired: false,
      workflow_run: { id: 11 },
    },
    verificationRun: {
      id: 11,
      path: '.github/workflows/release.yml',
      event: 'repository_dispatch',
      head_branch: 'main',
      head_sha: 'c'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 1,
    },
  }));
  assert.equal(result.verification.run_id, '11');
});

test('accepts Windows artifacts from the original release run without macOS name hardcoding', () => {
  const result = validateActionsArtifactProvenance(inputs({
    platform: 'windows-x64',
    candidateArtifact: {
      id: 101,
      name: 'windows-final-transaction-1',
      expired: false,
      workflow_run: { id: 11 },
    },
    verificationRunId: '11',
    verificationArtifact: {
      id: 202,
      name: 'windows-verification-transaction-1',
      expired: false,
      workflow_run: { id: 11 },
    },
    verificationRun: {
      id: 11,
      path: '.github/workflows/release.yml',
      event: 'repository_dispatch',
      head_branch: 'main',
      head_sha: 'c'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 1,
    },
  }));
  assert.equal(result.candidate.name, 'windows-final-transaction-1');
  assert.equal(result.verification.name, 'windows-verification-transaction-1');
});

test('accepts Windows verification only from the exact trusted reverification run and attempt', () => {
  const result = validateActionsArtifactProvenance(inputs({
    platform: 'windows-x64',
    candidateArtifact: {
      id: 101,
      name: 'windows-final-transaction-1',
      expired: false,
      workflow_run: { id: 11 },
    },
    verificationArtifact: {
      id: 202,
      name: 'windows-business-reverification-22-3',
      expired: false,
      workflow_run: { id: 22 },
    },
    verificationRun: {
      ...inputs().verificationRun,
      path: '.github/workflows/reverify-windows-business.yml',
    },
  }));
  assert.equal(result.verification.workflow_path, '.github/workflows/reverify-windows-business.yml');
  assert.equal(result.verification.run_attempt, 3);
});

test('rejects cross-platform reverification workflows and Windows artifact attempt drift', () => {
  const windows = {
    platform: 'windows-x64',
    candidateArtifact: {
      id: 101,
      name: 'windows-final-transaction-1',
      expired: false,
      workflow_run: { id: 11 },
    },
    verificationArtifact: {
      id: 202,
      name: 'windows-business-reverification-22-3',
      expired: false,
      workflow_run: { id: 22 },
    },
  };
  assert.throws(() => validateActionsArtifactProvenance(inputs(windows)), /workflow path is untrusted/u);
  assert.throws(() => validateActionsArtifactProvenance(inputs({
    ...windows,
    verificationArtifact: {
      ...windows.verificationArtifact,
      name: 'windows-business-reverification-22-2',
    },
    verificationRun: {
      ...inputs().verificationRun,
      path: '.github/workflows/reverify-windows-business.yml',
    },
  })), /does not bind the exact run attempt/u);
});

test('rejects macOS artifact names on a Windows recovery route', () => {
  assert.throws(
    () => validateActionsArtifactProvenance(inputs({ platform: 'windows-x64' })),
    /candidate artifact name is invalid/u,
  );
});
