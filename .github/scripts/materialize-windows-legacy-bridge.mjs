#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { r2Head, run } from './mirror-release-assets.mjs';
import { validateCandidateEnvelope } from './release-platform-checkpoint.mjs';
import {
  validateLegacyBridgeCheckpoint,
  validateLegacyBridgeHold,
} from './windows-legacy-bridge-contract.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value, encoding = 'hex') {
  return createHash('sha256').update(value).digest(encoding);
}

function requiredEnvironment(env) {
  for (const name of [
    'RUNNER_TEMP',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
  ]) {
    assert(typeof env[name] === 'string' && env[name].trim(), `missing legacy bridge readback configuration: ${name}`);
  }
  return env;
}

function readImmutableObject(env, key, destination, expected = null, dependencies = {}) {
  const headObject = dependencies.r2Head || r2Head;
  const runCommand = dependencies.run || run;
  const head = headObject(env, key);
  assert(head, `trusted legacy bridge object is missing: ${key}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  runCommand('aws', [
    's3api', 'get-object',
    '--bucket', env.R2_BUCKET,
    '--key', key,
    '--if-match', head.ETag,
    '--endpoint-url', env.R2_ENDPOINT,
    '--checksum-mode', 'ENABLED',
    '--output', 'json',
    destination,
  ]);
  const bytes = readFileSync(destination);
  const digestHex = sha256(bytes);
  const digestBase64 = sha256(bytes, 'base64');
  assert(head.ContentLength === bytes.length, `trusted legacy bridge object size mismatch: ${key}`);
  assert(head.Metadata?.sha256 === digestHex, `trusted legacy bridge object metadata mismatch: ${key}`);
  assert(head.ChecksumSHA256 === digestBase64, `trusted legacy bridge object checksum mismatch: ${key}`);
  if (expected) {
    assert(bytes.length === expected.size, `legacy bridge asset size mismatch: ${expected.name}`);
    assert(digestHex === expected.sha256, `legacy bridge asset digest mismatch: ${expected.name}`);
  }
  return bytes;
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--target-candidate', '--output-dir']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(allowed.has(key) && value && !Object.hasOwn(values, key), `invalid argument: ${key || '<empty>'}`);
    values[key] = value;
  }
  for (const key of allowed) assert(values[key], `missing argument: ${key}`);
  return values;
}

export async function main(argv = process.argv.slice(2), envInput = process.env, dependencies = {}) {
  const args = parseArguments(argv);
  const env = requiredEnvironment(envInput);
  const target = validateCandidateEnvelope(
    JSON.parse(readFileSync(path.resolve(args['--target-candidate']), 'utf8')),
  );
  assert(target.candidate.platform === 'windows-x64', 'legacy bridge materialization target must be Windows');
  const requirement = target.candidate.update?.windows_legacy_bridge;
  assert(requirement, 'target candidate does not require a Windows legacy bridge');
  const outputDir = path.resolve(args['--output-dir']);
  if (existsSync(outputDir)) {
    assert(statSync(outputDir).isDirectory() && readdirSync(outputDir).length === 0, 'legacy bridge output directory must be empty');
  } else {
    mkdirSync(outputDir, { recursive: true });
  }
  const holdKey = `channels/${target.candidate.release.channel}/platforms/windows-x64/legacy-bridges/${requirement.bridge_tag}/${requirement.bridge_hold_id.slice('sha256:'.length)}.json`;
  const holdPath = path.join(outputDir, 'hold.json');
  const hold = validateLegacyBridgeHold(JSON.parse(
    readImmutableObject(env, holdKey, holdPath, null, dependencies).toString('utf8'),
  ));
  assert(hold.hold_id === requirement.bridge_hold_id, 'trusted legacy bridge hold id mismatch');
  assert(hold.hold.bridge.tag === requirement.bridge_tag, 'trusted legacy bridge tag mismatch');
  assert(JSON.stringify(hold.hold.affected_versions) === JSON.stringify(requirement.affected_versions), 'trusted legacy bridge affected versions mismatch');
  assert(hold.hold.target.version === target.candidate.release.version, 'trusted legacy bridge planned target mismatch');
  const checkpointKey = `channels/${target.candidate.release.channel}/platforms/windows-x64/legacy-bridges/${hold.hold.bridge.tag}/checkpoints/${hold.hold.checkpoint_id.slice('sha256:'.length)}.json`;
  const checkpointPath = path.join(outputDir, 'checkpoint.json');
  const checkpoint = validateLegacyBridgeCheckpoint(JSON.parse(
    readImmutableObject(env, checkpointKey, checkpointPath, null, dependencies).toString('utf8'),
  ));
  assert(checkpoint.checkpoint_id === hold.hold.checkpoint_id, 'trusted legacy bridge checkpoint id mismatch');
  assert(checkpoint.checkpoint.candidate_id === hold.hold.candidate_id, 'trusted legacy bridge checkpoint candidate mismatch');
  assert(checkpoint.checkpoint.candidate.candidate.source.head_sha === hold.hold.source_head_sha, 'trusted legacy bridge source mismatch');
  assert(JSON.stringify(checkpoint.checkpoint.candidate.candidate.assets) === JSON.stringify(hold.hold.assets), 'trusted legacy bridge asset manifest mismatch');
  const candidatePath = path.join(outputDir, 'candidate.json');
  writeFileSync(candidatePath, `${JSON.stringify(checkpoint.checkpoint.candidate, null, 2)}\n`, 'utf8');
  const assetRoot = path.join(outputDir, 'assets');
  mkdirSync(assetRoot, { recursive: true });
  for (const asset of hold.hold.assets) {
    readImmutableObject(
      env,
      `${hold.hold.asset_namespace}/assets/${asset.name}`,
      path.join(assetRoot, asset.name),
      asset,
      dependencies,
    );
  }
  process.stdout.write(`${hold.hold_id}\n`);
  return { hold, checkpoint, candidate: checkpoint.checkpoint.candidate, assetRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
