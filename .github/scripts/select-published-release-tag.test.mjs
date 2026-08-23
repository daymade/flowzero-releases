import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPublishedReleaseTag } from './select-published-release-tag.mjs';

test('finds a target channel release beyond the first 100 entries', () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    tag_name: `v2.0.0-beta.${100 - index}`,
    draft: false,
    prerelease: true,
  }));
  const secondPage = [{
    tag_name: 'v1.9.0',
    draft: false,
    prerelease: false,
  }];

  assert.equal(selectPublishedReleaseTag([firstPage, secondPage], 'stable'), 'v1.9.0');
  assert.equal(selectPublishedReleaseTag([firstPage, secondPage], 'beta'), 'v2.0.0-beta.100');
});

test('ignores drafts, returns empty for no release, and rejects malformed pages', () => {
  assert.equal(selectPublishedReleaseTag([[{
    tag_name: 'v1.0.0',
    draft: true,
    prerelease: false,
  }]], 'stable'), '');
  assert.equal(selectPublishedReleaseTag([[]], 'beta'), '');
  assert.throws(() => selectPublishedReleaseTag([], 'preview'), /stable or beta/u);
  assert.throws(() => selectPublishedReleaseTag([{}], 'stable'), /page arrays/u);
  assert.throws(() => selectPublishedReleaseTag([[null]], 'stable'), /entry must be an object/u);
});
