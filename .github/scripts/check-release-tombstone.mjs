#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POLICY_PATH = path.resolve(
  SCRIPT_DIR,
  '..',
  'release-tombstones.json'
);

const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/;
const WITHDRAWAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REASON_PATTERN = /^[a-z0-9_]+$/;

export function parseReleaseTombstones(raw, source = '<release-tombstones>') {
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid release tombstone JSON in ${source}: ${error.message}`);
  }

  if (policy?.schema !== 'flowzero.withdrawn_release_tombstones.v1') {
    throw new Error(`Unsupported release tombstone schema in ${source}`);
  }
  if (!Array.isArray(policy.releases)) {
    throw new Error(`release tombstone policy must contain a releases array: ${source}`);
  }

  const seenTags = new Set();
  for (const [index, release] of policy.releases.entries()) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      throw new Error(`Invalid release tombstone entry at ${source}:releases[${index}]`);
    }
    if (!RELEASE_TAG_PATTERN.test(release.tag || '')) {
      throw new Error(`Invalid release tombstone tag at ${source}:releases[${index}]`);
    }
    if (!WITHDRAWAL_DATE_PATTERN.test(release.withdrawn_on || '')) {
      throw new Error(`Invalid withdrawal date at ${source}:releases[${index}]`);
    }
    if (!REASON_PATTERN.test(release.reason || '')) {
      throw new Error(`Invalid withdrawal reason at ${source}:releases[${index}]`);
    }
    if (seenTags.has(release.tag)) {
      throw new Error(`Duplicate release tombstone tag in ${source}: ${release.tag}`);
    }
    seenTags.add(release.tag);
  }

  return policy;
}

export function assertReleaseTagAllowed(policy, tag) {
  if (!RELEASE_TAG_PATTERN.test(tag || '')) {
    throw new Error(`Invalid release tag: ${tag || '<empty>'}`);
  }

  const tombstone = policy.releases.find((release) => release.tag === tag);
  if (tombstone) {
    throw new Error(
      `Release tag ${tag} is permanently withdrawn ` +
      `(${tombstone.withdrawn_on}; reason=${tombstone.reason}) and must never be published or promoted again`
    );
  }
}

export function checkReleaseTag({
  tag,
  policyPath = DEFAULT_POLICY_PATH
}) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  const policy = parseReleaseTombstones(raw, policyPath);
  assertReleaseTagAllowed(policy, tag);
}

function parseArguments(argv) {
  let tag = '';
  let policyPath = DEFAULT_POLICY_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--tag') {
      tag = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (argument === '--policy') {
      policyPath = path.resolve(argv[index + 1] || '');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!tag) {
    throw new Error('Missing required --tag');
  }

  return { tag, policyPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    checkReleaseTag(options);
    console.log(`Release tag is not withdrawn: ${options.tag}`);
  } catch (error) {
    console.error(`Release tombstone gate failed: ${error.message}`);
    process.exit(1);
  }
}
