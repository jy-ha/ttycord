import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { copyText, selectionRanges, selectionText } from '../src/tui/clipboard.js';

function fakeScreen(rows) {
  const cols = rows[0].length;
  return { cols, rows: rows.length, chars: rows.flatMap((row) => [...row]) };
}

test('selectionText joins rows and trims trailing blanks', () => {
  const screen = fakeScreen([
    '  alpha   ',
    '  beta    ',
    '          ',
  ]);
  assert.equal(
    selectionText(screen, { ax: 0, ay: 0, fx: 9, fy: 2 }),
    '  alpha\n  beta',
  );
});

test('selectionText keeps leading indentation and skips wide-glyph continuations', () => {
  // '' is the second cell of a wide glyph (한/글); copying it again would
  // double the character.
  const screen = {
    cols: 8,
    rows: 2,
    chars: [
      ' ', ' ', '한', '', '글', '', ' ', ' ',
      ' ', ' ', 'o', 'k', ' ', ' ', ' ', ' ',
    ],
  };
  const text = selectionText(screen, { ax: 0, ay: 0, fx: 7, fy: 1 });
  assert.equal(text, '  한글\n  ok');
});

test('selectionRanges uses editor-style line selection, not a rectangle', () => {
  const screen = { cols: 10, rows: 4 };
  assert.deepEqual(selectionRanges(screen, { ax: 4, ay: 1, fx: 2, fy: 2 }), [
    { y: 1, start: 4, end: 9 },
    { y: 2, start: 0, end: 2 },
  ]);
  assert.deepEqual(selectionRanges(screen, { ax: 2, ay: 2, fx: 4, fy: 1 }), [
    { y: 1, start: 0, end: 4 },
    { y: 2, start: 2, end: 9 },
  ]);
  assert.deepEqual(selectionRanges(screen, { ax: 7, ay: 2, fx: 3, fy: 2 }), [
    { y: 2, start: 3, end: 7 },
  ]);
  assert.deepEqual(selectionRanges(screen, null), []);
});

test('selectionRanges stays inside the pane where the drag started', () => {
  const screen = { cols: 20, rows: 6 };
  const bounds = { left: 5, right: 15, top: 1, bottom: 4 };
  assert.deepEqual(selectionRanges(screen, { ax: 8, ay: 2, fx: 12, fy: 3 }, bounds), [
    { y: 2, start: 8, end: 15 },
    { y: 3, start: 5, end: 12 },
  ]);
  // Dragging outside the pane clamps instead of spilling into other panes.
  assert.deepEqual(selectionRanges(screen, { ax: 8, ay: 2, fx: 0, fy: 9 }, bounds), [
    { y: 2, start: 8, end: 15 },
    { y: 3, start: 5, end: 15 },
    { y: 4, start: 5, end: 5 },
  ]);
});

test('selectionText normalizes a reversed drag and clamps to the screen', () => {
  const screen = fakeScreen(['abcdef', 'ghijkl']);
  const text = selectionText(screen, { ax: 4, ay: 1, fx: 1, fy: 0 });
  assert.equal(text, 'ab\nkl');
  assert.equal(selectionText(screen, null), '');
  assert.equal(selectionText(null, { ax: 0, ay: 0, fx: 0, fy: 0 }), '');
});

function fakeSpawn({ fail = false, code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => {
      child.stdin.text = text;
      queueMicrotask(() => {
        if (fail) child.emit('error', new Error('ENOENT'));
        else child.emit('close', code);
      });
    };
    return child;
  };
}

test('copyText prefers a clipboard helper', async () => {
  const out = { written: '', write(value) { this.written += value; } };
  const method = await copyText('hello', { out, spawnImpl: fakeSpawn() });
  assert.notEqual(method, 'osc52');
  assert.equal(out.written, '');
});

test('copyText falls back to OSC 52 when no helper works', async () => {
  const out = { written: '', write(value) { this.written += value; } };
  const method = await copyText('한글', { out, spawnImpl: fakeSpawn({ fail: true }) });
  assert.equal(method, 'osc52');
  const base64 = Buffer.from('한글', 'utf8').toString('base64');
  assert.equal(out.written, `\x1b]52;c;${base64}\x07`);
});

test('copyText does nothing for empty text', async () => {
  const out = { written: '', write(value) { this.written += value; } };
  assert.equal(await copyText('', { out, spawnImpl: fakeSpawn() }), '');
  assert.equal(out.written, '');
});

test('copyText uses the GTK helper when clipboard tools are missing', async () => {
  if (process.platform !== 'linux') return;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const out = { written: '', write(value) { this.written += value; } };
  const spawnImpl = (command) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin.end = () => {
      queueMicrotask(() => {
        if (command === 'python3') child.stdout.emit('data', 'ok');
        else child.emit('error', new Error('ENOENT'));
      });
    };
    return child;
  };
  const method = await copyText('hello', { out, spawnImpl });
  assert.equal(method, 'gtk');
  assert.equal(out.written, '');
});
