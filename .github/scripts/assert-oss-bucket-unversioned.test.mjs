import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOssBucketUnversioned } from './assert-oss-bucket-unversioned.mjs';

test('accepts only an OSS bucket that has never enabled versioning', () => {
  assert.equal(assertOssBucketUnversioned({}), true);
  assert.equal(assertOssBucketUnversioned({ Status: null }), true);
});

test('rejects enabled, suspended, unknown, and malformed versioning state', () => {
  assert.throws(() => assertOssBucketUnversioned({ Status: 'Enabled' }), /versioning is Enabled/);
  assert.throws(() => assertOssBucketUnversioned({ Status: 'Suspended' }), /versioning is Suspended/);
  assert.throws(() => assertOssBucketUnversioned({ Status: 'Disabled' }), /Unknown/);
  assert.throws(() => assertOssBucketUnversioned([]), /JSON object/);
});
