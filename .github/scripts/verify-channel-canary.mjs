#!/usr/bin/env node

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CANARY_RECEIPT_SCHEMA = 'flowzero.update_channel_canary_receipt.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function updateOrigin(channel) {
  if (channel === 'stable') return 'https://updates.flowzero.app';
  if (channel === 'beta') return 'https://updates-beta.flowzero.app';
  throw new Error(`invalid channel: ${channel}`);
}

async function verifyAssetTransport(url, fetchImplementation) {
  const head = await fetchImplementation(url, { method: 'HEAD', cache: 'no-store' });
  assert(head.status === 200, `channel asset HEAD failed with HTTP ${head.status}`);
  const range = await fetchImplementation(url, {
    headers: { Range: 'bytes=0-0' },
    cache: 'no-store',
  });
  assert(range.status === 206, `channel asset range failed with HTTP ${range.status}`);
  assert((await range.arrayBuffer()).byteLength === 1, 'channel asset range did not return one byte');
}

export async function verifyChannelCanary({
  channel,
  platform,
  version,
  state = 'published',
  fetchImplementation = fetch,
}) {
  const origin = updateOrigin(channel);
  assert(['published', 'no_release'].includes(state), `invalid channel state: ${state}`);
  if (state === 'no_release') {
    const url = platform === 'macos-arm64'
      ? `${origin}/electron-updater/latest-mac.yml`
      : platform === 'windows-x64'
        ? `${origin}/update/win32/0.0.0/RELEASES`
        : null;
    assert(url, `invalid platform: ${platform}`);
    const response = await fetchImplementation(url, { cache: 'no-store' });
    assert(response.status === 204, `${platform} no_release canary returned HTTP ${response.status}`);
    return { platform, state };
  }
  assert(typeof version === 'string' && version.length > 0, 'published canary requires a version');
  const tag = `v${version}`;
  if (platform === 'macos-arm64') {
    const response = await fetchImplementation(`${origin}/electron-updater/latest-mac.yml`, {
      cache: 'no-store',
    });
    assert(response.status === 200, `macOS update metadata failed with HTTP ${response.status}`);
    const metadata = await response.json();
    assert(metadata.version === version, `macOS update version mismatch: ${metadata.version}`);
    const url = metadata.files?.[0]?.url;
    assert(typeof url === 'string' && url.includes(`/releases/${tag}/`), 'macOS updater URL is not versioned to the promoted release');
    await verifyAssetTransport(url, fetchImplementation);
    return { platform, version, asset_url: url };
  }
  if (platform === 'windows-x64') {
    const response = await fetchImplementation(`${origin}/update/win32/0.0.0/RELEASES`, {
      cache: 'no-store',
    });
    assert(response.status === 200, `Windows RELEASES failed with HTTP ${response.status}`);
    const releases = await response.text();
    const url = releases.match(/https:\/\/\S+\.nupkg/iu)?.[0];
    assert(url && url.includes(`/releases/${tag}/`), 'Windows nupkg URL is not versioned to the promoted release');
    await verifyAssetTransport(url, fetchImplementation);
    return { platform, version, asset_url: url };
  }
  throw new Error(`invalid platform: ${platform}`);
}

async function atomicWriteJson(output, value) {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `tinkle_${path.basename(resolved)}.${process.pid}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, resolved);
}

export async function verifyChannelCanaryWithReceipt({
  channel,
  platform,
  version,
  state = 'published',
  output,
  fetchImplementation = fetch,
  checkedAt = new Date().toISOString(),
}) {
  assert(typeof output === 'string' && output.trim(), 'canary receipt output is required');
  assert(!Number.isNaN(Date.parse(checkedAt)), 'canary receipt timestamp is invalid');
  try {
    const evidence = await verifyChannelCanary({
      channel,
      platform,
      version,
      state,
      fetchImplementation,
    });
    await atomicWriteJson(output, {
      schema: CANARY_RECEIPT_SCHEMA,
      status: 'pass',
      channel,
      platform,
      state,
      version: version || null,
      evidence,
      checked_at: checkedAt,
    });
    return evidence;
  } catch (error) {
    await atomicWriteJson(output, {
      schema: CANARY_RECEIPT_SCHEMA,
      status: 'fail',
      channel,
      platform,
      state,
      version: version || null,
      error: error.message,
      checked_at: checkedAt,
    });
    throw error;
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--channel', '--platform', '--version', '--state', '--output'].includes(key) || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    values[key] = value;
  }
  for (const key of ['--channel', '--platform']) if (!values[key]) throw new Error(`missing argument: ${key}`);
  values['--state'] ||= 'published';
  if (values['--state'] === 'published' && !values['--version']) throw new Error('published state requires --version');
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const input = {
    channel: args['--channel'],
    platform: args['--platform'],
    version: args['--version'],
    state: args['--state'],
  };
  const result = args['--output']
    ? await verifyChannelCanaryWithReceipt({ ...input, output: args['--output'] })
    : await verifyChannelCanary(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
