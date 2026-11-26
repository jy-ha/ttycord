/** Small formatting/coercion helpers shared by the CLI, protocol and TUI. */

export const DISCORD_EPOCH = 1420070400000n;

export function asInt(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asBig(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return 0n;
  return BigInt(text);
}

export function bigStr(value) {
  if (value === undefined || value === null) return '0';
  try {
    return asBig(value).toString();
  } catch {
    return '0';
  }
}

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Milliseconds since the Unix epoch encoded in a Discord snowflake. */
export function snowflakeToMs(id) {
  const value = asBig(id);
  if (value <= 0n) return 0;
  return Number((value >> 22n) + DISCORD_EPOCH);
}

/** Build a snowflake for a timestamp (used for pagination cursors). */
export function msToSnowflake(ms) {
  const value = BigInt(Math.trunc(ms));
  if (value <= DISCORD_EPOCH) return '0';
  return ((value - DISCORD_EPOCH) << 22n).toString();
}

export function snowflakeTime(id) {
  const ms = snowflakeToMs(id);
  return ms ? new Date(ms) : null;
}

export function compareSnowflakes(a, b) {
  const left = asBig(a);
  const right = asBig(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Split text into user-perceived characters (emoji ZWJ sequences stay whole). */
export function graphemes(text) {
  if (!segmenter) return [...String(text)];
  return Array.from(segmenter.segment(String(text)), (part) => part.segment);
}

const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x1fc00, 0x1fffd],
  [0x20000, 0x3fffd],
];

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MARK = /\p{M}/u;
const widthCache = new Map();

const isRegional = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

function isZeroWidth(cp) {
  if (cp === 0x200d) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2060 && cp <= 0x2064) return true;
  if (cp >= 0x2066 && cp <= 0x206f) return true;
  if (cp === 0xfeff) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true;
  return MARK.test(String.fromCodePoint(cp));
}

/** Display width of one Unicode code point in terminal cells. */
export function charWidth(cp) {
  if (!Number.isFinite(cp) || cp <= 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  const cached = widthCache.get(cp);
  if (cached !== undefined) return cached;

  let width = 1;
  if (isZeroWidth(cp)) {
    width = 0;
  } else {
    for (const [start, end] of WIDE) {
      if (cp >= start && cp <= end) {
        width = 2;
        break;
      }
    }
    // Emoji that default to emoji presentation are double width even outside
    // the broad ranges above (e.g. 🩷 U+1FA77).
    if (width === 1 && EMOJI_PRESENTATION.test(String.fromCodePoint(cp))) width = 2;
  }
  widthCache.set(cp, width);
  return width;
}

/**
 * Width of a grapheme cluster. Terminals render emoji sequences (VS16, ZWJ,
 * flags, keycaps) as a single double-width glyph, while plain text symbols
 * such as ❤ and ♥ stay one cell unless they carry VS16.
 */
export function graphemeWidth(g) {
  if (!g) return 0;
  const cps = [];
  for (const ch of g) cps.push(ch.codePointAt(0));
  if (!cps.length) return 0;
  if (cps.length > 1 && cps.every(isRegional)) return 2;
  if (cps.includes(0x20e3)) return 2;
  const pictographic = cps.some((cp) => EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cp)));
  if (pictographic && (cps.includes(0xfe0f) || cps.includes(0x200d))) return 2;
  let width = 0;
  for (const cp of cps) width = Math.max(width, charWidth(cp));
  return width;
}

/** Display width of a string in terminal cells. */
export function displayWidth(text) {
  let width = 0;
  for (const g of graphemes(text)) width += graphemeWidth(g);
  return width;
}

export function pad(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

export function table(headers, rows) {
  const widths = headers.map((header) => displayWidth(header));
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], displayWidth(String(cell)));
    });
  }
  const line = (cells) => cells.map((cell, index) => pad(String(cell), widths[index])).join('  ');
  const output = [line(headers), line(widths.map((width) => '-'.repeat(width)))];
  for (const row of rows) output.push(line(row));
  return output.join('\n');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function oneLine(text, limit = 200) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Deterministic color for a user/guild id. */
const AUTHOR_COLORS = [
  '#5cc8ff',
  '#6ef2a0',
  '#ffb86b',
  '#ff8fa3',
  '#b79cff',
  '#5eead4',
  '#f2a97e',
  '#9fd6ff',
];

export function colorForId(id) {
  const value = asBig(id);
  const index = Number((value < 0n ? -value : value) % BigInt(AUTHOR_COLORS.length));
  return AUTHOR_COLORS[index];
}

export function redactToken(token) {
  const text = String(token || '');
  if (!text) return '';
  if (text.length <= 12) return '…';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function formatBytes(value) {
  const size = asInt(value);
  if (size <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = size;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 || unit === 0 ? Math.round(n) : n.toFixed(1)}${units[unit]}`;
}

const TIME_STYLES = new Set(['t', 'T', 'd', 'D', 'f', 'F', 's', 'S', 'R']);

function formatDiscordTimestamp(seconds, style) {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const two = (value) => String(value).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const hm = `${two(date.getHours())}:${two(date.getMinutes())}`;
  switch (style) {
    case 't':
      return hm;
    case 'T':
      return `${hm}:${two(date.getSeconds())}`;
    case 'd':
      return ymd;
    case 'D':
      return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
    case 'R':
      return relativeTime(date.getTime());
    case 's':
      return `${ymd} ${hm}`;
    case 'S':
      return `${ymd} ${hm}:${two(date.getSeconds())}`;
    case 'f':
    default:
      return `${ymd} ${hm}`;
  }
}

export function relativeTime(ms) {
  const delta = Math.max(0, Date.now() - Number(ms || 0));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return '방금';
  if (delta < hour) return `${Math.floor(delta / minute)}분 전`;
  if (delta < day) return `${Math.floor(delta / hour)}시간 전`;
  if (delta < 30 * day) return `${Math.floor(delta / day)}일 전`;
  return `${Math.floor(delta / (30 * day))}개월 전`;
}

/**
 * Turn whatever a caller has for a mention target into display text.
 *
 * Callers pass either a ready-made name (tests, cached labels) or a raw Discord
 * object (users/channels/roles maps). Stringifying the object directly is what
 * produced `@[object Object]` in real message rendering.
 */
function mentionName(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return (
    value.global_name ||
    value.display_name ||
    value.nick ||
    value.username ||
    value.name ||
    fallback
  );
}

/**
 * Replace Discord mention syntax with readable text. Unknown users/channels
 * fall back to a compact `@id` / `#id` form so the message stays legible.
 */
export function renderMentions(content, { users = null, channels = null, roles = null } = {}) {
  let text = String(content ?? '');
  text = text.replace(/<@!?(\d+)>/g, (_, id) => `@${mentionName(users?.get(id), id)}`);
  text = text.replace(/<#(\d+)>/g, (_, id) => `#${mentionName(channels?.get(id), id)}`);
  text = text.replace(/<@&(\d+)>/g, (_, id) => `@${mentionName(roles?.get(id), 'role')}`);
  text = text.replace(/<a?:([\w~]+):(\d+)>/g, (_, name) => `:${name}:`);
  text = text.replace(/<t:(\d+)(?::([tTdDfFsSR]))?>/g, (_, seconds, style) => {
    const key = style && TIME_STYLES.has(style) ? style : 'f';
    return formatDiscordTimestamp(seconds, key);
  });
  text = text.replace(/<id:(?:customize|browse|guide|linked-roles[^>]*)>/g, '[서버 안내]');
  return text;
}

export function mentionsUser(content, userId) {
  if (!userId) return false;
  return new RegExp(`<@!?${String(userId).replace(/[^\d]/g, '')}>`).test(String(content || ''));
}

export function channelPrefix(type) {
  switch (Number(type)) {
    case 2:
    case 13:
      return '~';
    case 4:
      return '-';
    case 5:
      return '!';
    case 10:
    case 11:
    case 12:
      return '>';
    case 15:
    case 16:
      return ':';
    case 1:
      return '@';
    case 3:
      return '%';
    default:
      return '#';
  }
}

export function isTextChannel(type) {
  return [0, 1, 3, 5, 10, 11, 12, 18].includes(Number(type));
}

export function isVoiceChannel(type) {
  return [2, 13].includes(Number(type));
}

export function guildInitial(name) {
  const text = String(name || '?').trim();
  if (!text) return '?';
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${graphemes(parts[0])[0] || ''}${graphemes(parts[1])[0] || ''}`.toUpperCase();
  const first = graphemes(text).slice(0, 2).join('');
  return first.toUpperCase();
}

export function truncateMiddle(text, width) {
  const value = String(text);
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return '…';
  const parts = graphemes(value);
  const left = Math.ceil((width - 1) / 2);
  const right = Math.floor((width - 1) / 2);
  return `${parts.slice(0, left).join('')}…${parts.slice(parts.length - right).join('')}`;
}
