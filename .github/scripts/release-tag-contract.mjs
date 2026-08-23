const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const STABLE_PATTERN = new RegExp(
  `^v(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})$`,
  'u',
);
const BETA_PATTERN = new RegExp(
  `^v(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})-beta\\.(${NUMERIC_IDENTIFIER})$`,
  'u',
);

function toSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

export function parseProjectReleaseTag(tag) {
  if (typeof tag !== 'string') throw new Error('Release tag must be a string');
  for (const [channel, pattern] of [['stable', STABLE_PATTERN], ['beta', BETA_PATTERN]]) {
    const match = tag.match(pattern);
    if (!match) continue;
    const rawParts = channel === 'stable'
      ? [match[1], match[2], match[3]]
      : [match[1], match[2], match[3], match[4]];
    return {
      tag,
      channel,
      version: tag.slice(1),
      parts: rawParts.map((value, index) => toSafeInteger(value, `Version part ${index + 1}`)),
    };
  }
  throw new Error(
    `Release tag ${tag} must match canonical vX.Y.Z or vX.Y.Z-beta.N`,
  );
}

export function parseChannelReleaseTag(tag, channel) {
  if (!['stable', 'beta'].includes(channel)) {
    throw new Error('Channel must be stable or beta');
  }
  const parsed = parseProjectReleaseTag(tag);
  if (parsed.channel !== channel) {
    throw new Error(`Release tag ${tag} does not match the ${channel} channel contract`);
  }
  return parsed;
}
