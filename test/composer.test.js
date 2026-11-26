import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_COMPOSER_LINES,
  composerIndexAt,
  composerLayout,
  composerLineCount,
  composerMoveVertical,
  composerTextWidth,
} from '../src/tui/composer.js';
import { MAX_PANES, MIN_PANE_WIDTH, computeLayout } from '../src/tui/layout.js';

test('composerTextWidth leaves room for the prompt and margins', () => {
  assert.equal(composerTextWidth(80), 73);
  assert.equal(composerTextWidth(10), 4);
  assert.equal(composerTextWidth(0), 4);
});

test('a short draft is one row with the caret at the cursor', () => {
  const layout = composerLayout('hello', 3, 20);
  assert.deepEqual(layout.rows, ['hello']);
  assert.deepEqual(layout.cursor, { row: 0, col: 3 });
  assert.equal(layout.total, 1);
});

test('long lines soft-wrap and the caret maps to the wrapped row', () => {
  const layout = composerLayout('abcdef', 5, 4);
  assert.deepEqual(layout.rows, ['abcd', 'ef']);
  assert.deepEqual(layout.cursor, { row: 1, col: 1 });
  assert.deepEqual(layout.positions[4], { row: 1, col: 0 });
});

test('a caret at the end of an exactly full row gets its own row', () => {
  const layout = composerLayout('abcd', 4, 4);
  assert.deepEqual(layout.rows, ['abcd', '']);
  assert.deepEqual(layout.cursor, { row: 1, col: 0 });
});

test('newlines create hard rows and preserve empty lines', () => {
  const layout = composerLayout('a\n\nb', 3, 20);
  assert.deepEqual(layout.rows, ['a', '', 'b']);
  assert.deepEqual(layout.cursor, { row: 2, col: 0 });
  // The newline at index 1 ends the first row.
  assert.deepEqual(layout.positions[1], { row: 0, col: 1 });
});

test('a trailing newline keeps an empty final row', () => {
  const layout = composerLayout('a\n', 2, 20);
  assert.deepEqual(layout.rows, ['a', '']);
  assert.deepEqual(layout.cursor, { row: 1, col: 0 });
});

test('the visible window follows the caret and is capped', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
  const layout = composerLayout(text, text.length, 20);
  assert.equal(layout.rows.length, 10);
  assert.equal(layout.visible.length, MAX_COMPOSER_LINES);
  assert.equal(layout.offset, 4);
  assert.equal(layout.visible.at(-1), 'line 9');
  assert.equal(layout.cursor.row - layout.offset, MAX_COMPOSER_LINES - 1);

  const top = composerLayout(text, 0, 20);
  assert.equal(top.offset, 0);
  assert.equal(top.visible[0], 'line 0');
});

test('composerLineCount reports the capped row count', () => {
  assert.equal(composerLineCount('one', 20), 1);
  assert.equal(composerLineCount('one\ntwo', 20), 2);
  const many = Array.from({ length: 12 }, () => 'x').join('\n');
  assert.equal(composerLineCount(many, 20), MAX_COMPOSER_LINES);
});

test('vertical movement keeps the column and stops at the edges', () => {
  const text = 'abc\ndefgh\nij';
  // Cursor at the end of "defgh" (row 1, col 5).
  const cursor = text.indexOf('defgh') + 5;
  assert.equal(composerMoveVertical(text, cursor, 20, -1), 3); // end of "abc"
  assert.equal(composerMoveVertical(text, cursor, 20, 1), text.length); // end of "ij"
  assert.equal(composerMoveVertical(text, 1, 20, -1), null);
  assert.equal(composerMoveVertical(text, text.length, 20, 1), null);
});

test('composerIndexAt clamps to the nearest cell in a row', () => {
  const layout = composerLayout('abc\ndefgh', 0, 20);
  assert.equal(composerIndexAt(layout, 1, 99), layout.ends[1]);
  assert.equal(composerIndexAt(layout, 0, 1), 1);
  assert.equal(composerIndexAt(layout, 0, 99), layout.ends[0]);
});

test('computeLayout grows the composer by the visual line count', () => {
  const one = computeLayout(100, 30, { composerLines: 1 });
  assert.equal(one.composer.height, 3);
  const three = computeLayout(100, 30, { composerLines: 3 });
  assert.equal(three.composer.height, 5);
  assert.equal(three.composer.y, one.composer.y - 2);
  assert.equal(three.messages.height, one.messages.height - 2);
  // Attachment rows are added on top of the text rows.
  const withFiles = computeLayout(100, 30, { composerLines: 3, attachments: 2 });
  assert.equal(withFiles.composer.height, 7);
  // The cap applies even if a caller asks for more rows.
  const capped = computeLayout(100, 30, { composerLines: 50 });
  assert.equal(capped.composer.height, 2 + MAX_COMPOSER_LINES);
});

test('computeLayout splits the chat area into an aligned 2x2 grid', () => {
  const one = computeLayout(160, 40, { panes: 1 });
  assert.equal(one.panes.length, 1);
  assert.deepEqual(one.chat, one.panes[0].chat);
  assert.equal(one.bands.length, 1);

  const two = computeLayout(160, 40, { panes: 2 });
  assert.equal(two.bands.length, 1);
  assert.deepEqual(two.bands[0].panes, [0, 1]);
  assert.equal(two.panes[1].chat.y, two.panes[0].chat.y);

  const four = computeLayout(160, 40, { panes: 4, focus: 2 });
  assert.equal(four.panes.length, MAX_PANES);
  // The legacy rects follow the focused pane (bottom-left in a 2x2 grid).
  assert.deepEqual(four.chat, four.panes[2].chat);
  assert.deepEqual(four.messages, four.panes[2].messages);
  assert.deepEqual(four.composer, four.panes[2].composer);

  assert.equal(four.bands.length, 2);
  assert.deepEqual(four.bands[0].panes, [0, 1]);
  assert.deepEqual(four.bands[1].panes, [2, 3]);
  // Row 0 is above row 1, with the two rows sharing the same column geometry.
  assert.equal(four.panes[0].chat.y, four.panes[1].chat.y);
  assert.equal(four.panes[2].chat.y, four.panes[3].chat.y);
  assert.ok(four.panes[2].chat.y > four.panes[0].chat.y);
  assert.equal(four.panes[0].chat.x, four.panes[2].chat.x);
  assert.equal(four.panes[1].chat.x, four.panes[3].chat.x);
  assert.equal(four.panes[0].chat.width, four.panes[2].chat.width);
  assert.equal(four.panes[1].chat.width, four.panes[3].chat.width);

  for (const pane of four.panes) {
    assert.ok(pane.chat.width >= MIN_PANE_WIDTH, `pane ${pane.index} too narrow`);
    assert.equal(pane.composer.height, four.panes[0].composer.height);
  }
  // One divider column between neighbours, and the grid ends at the edge.
  assert.equal(four.panes[1].chat.x, four.panes[0].chat.x + four.panes[0].chat.width + 1);
  const last = four.panes[3].chat;
  assert.equal(last.x + last.width, 160);
  // The horizontal rule sits between the rows and crosses the column divider.
  assert.equal(four.dividers.vertical.length, 2);
  assert.equal(four.dividers.horizontal.length, 1);
  assert.equal(four.dividers.horizontal[0].y, four.panes[0].chat.y + four.panes[0].chat.height);
  assert.deepEqual(four.dividers.horizontal[0].junctions, [four.dividers.vertical[0].x]);
});

test('computeLayout gives three panes two on top and one spanning the bottom', () => {
  const three = computeLayout(160, 40, { panes: 3, focus: 2 });
  assert.equal(three.bands.length, 2);
  assert.deepEqual(three.bands[0].panes, [0, 1]);
  assert.deepEqual(three.bands[1].panes, [2]);
  // The bottom pane spans both top columns plus the divider between them.
  assert.equal(
    three.panes[2].chat.width,
    three.panes[0].chat.width + 1 + three.panes[1].chat.width,
  );
  assert.equal(three.panes[2].chat.x, three.panes[0].chat.x);
  assert.equal(three.dividers.vertical.length, 1);
  assert.deepEqual(three.dividers.horizontal[0].junctions, [three.dividers.vertical[0].x]);
});

test('computeLayout clamps the pane count to the hard cap', () => {
  const many = computeLayout(200, 40, { panes: 9 });
  assert.equal(many.panes.length, MAX_PANES);
});

test('computeLayout falls back to one row on a short terminal', () => {
  const short = computeLayout(160, 14, { panes: 4 });
  assert.equal(short.panes.length, 4);
  assert.equal(short.bands.length, 1);
  assert.equal(short.panes[1].chat.y, short.panes[0].chat.y);
  assert.equal(short.dividers.horizontal.length, 0);
});

test('computeLayout keeps every split pane inside the screen when very narrow', () => {
  for (const cols of [40, 24, 10]) {
    const layout = computeLayout(cols, 20, { panes: 4 });
    assert.equal(layout.panes.length, 4);
    for (const pane of layout.panes) {
      assert.ok(pane.chat.x >= 0, `cols=${cols} x=${pane.chat.x}`);
      assert.ok(pane.chat.width >= 0, `cols=${cols} width=${pane.chat.width}`);
      assert.ok(pane.chat.x + pane.chat.width <= cols, `cols=${cols} overflows`);
      assert.ok(pane.chat.y >= 0, `cols=${cols} y=${pane.chat.y}`);
      assert.ok(pane.composer.y + pane.composer.height <= 20, `cols=${cols} composer overflows`);
    }
  }
});
