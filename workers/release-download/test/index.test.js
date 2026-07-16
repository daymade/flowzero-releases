import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest, parseSingleRange } from '../src/index.js';

const KEY = 'releases/v0.1.2-beta.5/Flowzero.zip';
const IMMUTABLE_CHANNEL_KEY =
  'channels/beta/releases/v0.1.2-beta.7.json';
const IMMUTABLE_CHANNEL_STATE_KEY =
  'channels/stable/states/no-release.json';
const CURRENT_CHANNEL_KEY = 'channels/beta/current.json';

function makeObject(body = 'release') {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    httpEtag: '"etag"',
    size: body.length,
    writeHttpMetadata(headers) {
      headers.set('Content-Type', 'application/zip');
    },
  };
}

function makeEnvironment() {
  const calls = [];
  const object = makeObject();
  return {
    calls,
    env: {
      RELEASES: {
        async get(key, options) {
          calls.push(['get', key, options]);
          return object;
        },
        async head(key) {
          calls.push(['head', key]);
          return object;
        },
      },
    },
  };
}

test('parses bounded, open, and suffix byte ranges', () => {
  assert.deepEqual(parseSingleRange('bytes=1-3', 8), { offset: 1, length: 3 });
  assert.deepEqual(parseSingleRange('bytes=4-', 8), { offset: 4, length: 4 });
  assert.deepEqual(parseSingleRange('bytes=-3', 8), { offset: 5, length: 3 });
  assert.equal(parseSingleRange('bytes=8-', 8), null);
  assert.equal(parseSingleRange('bytes=1-2,4-5', 8), null);
});

test('serves immutable release objects with full response metadata', async () => {
  const { calls, env } = makeEnvironment();
  const response = await handleRequest(new Request(`https://example.test/${KEY}`), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('Content-Length'), '7');
  assert.equal(await response.text(), 'release');
  assert.deepEqual(calls, [['get', KEY, undefined]]);
});

test('serves immutable release, immutable state, and current channel snapshots with distinct cache policy', async () => {
  const immutableEnvironment = makeEnvironment();
  const immutable = await handleRequest(
    new Request(`https://example.test/${IMMUTABLE_CHANNEL_KEY}`),
    immutableEnvironment.env,
  );
  const immutableStateEnvironment = makeEnvironment();
  const immutableState = await handleRequest(
    new Request(`https://example.test/${IMMUTABLE_CHANNEL_STATE_KEY}`),
    immutableStateEnvironment.env,
  );
  const currentEnvironment = makeEnvironment();
  const current = await handleRequest(
    new Request(`https://example.test/${CURRENT_CHANNEL_KEY}?promotion=test`),
    currentEnvironment.env,
  );

  assert.equal(immutable.status, 200);
  assert.equal(
    immutable.headers.get('Cache-Control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(immutableState.status, 200);
  assert.equal(
    immutableState.headers.get('Cache-Control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(current.status, 200);
  assert.equal(
    current.headers.get('Cache-Control'),
    'public, max-age=0, must-revalidate, stale-if-error=86400',
  );
  assert.deepEqual(
    immutableEnvironment.calls,
    [['get', IMMUTABLE_CHANNEL_KEY, undefined]],
  );
  assert.deepEqual(
    immutableStateEnvironment.calls,
    [['get', IMMUTABLE_CHANNEL_STATE_KEY, undefined]],
  );
  assert.deepEqual(
    currentEnvironment.calls,
    [['get', CURRENT_CHANNEL_KEY, undefined]],
  );
});

test('serves HEAD without reading the object body', async () => {
  const { calls, env } = makeEnvironment();
  const response = await handleRequest(
    new Request(`https://example.test/${KEY}`, { method: 'HEAD' }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '7');
  assert.equal(await response.text(), '');
  assert.deepEqual(calls, [['head', KEY]]);
});

test('serves one byte range with RFC response headers', async () => {
  const { calls, env } = makeEnvironment();
  const response = await handleRequest(
    new Request(`https://example.test/${KEY}`, { headers: { Range: 'bytes=1-3' } }),
    env,
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Content-Range'), 'bytes 1-3/7');
  assert.deepEqual(calls, [
    ['head', KEY],
    ['get', KEY, { range: { offset: 1, length: 3 } }],
  ]);
});

test('rejects non-release paths and write methods', async () => {
  const { calls, env } = makeEnvironment();
  const missing = await handleRequest(new Request('https://example.test/private/file'), env);
  const write = await handleRequest(
    new Request(`https://example.test/${KEY}`, { method: 'PUT', body: 'x' }),
    env,
  );
  const invalidChannelPath = await handleRequest(
    new Request('https://example.test/channels/beta/private.json'),
    env,
  );
  const invalidChannelState = await handleRequest(
    new Request('https://example.test/channels/stable/states/published.json'),
    env,
  );

  assert.equal(missing.status, 404);
  assert.equal(write.status, 405);
  assert.equal(invalidChannelPath.status, 404);
  assert.equal(invalidChannelState.status, 404);
  assert.deepEqual(calls, []);
});
