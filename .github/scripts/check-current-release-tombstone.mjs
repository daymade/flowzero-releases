#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertReleaseTagAllowed,
  parseReleaseTombstones,
} from './check-release-tombstone.mjs';

const REPOSITORY = 'daymade/flowzero-releases';
const POLICY_PATH = '.github/release-tombstones.json';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function fetchCurrentReleaseTombstonePolicy({
  token,
  repository = REPOSITORY,
  fetchImplementation = globalThis.fetch,
}) {
  assert(repository === REPOSITORY, `unexpected release repository: ${repository}`);
  assert(typeof token === 'string' && token.trim(), 'GITHUB_TOKEN is required for current tombstone lookup');
  assert(typeof fetchImplementation === 'function', 'fetch implementation is unavailable');
  const url = new URL(`https://api.github.com/repos/${repository}/contents/${POLICY_PATH}`);
  url.searchParams.set('ref', 'main');
  url.searchParams.set('run', `${process.env.GITHUB_RUN_ID || 'manual'}-${Date.now()}`);
  const response = await fetchImplementation(url, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`cannot read current main tombstone policy: HTTP ${response.status}`);
  }
  const raw = await response.text();
  const source = `${repository}@main:${POLICY_PATH}`;
  const policy = parseReleaseTombstones(raw, source);
  return policy;
}

export async function assertCurrentReleaseTagAllowed(options) {
  const policy = await fetchCurrentReleaseTombstonePolicy(options);
  assertReleaseTagAllowed(policy, options.tag);
  return policy;
}

export async function assertCurrentReleaseTagWithdrawn(options) {
  const policy = await fetchCurrentReleaseTombstonePolicy(options);
  const tombstone = policy.releases.find((entry) => entry.tag === options.tag);
  assert(tombstone, `Release tag ${options.tag} is not present in the current tombstone policy`);
  return tombstone;
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--tag' || !argv[1]) {
    throw new Error('Usage: check-current-release-tombstone.mjs --tag <tag>');
  }
  return { tag: argv[1] };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { tag } = parseArguments(argv);
  await assertCurrentReleaseTagAllowed({
    tag,
    token: env.GITHUB_TOKEN || '',
    repository: env.GITHUB_REPOSITORY || '',
  });
  process.stdout.write(`Current main tombstone policy allows ${tag}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Current tombstone gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
