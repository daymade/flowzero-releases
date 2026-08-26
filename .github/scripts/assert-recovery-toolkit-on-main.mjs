#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function defaultRunGit(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

export function assertRecoveryToolkitOnMain({ toolkitSha, mainSha, runGit = defaultRunGit }) {
  assert(/^[a-f0-9]{40}$/.test(toolkitSha || ''), 'recovery toolkit SHA is invalid');
  assert(/^[a-f0-9]{40}$/.test(mainSha || ''), 'trusted main SHA is invalid');

  const object = runGit(['cat-file', '-e', `${toolkitSha}^{commit}`]);
  assert(
    !object.error && object.status === 0,
    `recovery toolkit commit is unavailable: ${(object.stderr || object.error?.message || '').trim()}`,
  );
  const ancestry = runGit(['merge-base', '--is-ancestor', toolkitSha, mainSha]);
  if (ancestry.error || ![0, 1].includes(ancestry.status)) {
    throw new Error(
      `unable to verify recovery toolkit ancestry: ${(ancestry.stderr || ancestry.error?.message || '').trim()}`,
    );
  }
  assert(ancestry.status === 0, 'recovery toolkit SHA is not an ancestor of trusted main');
  return { toolkit_sha: toolkitSha, trusted_main_sha: mainSha };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--toolkit-sha', '--main-sha'].includes(key) || !value || values[key]) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--toolkit-sha', '--main-sha']) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const result = assertRecoveryToolkitOnMain({
    toolkitSha: args['--toolkit-sha'],
    mainSha: args['--main-sha'],
  });
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
