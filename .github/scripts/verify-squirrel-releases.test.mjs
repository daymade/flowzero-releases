import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { verifySquirrelReleases } from './verify-squirrel-releases.mjs';

const nupkgName = 'Flowzero-1.2.3-full.nupkg';
const nupkgBytes = Buffer.from('real squirrel package bytes', 'utf8');
const sha1 = createHash('sha1').update(nupkgBytes).digest('hex');
const valid = `${sha1} ${nupkgName} ${nupkgBytes.length}\n`;

test('accepts one exact Squirrel record bound to actual nupkg bytes', () => {
  assert.deepEqual(verifySquirrelReleases({ releasesText: valid, nupkgName, nupkgBytes }), {
    name: nupkgName,
    size: nupkgBytes.length,
    sha1,
  });
});

test('rejects substring names, bad hash, bad size, and extra records', () => {
  assert.throws(() => verifySquirrelReleases({
    releasesText: `${sha1} wrong-${nupkgName} ${nupkgBytes.length}\n`,
    nupkgName,
    nupkgBytes,
  }), /filename does not exactly match/u);
  assert.throws(() => verifySquirrelReleases({
    releasesText: `${'0'.repeat(40)} ${nupkgName} ${nupkgBytes.length}\n`,
    nupkgName,
    nupkgBytes,
  }), /SHA-1 does not match/u);
  assert.throws(() => verifySquirrelReleases({
    releasesText: `${sha1} ${nupkgName} ${nupkgBytes.length + 1}\n`,
    nupkgName,
    nupkgBytes,
  }), /size does not match/u);
  assert.throws(() => verifySquirrelReleases({
    releasesText: `${sha1} ${nupkgName} 0${nupkgBytes.length}\n`,
    nupkgName,
    nupkgBytes,
  }), /size does not match/u);
  assert.throws(() => verifySquirrelReleases({
    releasesText: `${valid}${valid}`,
    nupkgName,
    nupkgBytes,
  }), /exactly one/u);
});
