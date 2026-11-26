/** Off-screen row layers, so message layout and clipping stay simple. */

import { graphemeWidth, graphemes } from '../util.js';
import { strWidth, truncate } from './draw.js';
import { style } from './term.js';
import { C } from './theme.js';

export function blankRow(width) {
  return { width, cells: new Array(width).fill(null) };
}

export function putCell(row, x, ch, st) {
  if (x < 0 || x >= row.width) return;
  row.cells[x] = { ch, st };
  if (ch && graphemeWidth(ch) === 2 && x + 1 < row.width) {
    row.cells[x + 1] = { ch: '', st };
  }
}

export function putText(row, x, text, st, maxWidth = Infinity) {
  let cursor = x;
  const limit = Math.min(row.width, x + maxWidth);
  for (const g of graphemes(String(text))) {
    const w = graphemeWidth(g);
    if (cursor + w > limit) break;
    putCell(row, cursor, g, st);
    cursor += w;
  }
  return cursor;
}

/** Draw text so that it ends just before `endX`. */
export function putRight(row, endX, text, st) {
  const value = truncate(String(text), Math.max(0, endX));
  return putText(row, Math.max(0, endX - strWidth(value)), value, st);
}

/** Blit a layer into the screen, skipping wide-glyph tails that would clip. */
export function blit(screen, x0, y0, rows, maxW, maxH) {
  const height = Math.min(rows.length, maxH);
  for (let r = 0; r < height; r += 1) {
    const row = rows[r];
    const y = y0 + r;
    const width = Math.min(row.width, maxW);
    for (let c = 0; c < width; c += 1) {
      const cell = row.cells[c];
      if (!cell || cell.ch === '') continue;
      if (graphemeWidth(cell.ch) === 2 && c + 1 >= width) continue;
      screen.set(x0 + c, y, cell.ch, cell.st);
    }
  }
}

export function dividerRow(width, label) {
  const row = blankRow(width);
  const lineStyle = style(C.lineSoft, C.surface);
  for (let x = 0; x < width; x += 1) putCell(row, x, '─', lineStyle);

  const text = `[ ${label} ]`;
  const textW = strWidth(text);
  const start = Math.max(1, Math.floor((width - textW) / 2));
  const labelStyle = style(C.textGhost, C.surface);
  for (let x = start - 1; x <= start + textW; x += 1) {
    if (x >= 0 && x < width) putCell(row, x, ' ', labelStyle);
  }
  putText(row, start, text, labelStyle, width - start);
  return row;
}
