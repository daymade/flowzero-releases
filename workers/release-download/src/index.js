const RELEASE_KEY_PATTERN = /^releases\/v[0-9A-Za-z.+-]+\/[^/]+$/;

function responseHeaders(object, contentLength) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Length', String(contentLength));
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

function parseReleaseKey(requestUrl) {
  const encodedPath = new URL(requestUrl).pathname.replace(/^\/+/, '');
  let key;

  try {
    key = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  if (!RELEASE_KEY_PATTERN.test(key) || key.includes('\\') || key.includes('\0')) {
    return null;
  }

  return key;
}

export function parseSingleRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '');
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const length = Math.min(suffixLength, size);
    return { offset: size - length, length };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;

  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;

  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

function notFound() {
  return new Response('Not Found', { status: 404 });
}

export async function handleRequest(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }

  const key = parseReleaseKey(request.url);
  if (!key) return notFound();

  if (request.method === 'HEAD') {
    const object = await env.RELEASES.head(key);
    if (!object) return notFound();
    return new Response(null, { headers: responseHeaders(object, object.size) });
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const metadata = await env.RELEASES.head(key);
    if (!metadata) return notFound();

    const range = parseSingleRange(rangeHeader, metadata.size);
    if (!range) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}` },
      });
    }

    const object = await env.RELEASES.get(key, { range });
    if (!object) return notFound();

    const headers = responseHeaders(object, range.length);
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`,
    );
    return new Response(object.body, { status: 206, headers });
  }

  const object = await env.RELEASES.get(key);
  if (!object) return notFound();
  return new Response(object.body, {
    headers: responseHeaders(object, object.size),
  });
}

export default {
  fetch: handleRequest,
};
