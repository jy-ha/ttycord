/**
 * Drag-and-drop / paste attachment detection.
 *
 * Terminals do not report file drops as their own event: the file manager
 * pastes the path (or a `file://` URI) as bracketed-paste text. This module
 * turns that text back into real files, and only accepts regular files that
 * exist. Anything else is left alone so normal pasted text still goes into the
 * composer.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { formatBytes } from '../util.js';

/** Discord accepts at most 10 files per message. */
export const MAX_ATTACHMENTS = 10;

/**
 * Conservative free-tier upload limit. Discord currently allows 10 MB for
 * accounts without Nitro, so larger files are rejected before we waste a
 * request (and the user's rate-limit budget) on a 413.
 */
export const MAX_ATTACHMENT_BYTES =
  Math.max(1, Number(process.env.TTYCORD_MAX_UPLOAD_MB) || 10) * 1024 * 1024;

const MIME_TYPES = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pjp: 'image/jpeg',
  pjpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
};

export function contentTypeFor(name) {
  const ext = extname(String(name || '')).slice(1).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Detect common image formats from their leading bytes.
 *
 * Screenshot tools often drop files without an extension (or with a temporary
 * one), and Discord needs an `image/*` content type before it will treat the
 * upload as an image. Reading 32 bytes is cheap, so this also corrects files
 * whose extension lies about the contents.
 */
export function sniffImageType(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(32);
    const read = readSync(fd, head, 0, head.length, 0);
    if (read < 2) return null;
    const b = head.subarray(0, read);
    if (
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6) {
      const magic = b.toString('latin1', 0, 6);
      if (magic === 'GIF87a' || magic === 'GIF89a') return 'image/gif';
    }
    if (
      b.length >= 12 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    if (
      b.length >= 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
    ) {
      return 'image/tiff';
    }
    if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
      const brand = b.toString('latin1', 8, 12);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (
        ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(
          brand,
        )
      ) {
        return 'image/heic';
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

/** `~/x`, `/abs/x`, `./x`, `../x`, `C:\x`, `\\host\x` and file URIs. */
export function isPathLike(value) {
  const text = String(value || '');
  return /^(?:file:\/\/|~\/|~$|\/|\.\.?\/|[A-Za-z]:[\\/]|\\\\)/i.test(text);
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(home, value.slice(2));
  }
  return value;
}

function toPath(value, { cwd, home }) {
  const text = String(value || '');
  if (!text) return null;
  if (/^file:/i.test(text)) {
    try {
      return fileURLToPath(new URL(text));
    } catch {
      return null;
    }
  }
  return resolve(cwd, expandHome(text, home));
}

/** Split one line into shell-ish tokens, honouring quotes and backslashes. */
export function tokenizeLine(line) {
  const tokens = [];
  let current = '';
  let quote = '';
  let started = false;
  const text = String(line || '');
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else if (ch === '\\' && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index];
      } else {
        current += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && index + 1 < text.length) {
      index += 1;
      current += text[index];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function stripQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function defaultStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function inspect(path, stat) {
  const info = stat(path);
  if (!info) return null;
  const isFile = typeof info.isFile === 'function' ? info.isFile() : Boolean(info.isFile);
  return {
    path,
    name: basename(path) || path,
    size: Number(info.size) || 0,
    isFile,
  };
}

/**
 * Parse pasted text into attachments.
 *
 * Returns `{ files, rejected }`. `files` are `{ path, name, size,
 * contentType }`; `rejected` are `{ path, name, reason }` for paths that were
 * clearly meant as files but cannot be attached (`missing` / `directory`).
 * When both arrays are empty the caller should treat the paste as text.
 */
export function parseAttachmentText(
  text,
  { stat = defaultStat, cwd = process.cwd(), home = homedir() } = {},
) {
  const raw = String(text ?? '');
  const files = [];
  const rejected = [];
  const seen = new Set();

  const add = (candidate, { pathLike }) => {
    const filePath = toPath(candidate, { cwd, home });
    if (!filePath || seen.has(filePath)) return;
    const info = inspect(filePath, stat);
    if (!info) {
      if (pathLike) {
        seen.add(filePath);
        rejected.push({ path: filePath, name: basename(filePath) || filePath, reason: 'missing' });
      }
      return;
    }
    seen.add(filePath);
    if (!info.isFile) {
      rejected.push({ path: filePath, name: info.name, reason: 'directory' });
      return;
    }
    files.push({
      path: info.path,
      name: info.name,
      size: info.size,
      contentType: sniffImageType(info.path) || contentTypeFor(info.name),
    });
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const unquoted = stripQuotes(trimmed);
    const quoted = unquoted !== trimmed;

    // A whole line that names one file wins over whitespace splitting: some
    // terminals paste `/tmp/my file.png` with raw spaces instead of quoting it.
    const wholePath = toPath(unquoted, { cwd, home });
    if ((quoted || isPathLike(unquoted)) && wholePath && inspect(wholePath, stat)?.isFile) {
      add(unquoted, { pathLike: true });
      continue;
    }

    const tokens = tokenizeLine(trimmed);
    for (const token of tokens) {
      const clean = stripQuotes(token);
      if (!clean) continue;
      const pathLike = isPathLike(clean);
      // A path-looking token is always a candidate. Otherwise only a
      // single-token line is stat()ed, so a large text paste does not hit the
      // filesystem once per word.
      if (!pathLike && tokens.length > 1) continue;
      const tokenPath = toPath(clean, { cwd, home });
      if (!pathLike && !(tokenPath && inspect(tokenPath, stat))) continue;
      add(clean, { pathLike });
    }
  }

  return { files, rejected };
}

/**
 * Decide whether a bracketed paste is a file-manager drop rather than text.
 *
 * A real drop contains nothing but paths (one per line, sometimes quoted or
 * `file://` URIs). Pasted prose often mentions a path — a stack trace line like
 * `at /home/me/app.js:12` — so a single path-looking token is not enough: every
 * non-empty line must consist only of path-like tokens, and a multi-line paste
 * must resolve to at least one existing file. Single-line missing paths still
 * count, so a dropped-but-deleted file gets a "not found" toast instead of
 * being typed into the message.
 */
export function looksLikeFileDrop(
  text,
  { stat = defaultStat, cwd = process.cwd(), home = homedir() } = {},
) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;

  let sawPath = false;
  let existing = 0;
  for (const line of lines) {
    // A whole line can be one unquoted path with spaces.
    const unquoted = stripQuotes(line);
    const wholePath = toPath(unquoted, { cwd, home });
    if (wholePath && inspect(wholePath, stat)?.isFile) {
      sawPath = true;
      existing += 1;
      continue;
    }

    const tokens = tokenizeLine(line);
    if (!tokens.length) return false;
    for (const token of tokens) {
      const clean = stripQuotes(token);
      if (!clean || !isPathLike(clean)) return false;
      sawPath = true;
    }
  }

  if (!sawPath) return false;
  // Multiple lines with no resolvable file: treat as text (logs, tracebacks).
  if (!existing && lines.length > 1) return false;
  return true;
}

/** Human label for a pending attachment row. */
export function pendingAttachmentLabel(file) {
  const kind = String(file?.contentType || '').startsWith('image/') ? '[img]' : '[file]';
  const size = formatBytes(file?.size);
  return `${kind} ${file?.name || 'attachment'}${size ? ` (${size})` : ''}`;
}
