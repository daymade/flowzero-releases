#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';
import { r2Head, run } from './mirror-release-assets.mjs';
import {
  LEGACY_BRIDGE_PURPOSE,
  validateLegacyBridgeHold,
  validateLegacyBridgeIntent,
  validateWindowsSigningPolicy,
} from './windows-legacy-bridge-contract.mjs';

export const LEGACY_BRIDGE_RESERVATION_SCHEMA = 'flowzero.windows_legacy_bridge_reservation.v1';
export const RELEASE_TAG_ARBITRATION_SCHEMA = 'flowzero.release_tag_arbitration.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value, encoding = 'hex') {
  return createHash('sha256').update(value).digest(encoding);
}

function contentId(value) {
  return `sha256:${digest(canonicalJson(value))}`;
}

function requiredEnvironment(env) {
  for (const name of ['RUNNER_TEMP', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']) {
    assert(typeof env[name] === 'string' && env[name].trim(), `missing bridge reservation configuration: ${name}`);
  }
  return env;
}

export function reservationKey(role, tag) {
  assert(['bridge', 'target'].includes(role), 'legacy bridge reservation role is invalid');
  return `release-control/windows-legacy-bridges/${role}-tags/${tag}.json`;
}

function buildReservation(intent, role) {
  const reservation = {
    purpose: LEGACY_BRIDGE_PURPOSE,
    role,
    platform: 'windows-x64',
    bridge_transaction_id: intent.transaction_id,
    source_head_sha: intent.source.head_sha,
    bridge_tag: intent.bridge.tag,
    target_tag: intent.target.tag,
    affected_versions: [...intent.affected_versions],
    windows_signing_policy: intent.windows_signing_policy,
  };
  return {
    schema: LEGACY_BRIDGE_RESERVATION_SCHEMA,
    reservation_id: contentId(reservation),
    reservation,
  };
}

function resolveHead(env, key, dependencies = {}) {
  if (dependencies.r2Head) return dependencies.r2Head(env, key);
  if (dependencies.run) {
    const result = dependencies.run('aws', [
      's3api', 'head-object', '--bucket', env.R2_BUCKET, '--key', key,
      '--endpoint-url', env.R2_ENDPOINT, '--checksum-mode', 'ENABLED', '--output', 'json',
    ], { allowFailure: true });
    return result.status === 0 ? JSON.parse(result.stdout || '{}') : null;
  }
  return r2Head(env, key);
}

function buildArbitration({ role, tag, transactionId, reservation = null }) {
  const arbitration = {
    tag,
    role,
    transaction_id: transactionId,
    ...(reservation ? { reservation } : {}),
  };
  return {
    schema: RELEASE_TAG_ARBITRATION_SCHEMA,
    arbitration_id: contentId(arbitration),
    arbitration,
  };
}

export function arbitrationKey(tag) {
  return `release-control/releases/${tag}/arbitration.json`;
}

function readObject(env, key, dependencies = {}) {
  const runCommand = dependencies.run || run;
  const head = resolveHead(env, key, dependencies);
  if (!head) return null;
  const target = path.join(env.RUNNER_TEMP, `bridge-reservation-${process.pid}-${digest(key).slice(0, 12)}.json`);
  runCommand('aws', [
    's3api', 'get-object', '--bucket', env.R2_BUCKET, '--key', key,
    '--if-match', head.ETag, '--endpoint-url', env.R2_ENDPOINT,
    '--checksum-mode', 'ENABLED', '--output', 'json', target,
  ]);
  const bytes = readFileSync(target);
  assert(head.ContentLength === bytes.length, `bridge reservation size mismatch: ${key}`);
  assert(head.Metadata?.sha256 === digest(bytes), `bridge reservation metadata mismatch: ${key}`);
  assert(head.ChecksumSHA256 === digest(bytes, 'base64'), `bridge reservation checksum mismatch: ${key}`);
  return JSON.parse(bytes.toString('utf8'));
}

function validateReservation(envelope, expectedRole = null) {
  assert(envelope?.schema === LEGACY_BRIDGE_RESERVATION_SCHEMA, 'legacy bridge reservation schema is unsupported');
  const reservation = envelope.reservation;
  assert(reservation?.purpose === LEGACY_BRIDGE_PURPOSE, 'legacy bridge reservation purpose is invalid');
  assert(['bridge', 'target'].includes(reservation.role), 'legacy bridge reservation role is invalid');
  if (expectedRole) assert(reservation.role === expectedRole, 'legacy bridge reservation role mismatch');
  assert(reservation.platform === 'windows-x64', 'legacy bridge reservation platform is invalid');
  assert(/^sha256:[a-f0-9]{64}$/u.test(reservation.bridge_transaction_id || ''), 'legacy bridge reservation transaction is invalid');
  assert(/^[a-f0-9]{40}$/u.test(reservation.source_head_sha || ''), 'legacy bridge reservation source SHA is invalid');
  validateWindowsSigningPolicy(reservation.windows_signing_policy);
  assert(envelope.reservation_id === contentId(reservation), 'legacy bridge reservation content hash is invalid');
  return structuredClone(envelope);
}

function validateArbitration(envelope) {
  assert(envelope?.schema === RELEASE_TAG_ARBITRATION_SCHEMA, 'release tag arbitration schema is unsupported');
  const arbitration = envelope.arbitration;
  assert(
    ['normal_release', 'windows_legacy_bridge', 'windows_legacy_target'].includes(arbitration?.role),
    'release tag arbitration role is invalid',
  );
  assert(typeof arbitration.tag === 'string' && arbitration.tag.startsWith('v'), 'release tag arbitration tag is invalid');
  assert(/^sha256:[a-f0-9]{64}$/u.test(arbitration.transaction_id || ''), 'release tag arbitration transaction is invalid');
  if (arbitration.role !== 'normal_release') {
    const expectedRole = arbitration.role === 'windows_legacy_bridge' ? 'bridge' : 'target';
    const reservation = validateReservation(arbitration.reservation, expectedRole);
    assert(reservation.reservation.bridge_transaction_id === arbitration.transaction_id, 'release tag arbitration reservation transaction mismatch');
  } else {
    assert(arbitration.reservation === undefined, 'normal release arbitration cannot contain a bridge reservation');
  }
  assert(envelope.arbitration_id === contentId(arbitration), 'release tag arbitration content hash is invalid');
  return structuredClone(envelope);
}

function putReservation(env, key, envelope, dependencies = {}) {
  const runCommand = dependencies.run || run;
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  mkdirSync(env.RUNNER_TEMP, { recursive: true });
  const filePath = path.join(env.RUNNER_TEMP, `bridge-reservation-put-${process.pid}-${digest(key).slice(0, 12)}.json`);
  writeFileSync(filePath, body, { mode: 0o600 });
  const result = runCommand('aws', [
    's3api', 'put-object', '--bucket', env.R2_BUCKET, '--key', key,
    '--body', filePath, '--endpoint-url', env.R2_ENDPOINT,
    '--content-type', 'application/json', '--cache-control', 'no-store',
    '--metadata', `sha256=${digest(body)}`, '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', digest(body, 'base64'), '--if-none-match', '*', '--output', 'json',
  ], { allowFailure: true });
  const stored = readObject(env, key, dependencies);
  assert(stored, `legacy bridge reservation write failed: ${key}`);
  assert(canonicalJson(stored) === canonicalJson(envelope), `legacy bridge reservation conflict: ${key}`);
  assert(result.status === 0 || stored.reservation_id === envelope.reservation_id, `legacy bridge reservation was not proven: ${key}`);
}

function createOrReadArbitration(env, desired, dependencies = {}) {
  const runCommand = dependencies.run || run;
  const key = arbitrationKey(desired.arbitration.tag);
  const body = `${JSON.stringify(desired, null, 2)}\n`;
  const filePath = path.join(env.RUNNER_TEMP, `tag-arbitration-${process.pid}-${digest(key).slice(0, 12)}.json`);
  writeFileSync(filePath, body, { mode: 0o600 });
  const result = runCommand('aws', [
    's3api', 'put-object', '--bucket', env.R2_BUCKET, '--key', key,
    '--body', filePath, '--endpoint-url', env.R2_ENDPOINT,
    '--content-type', 'application/json', '--cache-control', 'no-store',
    '--metadata', `sha256=${digest(body)}`, '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', digest(body, 'base64'), '--if-none-match', '*', '--output', 'json',
  ], { allowFailure: true });
  const stored = validateArbitration(readObject(env, key, dependencies));
  assert(result.status === 0 || stored, `release tag arbitration write failed: ${key}`);
  return stored;
}

function assertTargetTransactionMatchesReservation(transaction, arbitration) {
  const reservation = arbitration.arbitration.reservation.reservation;
  const requirement = transaction.intent.windows_legacy_bridge;
  assert(transaction.intent.requested_platforms.includes('windows-x64'), 'reserved Windows bridge target requires the Windows lane');
  assert(requirement, 'reserved Windows bridge target omitted its compatibility requirement');
  assert(transaction.intent.release.tag === reservation.target_tag, 'reserved Windows target tag mismatch');
  assert(
    transaction.intent.source?.repository === 'daymade/flowzero'
      && transaction.intent.source.head_sha === reservation.source_head_sha,
    'reserved Windows target transaction source does not match the exact shared source SHA',
  );
  assert(requirement.bridge_tag === reservation.bridge_tag, 'reserved Windows target bridge tag mismatch');
  assert(
    transaction.intent.windows_signing_policy === reservation.windows_signing_policy,
    'reserved Windows target signing policy mismatch',
  );
  assert(canonicalJson(requirement.affected_versions) === canonicalJson(reservation.affected_versions), 'reserved Windows target affected versions mismatch');
}

export function claimNormalReleaseTagArbitration(transaction, {
  env: envInput = process.env,
  ...dependencies
} = {}) {
  const env = requiredEnvironment(envInput);
  const desired = buildArbitration({
    role: 'normal_release',
    tag: transaction.intent.release.tag,
    transactionId: transaction.transaction_id,
  });
  const stored = createOrReadArbitration(env, desired, dependencies);
  const role = stored.arbitration.role;
  if (role === 'normal_release') {
    assert(stored.arbitration.transaction_id === transaction.transaction_id, 'release tag is already arbitrated to another normal transaction');
    return { status: 'normal_owner', arbitration: stored };
  }
  assert(role === 'windows_legacy_target', 'reserved Windows bridge tag cannot enter a normal release transaction');
  assertTargetTransactionMatchesReservation(transaction, stored);
  return { status: 'reserved_target', arbitration: stored };
}

export function reserveLegacyBridgeIntent(intentInput, { env: envInput = process.env, ...dependencies } = {}) {
  const env = requiredEnvironment(envInput);
  const intent = validateLegacyBridgeIntent(intentInput);
  for (const tag of [intent.bridge.tag, intent.target.tag]) {
    assert(!resolveHead(env, `release-control/releases/${tag}/owner.json`, dependencies), `legacy bridge reserved tag already has a normal release owner: ${tag}`);
    assert(
      !resolveHead(env, `channels/${intent.bridge.channel}/platforms/windows-x64/releases/${tag}.json`, dependencies),
      `legacy bridge reserved tag already has a published Windows manifest: ${tag}`,
    );
  }
  const bridge = buildReservation(intent, 'bridge');
  const target = buildReservation(intent, 'target');
  const targetArbitration = createOrReadArbitration(env, buildArbitration({
    role: 'windows_legacy_target',
    tag: intent.target.tag,
    transactionId: intent.transaction_id,
    reservation: target,
  }), dependencies);
  assert(targetArbitration.arbitration.role === 'windows_legacy_target', 'planned target tag is already arbitrated outside the bridge lane');
  assert(targetArbitration.arbitration.transaction_id === intent.transaction_id, 'planned target tag is reserved by another bridge transaction');
  const bridgeArbitration = createOrReadArbitration(env, buildArbitration({
    role: 'windows_legacy_bridge',
    tag: intent.bridge.tag,
    transactionId: intent.transaction_id,
    reservation: bridge,
  }), dependencies);
  assert(bridgeArbitration.arbitration.role === 'windows_legacy_bridge', 'bridge tag is already arbitrated outside the bridge lane');
  assert(bridgeArbitration.arbitration.transaction_id === intent.transaction_id, 'bridge tag is reserved by another transaction');
  for (const tag of [intent.bridge.tag, intent.target.tag]) {
    assert(!resolveHead(env, `release-control/releases/${tag}/owner.json`, dependencies), `legacy bridge reserved tag gained a normal release owner: ${tag}`);
  }
  putReservation(env, reservationKey('bridge', intent.bridge.tag), bridge, dependencies);
  putReservation(env, reservationKey('target', intent.target.tag), target, dependencies);
  return { bridge, target, bridgeArbitration, targetArbitration };
}

export function assertReleaseCandidateReservations(candidateEnvelope, {
  env: envInput = process.env,
  ...dependencies
} = {}) {
  const env = requiredEnvironment(envInput);
  const candidate = candidateEnvelope.candidate;
  if (candidate.platform && candidate.platform !== 'windows-x64') {
    return { status: 'not_applicable' };
  }
  const bridgeReservation = readObject(env, reservationKey('bridge', candidate.release.tag), dependencies);
  assert(!bridgeReservation, 'reserved Windows bridge tag cannot enter the normal release lane');
  const targetReservationInput = readObject(env, reservationKey('target', candidate.release.tag), dependencies);
  const requirement = candidate.update?.windows_legacy_bridge;
  if (!targetReservationInput) {
    assert(requirement === undefined, 'Windows target declares a bridge without a durable target reservation');
    return { status: 'not_reserved' };
  }
  const targetReservation = validateReservation(targetReservationInput, 'target');
  assert(requirement, 'reserved Windows bridge target omitted its compatibility requirement');
  assert(
    candidate.source?.repository === 'daymade/flowzero'
      && candidate.source.head_sha === targetReservation.reservation.source_head_sha,
    'reserved Windows target candidate source does not match the exact shared source SHA',
  );
  assert(requirement.bridge_tag === targetReservation.reservation.bridge_tag, 'reserved Windows target bridge tag mismatch');
  assert(
    candidate.update?.windows_signing_policy === targetReservation.reservation.windows_signing_policy,
    'reserved Windows target candidate signing policy mismatch',
  );
  assert(canonicalJson(requirement.affected_versions) === canonicalJson(targetReservation.reservation.affected_versions), 'reserved Windows target affected versions mismatch');
  const holdKey = `channels/${candidate.release.channel}/platforms/windows-x64/legacy-bridges/${requirement.bridge_tag}/${requirement.bridge_hold_id.slice('sha256:'.length)}.json`;
  const hold = validateLegacyBridgeHold(readObject(env, holdKey, dependencies));
  assert(hold.hold.transaction_id === targetReservation.reservation.bridge_transaction_id, 'reserved Windows target hold transaction mismatch');
  assert(hold.hold.source_head_sha === targetReservation.reservation.source_head_sha, 'reserved Windows target hold source mismatch');
  assert(hold.hold.windows_signing_policy === targetReservation.reservation.windows_signing_policy, 'reserved Windows target hold signing policy mismatch');
  assert(hold.hold.target.tag === candidate.release.tag, 'reserved Windows target release mismatch');
  return { status: 'required', reservation_id: targetReservation.reservation_id, hold_id: hold.hold_id };
}

export function assertReleaseTransactionReservations(transaction, options = {}) {
  assert(transaction?.schema === 'flowzero.release_transaction.v1', 'release transaction schema is invalid for bridge reservation check');
  const env = requiredEnvironment(options.env || process.env);
  const tag = transaction.intent.release.tag;
  assert(
    !resolveHead(env, reservationKey('bridge', tag), options),
    'reserved Windows bridge tag cannot enter any normal release transaction',
  );
  const targetReserved = Boolean(resolveHead(env, reservationKey('target', tag), options));
  if (!transaction.intent.requested_platforms.includes('windows-x64')) {
    assert(!targetReserved, 'reserved Windows bridge target requires the Windows lane and exact compatibility requirement');
    return { status: 'not_applicable' };
  }
  return assertReleaseCandidateReservations({
    candidate: {
      platform: 'windows-x64',
      source: transaction.intent.source,
      release: transaction.intent.release,
      update: transaction.intent.windows_legacy_bridge
        ? {
            windows_legacy_bridge: transaction.intent.windows_legacy_bridge,
            windows_signing_policy: transaction.intent.windows_signing_policy,
          }
        : { windows_signing_policy: transaction.intent.windows_signing_policy },
    },
  }, options);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    assert(['--intent', '--transaction'].includes(key) && value && !values[key], `invalid argument: ${key || '<empty>'}`);
    values[key] = value;
  }
  assert(['reserve-intent', 'assert-transaction'].includes(command), `unsupported reservation command: ${command || '<empty>'}`);
  if (command === 'reserve-intent') assert(values['--intent'] && !values['--transaction'], 'reserve-intent requires only --intent');
  if (command === 'assert-transaction') assert(values['--transaction'] && !values['--intent'], 'assert-transaction requires only --transaction');
  return { command, values };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArguments(argv);
  const result = parsed.command === 'reserve-intent'
    ? reserveLegacyBridgeIntent(JSON.parse(readFileSync(path.resolve(parsed.values['--intent']), 'utf8')), { env })
    : assertReleaseTransactionReservations(
      JSON.parse(readFileSync(path.resolve(parsed.values['--transaction']), 'utf8')),
      { env },
    );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
