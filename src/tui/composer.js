/**
 * Visual layout for the multiline composer.
 *
 * The draft is a plain string that may contain `\n`. The composer has a fixed
 * width, so long logical lines are soft-wrapped into visual rows. This module
 * maps a grapheme cursor index to a (row, column) cell and back, which both the
 * renderer and the Up/Down keys use.
 */

import { graphemeWidth, graphemes } from '../util.js';

/** How many visual rows the composer shows before it scrolls internally. */
export const MAX_COMPOSER_LINES = 6;

/** Width available for text after the `>` prompt and margins. */
export function composerTextWidth(rectWidth) {
  return Math.max(4, Math.trunc(Number(rectWidth) || 0) - 7);
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Lay the draft out into visual rows.
 *
 * `positions[i]` is the cell of grapheme boundary `i` (0..length), so the
 * caret for cursor index `i` is exactly `positions[i]`. A soft wrap at the
 * very end gets its own empty row, otherwise a caret at the end of a full row
 * would be drawn off-screen.
 */
export function composerLayout(text, cursor, width, { maxLines = MAX_COMPOSER_LINES } = {}) {
  const parts = graphemes(String(text ?? ''));
  const limit = Math.max(1, Math.trunc(Number(width) || 1));
  const at = clamp(Math.trunc(Number(cursor) || 0), 0, parts.length);

  const rows = [];
  const starts = [];
  const ends = [];
  const widths = [];
  const positions = new Array(parts.length + 1);

  let current = [];
  let col = 0;
  let start = 0;

  const pushRow = (end) => {
    rows.push(current.join(''));
    starts.push(start);
    ends.push(end);
    widths.push(col);
    current = [];
    col = 0;
    start = end;
  };

  for (let i = 0; i < parts.length; i += 1) {
    const g = parts[i];
    if (g === '\n') {
      positions[i] = { row: rows.length, col };
      pushRow(i);
      start = i + 1;
      continue;
    }
    const w = graphemeWidth(g);
    // Wrap before this grapheme when it would overflow a non-empty row.
    if (col > 0 && col + w > limit) pushRow(i);
    positions[i] = { row: rows.length, col };
    current.push(g);
    col += w;
  }

  if (col >= limit) {
    // The last row is exactly full: put the caret on a fresh empty row.
    positions[parts.length] = { row: rows.length + 1, col: 0 };
    pushRow(parts.length);
  } else {
    positions[parts.length] = { row: rows.length, col };
  }
  rows.push(current.join(''));
  starts.push(start);
  ends.push(parts.length);
  widths.push(col);

  const cursorPos = positions[at];
  const visibleCount = Math.max(1, Math.trunc(Number(maxLines) || 1));
  const total = rows.length;
  let offset = 0;
  if (total > visibleCount) {
    offset = clamp(cursorPos.row - visibleCount + 1, 0, total - visibleCount);
    if (cursorPos.row < offset) offset = cursorPos.row;
  }

  return {
    rows,
    starts,
    ends,
    widths,
    positions,
    cursor: cursorPos,
    cursorIndex: at,
    offset,
    visible: rows.slice(offset, offset + visibleCount),
    total,
  };
}

/** Number of composer rows the layout needs, capped at `maxLines`. */
export function composerLineCount(text, width, maxLines = MAX_COMPOSER_LINES) {
  return composerLayout(text, 0, width, { maxLines }).visible.length;
}

/** Cursor index closest to a cell in a given visual row. */
export function composerIndexAt(layout, row, col) {
  const target = clamp(Math.trunc(Number(row) || 0), 0, layout.rows.length - 1);
  const start = layout.starts[target];
  const end = layout.ends[target];
  const width = layout.widths[target];
  const want = Math.max(0, Number(col) || 0);

  if (want >= width) return end;
  let best = start;
  for (let i = start; i < end; i += 1) {
    const cell = layout.positions[i]?.col ?? 0;
    if (cell <= want) best = i;
    else break;
  }
  const bestCol = layout.positions[best]?.col ?? 0;
  if (end !== best && Math.abs(width - want) < Math.abs(bestCol - want)) return end;
  return best;
}

/**
 * Move the caret one visual row up/down, keeping the column where possible.
 * Returns null when there is no row in that direction, so the caller can fall
 * back to input history.
 */
export function composerMoveVertical(text, cursor, width, delta, maxLines = MAX_COMPOSER_LINES) {
  const layout = composerLayout(text, cursor, width, { maxLines });
  const target = layout.cursor.row + (Number(delta) < 0 ? -1 : 1);
  if (target < 0 || target >= layout.rows.length) return null;
  return composerIndexAt(layout, target, layout.cursor.col);
}
