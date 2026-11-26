/**
 * Inline image rendering.
 *
 * Terminals cannot display arbitrary bitmaps, so each image is drawn with
 * Unicode block characters: one cell carries a 2x2 pixel block, using a
 * quadrant glyph (`▘▝▖▗▚▞▌▐▀▄█…`) with two colours. That works on any 24-bit
 * terminal and, unlike the Kitty/Sixel protocols, it goes through the normal
 * cell diff renderer — no escape-sequence placement, no flicker.
 *
 * Resolution is therefore bounded by the cell grid: a 100x30 message pane
 * shows at most 200x60 pixels. To spend every available cell, images are laid
 * out at the full pane width and as many rows as their aspect ratio needs
 * (the message list simply scrolls).
 *
 * Decoding is delegated to ImageMagick (`convert`), with ffmpeg as a fallback.
 * Both are optional: without either the `[img] name` label stays.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { blankRow, putCell } from './layer.js';
import { rawStyle } from './term.js';

const run = promisify(execFile);

const MAX_BYTES = 12 * 1024 * 1024;
const DECODE_TIMEOUT = 20_000;
const SKIP_TYPES = new Set(['image/svg+xml']);

// Master decode size. Each cell samples 2x2 pixels, so this only has to cover
// twice the widest plausible pane; downscaling is box-filtered for quality.
const MASTER_WIDTH = 320;
const MASTER_MAX_HEIGHT = 640;

/**
 * Whether inline images can be drawn.
 *
 * The whole UI already emits 24-bit SGR, so images need no stricter gate than
 * the rest of the renderer; only an explicitly color-less terminal is refused.
 */
export function imageCapability(env = process.env) {
  if (env.NO_COLOR) return { ok: false, reason: 'NO_COLOR is set' };
  if (String(env.TERM || '') === 'dumb') return { ok: false, reason: 'TERM=dumb' };
  return { ok: true, mode: 'halfblock' };
}

/** True when an attachment can plausibly be previewed. */
export function isPreviewable(attachment) {
  if (!attachment) return false;
  const type = String(attachment.content_type || '').toLowerCase();
  if (!type.startsWith('image/')) return false;
  if (SKIP_TYPES.has(type)) return false;
  if (!attachment.url && !attachment.proxy_url) return false;
  return true;
}

/** Stable cache key for an attachment. */
export function imageKey(attachment) {
  if (!attachment) return '';
  return String(attachment.id || attachment.url || attachment.proxy_url || '');
}

export function cacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(base, 'ttycord', 'images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function extensionFor(attachment) {
  const type = String(attachment.content_type || '').toLowerCase();
  const known = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
  };
  if (known[type]) return known[type];
  const fromUrl = String(attachment.url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return fromUrl ? `.${fromUrl[1].toLowerCase()}` : '.img';
}

/**
 * Download an attachment into the cache. Discord's CDN URLs are signed, so no
 * token is sent; if a legacy unsigned URL rejects us we retry once with the
 * authorization header the client would use.
 */
export async function downloadImage(attachment, { token = '', debug = null } = {}) {
  if (!isPreviewable(attachment)) throw new Error('unsupported attachment');
  const key = createHash('sha1')
    .update(`${imageKey(attachment)}:${attachment.size || 0}`)
    .digest('hex');
  const file = path.join(cacheDir(), `${key}${extensionFor(attachment)}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;

  const url = attachment.proxy_url || attachment.url;
  const headers = { accept: 'image/*,*/*;q=0.8' };
  let response = await fetch(url, { headers, signal: AbortSignal.timeout(DECODE_TIMEOUT) });
  if (response.status === 401 || response.status === 403) {
    if (!token) throw new Error(`cdn ${response.status}`);
    response = await fetch(url, {
      headers: { ...headers, authorization: token },
      signal: AbortSignal.timeout(DECODE_TIMEOUT),
    });
  }
  if (!response.ok) throw new Error(`cdn ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('image too large');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('image too large');
  if (!buffer.length) throw new Error('empty image');

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, file);
  debug?.(`image cached: ${path.basename(file)} ${buffer.length}b`);
  return file;
}

let decoderPromise = null;

/** Detect `convert`/`ffmpeg` once per process. */
export function decoder() {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      try {
        await run('convert', ['-version'], { timeout: DECODE_TIMEOUT });
        return 'convert';
      } catch {
        /* fall through */
      }
      try {
        await run('ffmpeg', ['-version'], { timeout: DECODE_TIMEOUT });
        return 'ffmpeg';
      } catch {
        return null;
      }
    })();
  }
  return decoderPromise;
}

/** Pixel dimensions of an attachment, from Discord metadata or the decoder. */
export async function imageSize(file, attachment = {}) {
  const width = Number(attachment.width || 0);
  const height = Number(attachment.height || 0);
  if (width > 0 && height > 0) return { width, height };
  if ((await decoder()) !== 'convert') return { width: 16, height: 9 };
  try {
    const { stdout } = await run('convert', [`${file}[0]`, '-format', '%w %h', 'info:'], {
      timeout: DECODE_TIMEOUT,
      encoding: 'utf8',
    });
    const [w, h] = String(stdout).trim().split(/\s+/).map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch {
    /* fall through */
  }
  return { width: 16, height: 9 };
}

async function decodeWithConvert(file, width, height) {
  const { stdout } = await run(
    'convert',
    [
      `${file}[0]`,
      '-auto-orient',
      '-resize',
      `${width}x${height}`,
      '-background',
      'none',
      '-gravity',
      'center',
      '-extent',
      `${width}x${height}`,
      '-depth',
      '8',
      'rgba:-',
    ],
    { timeout: DECODE_TIMEOUT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return Buffer.from(stdout);
}

async function decodeWithFfmpeg(file, width, height) {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    { timeout: DECODE_TIMEOUT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return Buffer.from(stdout);
}

/** Decode `file` into `width`x`height` RGBA pixels. `null` without a decoder. */
export async function decodeImage(file, width, height) {
  const tool = await decoder();
  if (!tool) return null;
  const pixels = tool === 'convert'
    ? await decodeWithConvert(file, width, height)
    : await decodeWithFfmpeg(file, width, height);
  const expected = width * height * 4;
  if (pixels.length < expected) throw new Error('decoder returned short pixel data');
  return pixels.subarray(0, expected);
}

/**
 * Decode an attachment once at a generous master resolution. The cell layout
 * then downsamples this buffer, so resizing the terminal never re-downloads or
 * re-decodes anything.
 */
export async function masterImage(file, attachment = {}) {
  const { width, height } = await imageSize(file, attachment);
  const scale = Math.min(1, MASTER_WIDTH / width, MASTER_MAX_HEIGHT / height);
  const mw = Math.max(1, Math.round(width * scale));
  const mh = Math.max(1, Math.round(height * scale));
  const pixels = await decodeImage(file, mw, mh);
  if (!pixels) return null;
  return { width: mw, height: mh, pixels };
}

/** Cell box that keeps the source aspect ratio inside `maxW`x`maxH` cells. */
export function fitCells(sourceWidth, sourceHeight, maxW, maxH) {
  const sw = Math.max(1, sourceWidth);
  const sh = Math.max(1, sourceHeight);
  // A cell is roughly twice as tall as it is wide, so `h` cells cover `2h` px.
  let cols = Math.round((2 * maxH * sw) / sh);
  let rows = maxH;
  if (cols > maxW) {
    cols = maxW;
    rows = Math.round((cols * sh) / (2 * sw));
  }
  return {
    cols: Math.max(4, Math.min(maxW, cols)),
    rows: Math.max(2, Math.min(maxH, rows)),
  };
}

/** Box-filtered RGBA resample of `master` to `cols` x `pxRows`. */
export function resample(master, cols, pxRows) {
  const { width: mw, height: mh, pixels } = master;
  const out = Buffer.alloc(cols * pxRows * 4);
  for (let y = 0; y < pxRows; y += 1) {
    const y0 = Math.floor((y * mh) / pxRows);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * mh) / pxRows));
    for (let x = 0; x < cols; x += 1) {
      const x0 = Math.floor((x * mw) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * mw) / cols));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        const rowBase = sy * mw;
        for (let sx = x0; sx < x1; sx += 1) {
          const offset = (rowBase + sx) * 4;
          r += pixels[offset];
          g += pixels[offset + 1];
          b += pixels[offset + 2];
          a += pixels[offset + 3];
          count += 1;
        }
      }
      const offset = (y * cols + x) * 4;
      out[offset] = Math.round(r / count);
      out[offset + 1] = Math.round(g / count);
      out[offset + 2] = Math.round(b / count);
      out[offset + 3] = Math.round(a / count);
    }
  }
  return out;
}

const quantize = (value) => Math.min(255, Math.max(0, value)) & 0xf8;
const hex2 = (value) => value.toString(16).padStart(2, '0');
const hexOf = (rgb) => `#${hex2(quantize(rgb[0]))}${hex2(quantize(rgb[1]))}${hex2(quantize(rgb[2]))}`;

function backdropRgb(hex) {
  const raw = String(hex || '#000000').replace('#', '');
  return [
    Number.parseInt(raw.slice(0, 2), 16) || 0,
    Number.parseInt(raw.slice(2, 4), 16) || 0,
    Number.parseInt(raw.slice(4, 6), 16) || 0,
  ];
}

/**
 * One cell covers 2x2 pixels. The glyph is picked from the 16 block-element
 * quadrant shapes so each cell can carry four samples instead of two, which
 * doubles horizontal resolution over half blocks.
 */
const QUADRANTS = [
  ' ', '▘', '▝', '▀',
  '▖', '▌', '▞', '▛',
  '▗', '▚', '▐', '▜',
  '▄', '▙', '▟', '█',
];

function dist2(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/** Best two-colour split of four samples, as `{ glyph, fg, bg }`. */
export function quadCell(colors) {
  // Seed with the two most distant samples, then run two k-means passes.
  let seedA = 0;
  let seedB = 1;
  let farthest = -1;
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      const d = dist2(colors[i], colors[j]);
      if (d > farthest) {
        farthest = d;
        seedA = i;
        seedB = j;
      }
    }
  }

  let a = [...colors[seedA]];
  let b = [...colors[seedB]];
  let mask = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    mask = 0;
    const sumA = [0, 0, 0];
    const sumB = [0, 0, 0];
    let countA = 0;
    let countB = 0;
    for (let k = 0; k < 4; k += 1) {
      if (dist2(colors[k], a) <= dist2(colors[k], b)) {
        mask |= 1 << k;
        sumA[0] += colors[k][0];
        sumA[1] += colors[k][1];
        sumA[2] += colors[k][2];
        countA += 1;
      } else {
        sumB[0] += colors[k][0];
        sumB[1] += colors[k][1];
        sumB[2] += colors[k][2];
        countB += 1;
      }
    }
    if (!countA || !countB) break;
    a = sumA.map((value) => value / countA);
    b = sumB.map((value) => value / countB);
  }

  if (mask === 0 || mask === 15) {
    // Uniform block: a single colour, no split needed.
    const mean = [0, 1, 2].map((c) =>
      Math.round((colors[0][c] + colors[1][c] + colors[2][c] + colors[3][c]) / 4),
    );
    return { glyph: mask === 0 ? ' ' : '█', fg: mean, bg: mean };
  }
  return { glyph: QUADRANTS[mask], fg: a, bg: b };
}

/**
 * Turn a master image into layer rows of quadrant cells.
 *
 * Styles are built once per colour pair and reused, because interning thousands
 * of one-off pairs in the shared style cache would evict everything else.
 */
export function imageRows(master, cols, rows, { indent = 4, width, backdrop = '#070a07' } = {}) {
  const pxW = cols * 2;
  const pxH = rows * 2;
  const rgba = resample(master, pxW, pxH);
  const bg = backdropRgb(backdrop);

  // Blend transparency onto the pane background so every sample is opaque.
  const rgb = new Uint8Array(pxW * pxH * 3);
  for (let index = 0; index < pxW * pxH; index += 1) {
    const offset = index * 4;
    const alpha = rgba[offset + 3] / 255;
    rgb[index * 3] = Math.round(rgba[offset] * alpha + bg[0] * (1 - alpha));
    rgb[index * 3 + 1] = Math.round(rgba[offset + 1] * alpha + bg[1] * (1 - alpha));
    rgb[index * 3 + 2] = Math.round(rgba[offset + 2] * alpha + bg[2] * (1 - alpha));
  }

  const palette = new Map();
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    const line = blankRow(width);
    for (let col = 0; col < cols; col += 1) {
      const tl = ((row * 2) * pxW + col * 2) * 3;
      const tr = tl + 3;
      const bl = ((row * 2 + 1) * pxW + col * 2) * 3;
      const br = bl + 3;
      const cell = quadCell([
        [rgb[tl], rgb[tl + 1], rgb[tl + 2]],
        [rgb[tr], rgb[tr + 1], rgb[tr + 2]],
        [rgb[bl], rgb[bl + 1], rgb[bl + 2]],
        [rgb[br], rgb[br + 1], rgb[br + 2]],
      ]);
      const fg = hexOf(cell.fg);
      const bgc = hexOf(cell.bg);
      const key = `${cell.glyph}|${fg}|${bgc}`;
      let st = palette.get(key);
      if (!st) {
        st = rawStyle(fg, bgc);
        palette.set(key, st);
      }
      putCell(line, indent + col, cell.glyph, st);
    }
    out.push(line);
  }
  return out;
}
