import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertChannelVersionForward,
  parseChannelVersion,
} from './assert-channel-version-forward.mjs';

const current = (channel, tag, state = 'published') => ({
  schema: 'flowzero.update_channel_manifest.v1',
  channel,
  state,
  ...(state === 'published' ? { tag } : {}),
});

test('parses only the project stable and beta version contracts', () => {
  assert.deepEqual(parseChannelVersion('v1.2.3', 'stable'), [1, 2, 3]);
  assert.deepEqual(parseChannelVersion('v1.2.3-beta.45', 'beta'), [1, 2, 3, 45]);
  assert.throws(() => parseChannelVersion('v1.2.3-beta.1', 'stable'), /contract/u);
  assert.throws(() => parseChannelVersion('v1.2.3-rc.1', 'beta'), /canonical/u);
});

test('allows forward and idempotent promotion but blocks downgrade', () => {
  assert.equal(assertChannelVersionForward({
    channel: 'stable',
    targetTag: 'v1.3.0',
    currentManifest: current('stable', 'v1.2.9'),
  }).status, 'forward');
  assert.equal(assertChannelVersionForward({
    channel: 'beta',
    targetTag: 'v1.3.0-beta.8',
    currentManifest: current('beta', 'v1.3.0-beta.8'),
  }).status, 'idempotent');
  assert.throws(() => assertChannelVersionForward({
    channel: 'stable',
    targetTag: 'v1.2.0',
    currentManifest: current('stable', 'v1.3.0'),
  }), /Refusing channel downgrade/u);
});

test('allows only an explicit downgrade and validates current manifest identity', () => {
  assert.equal(assertChannelVersionForward({
    channel: 'beta',
    targetTag: 'v1.2.0-beta.9',
    currentManifest: current('beta', 'v1.3.0-beta.1'),
    allowDowngrade: true,
  }).status, 'explicit_downgrade');
  assert.throws(() => assertChannelVersionForward({
    channel: 'stable',
    targetTag: 'v1.3.0',
    currentManifest: current('beta', 'v1.2.0-beta.1'),
  }), /identity/u);
  assert.equal(assertChannelVersionForward({
    channel: 'stable',
    targetTag: 'v1.0.0',
    currentManifest: current('stable', null, 'no_release'),
  }).status, 'replacing_no_release');
});
