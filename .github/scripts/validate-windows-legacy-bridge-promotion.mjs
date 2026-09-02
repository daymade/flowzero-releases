#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCandidateEnvelope } from './release-platform-checkpoint.mjs';
import {
  validateLegacyBridgeCompatibilityBinding,
  validateLegacyBridgeHold,
} from './windows-legacy-bridge-contract.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertWindowsLegacyBridgePromotionReady({
  candidate: rawCandidate,
  binding = null,
  hold = null,
}) {
  const candidate = validateCandidateEnvelope(rawCandidate);
  const requirement = candidate.candidate.platform === 'windows-x64'
    ? candidate.candidate.update?.windows_legacy_bridge
    : undefined;
  if (requirement === undefined) {
    assert(binding === null && hold === null, 'unexpected Windows legacy bridge evidence for an unbound target');
    return { status: 'not_required', current_pointer_cas_count: 1 };
  }
  assert(binding !== null, 'Windows target requires a legacy bridge compatibility binding');
  assert(hold !== null, 'Windows target requires the exact legacy bridge hold');
  const validatedHold = validateLegacyBridgeHold(hold);
  assert(validatedHold.hold_id === requirement.bridge_hold_id, 'Windows target bridge hold id mismatch');
  const validatedBinding = validateLegacyBridgeCompatibilityBinding(binding, {
    hold: validatedHold,
    targetCandidate: candidate,
  });
  assert(validatedBinding.binding.promotion_plan.current_pointer_cas_count === 1, 'Windows legacy bridge binding must permit exactly one current CAS');
  return {
    status: 'pass',
    binding_id: validatedBinding.binding_id,
    bridge_hold_id: validatedHold.hold_id,
    current_pointer_cas_count: 1,
  };
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--candidate', '--binding', '--hold']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(allowed.has(key) && value && !Object.hasOwn(values, key), `invalid argument: ${key || '<empty>'}`);
    values[key] = value;
  }
  assert(values['--candidate'], 'missing argument: --candidate');
  assert(Boolean(values['--binding']) === Boolean(values['--hold']), '--binding and --hold must be supplied together');
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const readJson = async (filePath) => JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
  const result = assertWindowsLegacyBridgePromotionReady({
    candidate: await readJson(args['--candidate']),
    binding: args['--binding'] ? await readJson(args['--binding']) : null,
    hold: args['--hold'] ? await readJson(args['--hold']) : null,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
