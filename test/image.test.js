import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decodeImage,
  fitCells,
  imageCapability,
  imageKey,
  imageRows,
  imageSize,
  isPreviewable,
  masterImage,
  quadCell,
  resample,
} from '../src/tui/image.js';

const hasConvert = (() => {
  try {
    execFileSync('convert', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const master = {
  width: 2,
  height: 2,
  pixels: Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]),
};

test('isPreviewable accepts raster images only', () => {
  assert.equal(isPreviewable({ content_type: 'image/png', url: 'https://x/a.png' }), true);
  assert.equal(isPreviewable({ content_type: 'image/jpeg', proxy_url: 'https://x/a.jpg' }), true);
  assert.equal(isPreviewable({ content_type: 'image/svg+xml', url: 'https://x/a.svg' }), false);
  assert.equal(isPreviewable({ content_type: 'application/pdf', url: 'https://x/a.pdf' }), false);
  assert.equal(isPreviewable({ content_type: 'image/png' }), false);
  assert.equal(isPreviewable(null), false);
});

test('imageKey prefers the attachment id', () => {
  assert.equal(imageKey({ id: '42', url: 'https://x/a.png' }), '42');
  assert.equal(imageKey({ url: 'https://x/a.png' }), 'https://x/a.png');
  assert.equal(imageKey(null), '');
});

test('imageCapability only refuses color-less terminals', () => {
  assert.equal(imageCapability({ TERM: 'xterm-256color' }).ok, true);
  assert.equal(imageCapability({ TERM: 'xterm-256color', NO_COLOR: '1' }).ok, false);
  assert.equal(imageCapability({ TERM: 'dumb' }).ok, false);
});

test('fitCells keeps the aspect ratio inside the cell box', () => {
  const wide = fitCells(1920, 1080, 60, 18);
  assert.equal(wide.cols, 60);
  assert.equal(wide.rows, 17);

  const tall = fitCells(1080, 1920, 60, 18);
  assert.equal(tall.rows, 18);
  assert.ok(tall.cols <= 60);

  const tiny = fitCells(1, 1, 60, 18);
  assert.ok(tiny.cols >= 4 && tiny.rows >= 2);
});

test('resample box-filters to the target grid', () => {
  const out = resample(master, 1, 1);
  assert.deepEqual([...out], [128, 128, 128, 255]);
});

test('quadCell picks the quadrant glyph for a two-colour block', () => {
  const cell = quadCell([
    [255, 0, 0],
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 255],
  ]);
  assert.equal(cell.glyph, '▀');
  assert.deepEqual(cell.fg, [255, 0, 0]);
  assert.deepEqual(cell.bg, [0, 0, 255]);
});

test('quadCell collapses a uniform block to one colour', () => {
  const cell = quadCell([
    [10, 20, 30],
    [10, 20, 30],
    [10, 20, 30],
    [10, 20, 30],
  ]);
  assert.equal(cell.glyph, '█');
  assert.deepEqual(cell.fg, [10, 20, 30]);
  assert.deepEqual(cell.bg, [10, 20, 30]);
});

test('imageRows lays out quadrant cells at the requested indent', () => {
  const topBottom = {
    width: 2,
    height: 2,
    pixels: Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 255,
      0, 0, 255, 255, 0, 0, 255, 255,
    ]),
  };
  const rows = imageRows(topBottom, 1, 1, { indent: 1, width: 5, backdrop: '#000000' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].width, 5);
  assert.equal(rows[0].cells[0], null);
  assert.equal(rows[0].cells[1].ch, '▀');
  assert.equal(rows[0].cells[1].st.fg, '#f80000');
  assert.equal(rows[0].cells[1].st.bg, '#0000f8');
});

test('imageRows reuses one style per colour pair', () => {
  const flat = {
    width: 2,
    height: 2,
    pixels: Buffer.alloc(16, 255),
  };
  const rows = imageRows(flat, 2, 1, { indent: 0, width: 2, backdrop: '#000000' });
  assert.equal(rows[0].cells[0].ch, '█');
  assert.equal(rows[0].cells[0].st, rows[0].cells[1].st);
});

test('imageSize prefers Discord metadata', async () => {
  const size = await imageSize('/nonexistent', { width: 640, height: 360 });
  assert.deepEqual(size, { width: 640, height: 360 });
});

test('decodeImage returns RGBA pixels', { skip: !hasConvert }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttycord-img-'));
  const file = path.join(dir, 'probe.png');
  execFileSync('convert', ['-size', '8x8', 'xc:#ff0000', file]);

  const pixels = await decodeImage(file, 2, 2);
  assert.equal(pixels.length, 2 * 2 * 4);
  assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 255]);

  const measured = await imageSize(file, {});
  assert.deepEqual(measured, { width: 8, height: 8 });

  const decoded = await masterImage(file, { width: 8, height: 8 });
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 8);

  fs.rmSync(dir, { recursive: true, force: true });
});
