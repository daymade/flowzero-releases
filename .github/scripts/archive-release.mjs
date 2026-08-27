#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertCurrentReleaseTagAllowed } from './check-current-release-tombstone.mjs';
import { validateReleaseArchiveManifest } from './build-release-archive-manifest.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function ghJson(args, options) {
  const result = run('gh', args, options);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub API did not return JSON: ${error.message}`);
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function expectedArchiveAssets(manifest, assetRoot, manifestPath) {
  assert(manifest?.schema === 'flowzero.release_archive_manifest.v1', 'archive manifest schema is invalid');
  const expected = manifest.archive.platforms.flatMap((platform) => platform.candidate.candidate.assets.map((asset) => ({
    ...asset,
    filePath: path.join(assetRoot, asset.name),
  })));
  expected.push({
    role: 'release_manifest',
    name: 'release-manifest.json',
    content_type: 'application/json',
    size: statSync(manifestPath).size,
    sha256: sha256File(manifestPath),
    filePath: manifestPath,
  });
  const names = expected.map((asset) => asset.name);
  assert(new Set(names).size === names.length, 'archive asset names are duplicated');
  const actual = readdirSync(assetRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== 'release-manifest.json')
    .map((entry) => {
      assert(entry.isFile(), `archive root contains a non-file entry: ${entry.name}`);
      return entry.name;
    })
    .sort();
  const expectedBinaryNames = expected.filter((asset) => asset.role !== 'release_manifest').map((asset) => asset.name).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expectedBinaryNames), 'archive root does not exactly match release manifest assets');
  for (const asset of expected) {
    assert(existsSync(asset.filePath) && statSync(asset.filePath).isFile(), `archive file is missing: ${asset.name}`);
    assert(statSync(asset.filePath).size === asset.size, `archive file size changed: ${asset.name}`);
    assert(sha256File(asset.filePath) === asset.sha256, `archive file digest changed: ${asset.name}`);
  }
  return expected;
}

function parseGitHubJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

export function getReleaseById(repository, releaseId, { runCommand = run } = {}) {
  assert(Number.isInteger(releaseId) && releaseId > 0, 'GitHub release ID is invalid');
  const result = runCommand('gh', ['api', `repos/${repository}/releases/${releaseId}`]);
  return parseGitHubJson(result, `GitHub release ${releaseId}`);
}

export function getRelease(repository, tag, { runCommand = run } = {}) {
  const result = runCommand('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { allowFailure: true });
  if (result.status === 0) return JSON.parse(result.stdout);
  const detail = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (/HTTP 404|Not Found/iu.test(detail)) {
    const listResult = runCommand('gh', ['api', `repos/${repository}/releases?per_page=100`]);
    const releases = parseGitHubJson(listResult, 'GitHub release list');
    assert(Array.isArray(releases), 'GitHub release list is invalid');
    const matches = releases.filter((entry) => entry?.tag_name === tag);
    assert(matches.length <= 1, `multiple GitHub releases found for ${tag}`);
    return matches[0] || null;
  }
  throw new Error(`cannot query release ${tag}: ${detail.trim()}`);
}

function createDraft(repository, manifest, notes) {
  const tag = manifest.archive.release.tag;
  return ghJson([
    'api', '--method', 'POST', `repos/${repository}/releases`, '--input', '-',
  ], {
    input: JSON.stringify({
      tag_name: tag,
      target_commitish: manifest.archive.release_infrastructure.release_infrastructure_sha,
      name: `Flowzero ${tag}`,
      body: notes,
      draft: true,
      prerelease: manifest.archive.release.channel === 'beta',
    }),
  });
}

export function assertImmutableReleasePolicy(settings) {
  assert(settings?.enabled === true, 'GitHub repository immutable releases are not enabled');
  return settings;
}

async function readImmutableReleasePolicy(repository, token, fetchImplementation = globalThis.fetch) {
  assert(typeof token === 'string' && token.trim(), 'GITHUB_ADMIN_TOKEN is required to verify immutable release policy');
  const response = await fetchImplementation(
    `https://api.github.com/repos/${repository}/immutable-releases`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
      },
      cache: 'no-store',
    },
  );
  assert(response.ok, `cannot verify GitHub immutable release policy: HTTP ${response.status}`);
  return assertImmutableReleasePolicy(await response.json());
}

export function assertReleaseIdentity(release, manifest, { expectedDraft, expectedImmutable } = {}) {
  assert(release.tag_name === manifest.archive.release.tag, 'GitHub release tag mismatch');
  assert(
    release.target_commitish === manifest.archive.release_infrastructure.release_infrastructure_sha,
    'GitHub release target commit does not match frozen release infrastructure',
  );
  assert(Boolean(release.prerelease) === (manifest.archive.release.channel === 'beta'), 'GitHub release channel mismatch');
  if (typeof expectedDraft === 'boolean') {
    assert(release.draft === expectedDraft, `GitHub release draft state mismatch: expected ${expectedDraft}`);
  }
  if (typeof expectedImmutable === 'boolean') {
    assert(release.immutable === expectedImmutable, `GitHub release immutable state mismatch: expected ${expectedImmutable}`);
  }
}

export function verifyReleaseAssets(release, expected) {
  assert(Array.isArray(release.assets), 'GitHub release assets are missing');
  assert(release.assets.length === expected.length, 'GitHub release asset count mismatch');
  for (const asset of expected) {
    const remote = release.assets.find((entry) => entry.name === asset.name);
    assert(remote, `GitHub release asset is missing: ${asset.name}`);
    assert(remote.state === 'uploaded', `GitHub release asset is not uploaded: ${asset.name}`);
    assert(remote.size === asset.size, `GitHub release asset size mismatch: ${asset.name}`);
    assert(remote.digest === `sha256:${asset.sha256}`, `GitHub release asset digest mismatch: ${asset.name}`);
  }
  return createHash('sha256').update(expected
    .map((asset) => `${asset.name}\t${asset.size}\t${asset.sha256}\n`)
    .sort()
    .join('')).digest('hex');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--manifest', '--asset-root', '--notes-file'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--manifest', '--asset-root']) if (!values[key]) throw new Error(`missing argument: ${key}`);
  return values;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArguments(argv);
  const repository = env.GITHUB_REPOSITORY;
  assert(repository === 'daymade/flowzero-releases', 'archive job is running in the wrong repository');
  const manifestPath = path.resolve(args['--manifest']);
  const assetRoot = path.resolve(args['--asset-root']);
  const manifest = validateReleaseArchiveManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const expected = expectedArchiveAssets(manifest, assetRoot, manifestPath);
  const notes = args['--notes-file']
    ? readFileSync(path.resolve(args['--notes-file']), 'utf8')
    : [
      `Flowzero ${manifest.archive.release.tag}`,
      '',
      `Qualified platforms: ${manifest.archive.platforms.map((entry) => entry.platform).join(', ')}`,
      `Source: ${manifest.archive.source.repository}@${manifest.archive.source.head_sha}`,
    ].join('\n');
  const tag = manifest.archive.release.tag;
  await assertCurrentReleaseTagAllowed({
    tag,
    token: env.GITHUB_TOKEN || '',
    repository,
  });
  await readImmutableReleasePolicy(repository, env.GITHUB_ADMIN_TOKEN || '');
  let release = getRelease(repository, tag);
  if (!release) release = createDraft(repository, manifest, notes);
  assertReleaseIdentity(release, manifest);
  let draftFingerprint = null;
  if (release.draft) {
    assertReleaseIdentity(release, manifest, { expectedDraft: true, expectedImmutable: false });
    for (const asset of expected) {
      const remote = release.assets?.find((entry) => entry.name === asset.name);
      if (remote) {
        assert(remote.size === asset.size && remote.digest === `sha256:${asset.sha256}`, `draft asset conflict: ${asset.name}`);
        continue;
      }
      run('gh', ['release', 'upload', tag, asset.filePath, '--repo', repository]);
    }
    release = getReleaseById(repository, release.id);
    assertReleaseIdentity(release, manifest, { expectedDraft: true, expectedImmutable: false });
    draftFingerprint = verifyReleaseAssets(release, expected);
    ghJson([
      'api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`, '--input', '-',
    ], { input: JSON.stringify({ draft: false }) });
    release = getReleaseById(repository, release.id);
  }
  assertReleaseIdentity(release, manifest, { expectedDraft: false, expectedImmutable: true });
  const liveFingerprint = verifyReleaseAssets(release, expected);
  if (draftFingerprint) assert(draftFingerprint === liveFingerprint, 'GitHub release assets changed during publication');
  run('gh', ['release', 'verify', tag, '--repo', repository]);
  process.stdout.write(`archived immutable release ${tag}\n`);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
