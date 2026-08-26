#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProjectReleaseTag } from './release-tag-contract.mjs';

export const INTENT_SCHEMA = 'flowzero.release_intent.v1';
export const TRANSACTION_SCHEMA = 'flowzero.release_transaction.v1';
export const SUPPORTED_PLATFORMS = Object.freeze(['macos-arm64', 'windows-x64']);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function buildManualReleaseIntent({ version, headSha, platforms, variant }) {
  const parsedTag = parseProjectReleaseTag(`v${version}`);
  assert(/^[a-f0-9]{40}$/.test(headSha || ''), 'manual release source SHA is invalid');
  assert(['macos-arm64', 'windows-x64', 'all'].includes(platforms), 'manual release platforms are invalid');
  assert(['standard', 'offline'].includes(variant), 'manual release variant is invalid');
  const requestedPlatforms = platforms === 'all' ? [...SUPPORTED_PLATFORMS] : [platforms];
  const identity = {
    schema: INTENT_SCHEMA,
    source: {
      repository: 'daymade/flowzero',
      head_sha: headSha,
    },
    release: {
      version: parsedTag.version,
      tag: parsedTag.tag,
      channel: parsedTag.channel,
      variant,
    },
    requested_platforms: requestedPlatforms,
    promotion_policy: { mode: 'platform_independent' },
    archive_policy: {
      mode: 'eventual_bundle',
      required_platforms: requestedPlatforms,
    },
  };
  return {
    ...identity,
    transaction_id: `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`,
  };
}

export function releaseIntentFromEvent(event) {
  if (event.action === 'release') {
    const intent = validateReleaseIntent(event.client_payload?.intent);
    assert(event.client_payload.version === intent.release.version, 'legacy payload version disagrees with intent');
    assert(event.client_payload.headSha === intent.source.head_sha, 'legacy payload headSha disagrees with intent');
    assert(Boolean(event.client_payload.offline) === (intent.release.variant === 'offline'), 'legacy payload offline disagrees with intent');
    assert(event.client_payload.ref === 'main', 'legacy payload ref must be main');
    return intent;
  }

  assert(event.ref === 'refs/heads/main', 'manual release infrastructure ref must be main');
  return validateReleaseIntent(buildManualReleaseIntent({
    version: event.inputs?.version,
    headSha: event.inputs?.head_sha,
    platforms: event.inputs?.platforms,
    variant: event.inputs?.variant,
  }));
}

export function validateReleaseIntent(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'release intent must be an object');
  assert(input.schema === INTENT_SCHEMA, 'release intent schema is unsupported');
  assert(input.source?.repository === 'daymade/flowzero', 'release intent source repository is invalid');
  assert(/^[a-f0-9]{40}$/.test(input.source?.head_sha || ''), 'release intent source SHA is invalid');
  const parsedTag = parseProjectReleaseTag(input.release?.tag);
  assert(input.release.version === parsedTag.version, 'release intent tag/version mismatch');
  assert(input.release.channel === parsedTag.channel, 'release intent channel/version mismatch');
  assert(['standard', 'offline'].includes(input.release.variant), 'release intent variant is invalid');
  assert(Array.isArray(input.requested_platforms) && input.requested_platforms.length > 0, 'release intent platforms are missing');
  assert(
    input.requested_platforms.every((platform, index) => (
      SUPPORTED_PLATFORMS[index] === platform
      || (input.requested_platforms.length === 1 && SUPPORTED_PLATFORMS.includes(platform))
    )),
    'release intent platforms must be unique and canonical',
  );
  assert(new Set(input.requested_platforms).size === input.requested_platforms.length, 'release intent platforms are duplicated');
  assert(input.promotion_policy?.mode === 'platform_independent', 'release intent promotion policy is invalid');
  assert(input.archive_policy?.mode === 'eventual_bundle', 'release intent archive policy is invalid');
  assert(
    canonicalJson(input.archive_policy.required_platforms) === canonicalJson(input.requested_platforms),
    'release intent archive platforms must match requested platforms',
  );

  const { transaction_id: suppliedTransactionId, ...identity } = input;
  const expectedTransactionId = `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
  assert(suppliedTransactionId === expectedTransactionId, 'release intent transaction id is invalid');
  return JSON.parse(JSON.stringify(input));
}

export function buildReleaseTransaction({
  intent,
  releaseInfrastructureSha,
  workflowRunId,
  workflowRunAttempt,
  createdAt = new Date().toISOString(),
}) {
  const validatedIntent = validateReleaseIntent(intent);
  assert(/^[a-f0-9]{40}$/.test(releaseInfrastructureSha || ''), 'release infrastructure SHA is invalid');
  assert(/^\d+$/.test(String(workflowRunId || '')), 'workflow run id is invalid');
  assert(Number.isSafeInteger(Number(workflowRunAttempt)) && Number(workflowRunAttempt) > 0, 'workflow run attempt is invalid');
  assert(!Number.isNaN(Date.parse(createdAt)), 'transaction created_at is invalid');
  return {
    schema: TRANSACTION_SCHEMA,
    transaction_id: validatedIntent.transaction_id,
    intent: validatedIntent,
    attempt: {
      release_infrastructure_repository: 'daymade/flowzero-releases',
      release_infrastructure_sha: releaseInfrastructureSha,
      workflow_run_id: String(workflowRunId),
      workflow_run_attempt: Number(workflowRunAttempt),
    },
    created_at: createdAt,
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
  const values = {};
  const allowed = new Set([
    '--event-file',
    '--release-infra-sha',
    '--run-id',
    '--run-attempt',
    '--output',
    '--github-output',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error(`invalid argument: ${key || '<empty>'}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
  }
  for (const key of [
    '--event-file',
    '--release-infra-sha',
    '--run-id',
    '--run-attempt',
    '--output',
  ]) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const event = JSON.parse(await readFile(path.resolve(args['--event-file']), 'utf8'));
  const intent = releaseIntentFromEvent(event);
  const transaction = buildReleaseTransaction({
    intent,
    releaseInfrastructureSha: args['--release-infra-sha'],
    workflowRunId: args['--run-id'],
    workflowRunAttempt: args['--run-attempt'],
  });
  await atomicWriteJson(args['--output'], transaction);
  if (args['--github-output']) {
    const version = intent.release.version;
    const windowsPackageVersion = version.replace(/-([a-z0-9-]+)\.(\d+)$/u, '-$1$2');
    const outputs = {
      version,
      tag: intent.release.tag,
      channel: intent.release.channel,
      variant: intent.release.variant,
      head_sha: intent.source.head_sha,
      transaction_id: intent.transaction_id,
      transaction_short: intent.transaction_id.slice('sha256:'.length, 'sha256:'.length + 16),
      macos_requested: String(intent.requested_platforms.includes('macos-arm64')),
      windows_requested: String(intent.requested_platforms.includes('windows-x64')),
      release_infra_sha: args['--release-infra-sha'],
      windows_nupkg_name: `Flowzero-${windowsPackageVersion}-full.nupkg`,
    };
    await appendFile(
      path.resolve(args['--github-output']),
      `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
      'utf8',
    );
  }
  process.stdout.write(`${JSON.stringify(transaction)}\n`);
  return transaction;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
