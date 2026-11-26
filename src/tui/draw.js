/** Text measurement, wrapping and drawing primitives. */

import { displayWidth, graphemeWidth, graphemes } from '../util.js';
import { style } from './term.js';

export { graphemeWidth, graphemes };

export function strWidth(text) {
  return displayWidth(text);
}

export function truncate(text, width) {
  if (width <= 0) return '';
  if (strWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > width - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

function wrapLine(line, width) {
  if (!line) return [''];
  const out = [];
  let chars = [];
  let used = 0;
  let lastSpace = -1;

  for (const g of graphemes(line)) {
    const w = graphemeWidth(g);
    if (used + w > width && chars.length) {
      const breakAt = lastSpace >= 0 ? lastSpace : chars.length;
      const head = chars.slice(0, breakAt);
      let tail = chars.slice(breakAt);
      if (lastSpace >= 0 && tail[0] === ' ') tail = tail.slice(1);
      out.push(head.join('').replace(/\s+$/, ''));
      chars = tail;
      used = chars.reduce((sum, item) => sum + graphemeWidth(item), 0);
      lastSpace = -1;
      chars.forEach((item, index) => {
        if (item === ' ') lastSpace = index;
      });
    }
    chars.push(g);
    used += w;
    if (g === ' ') lastSpace = chars.length - 1;
  }
  out.push(chars.join(''));
  return out;
}

/** Wrap text to `width` cells, honouring explicit newlines. */
export function wrapText(text, width) {
  const limit = Math.max(1, width);
  const lines = [];
  for (const raw of String(text).split('\n')) {
    lines.push(...wrapLine(raw.replace(/\t/g, '  '), limit));
  }
  return lines;
}

export function drawText(screen, x, y, text, st, maxWidth = Infinity) {
  let cursor = x;
  for (const g of graphemes(String(text))) {
    const w = graphemeWidth(g);
    if (cursor - x + w > maxWidth) break;
    screen.set(cursor, y, g, st);
    cursor += w;
  }
  return cursor;
}

export function centerText(screen, x, y, width, text, st) {
  const value = truncate(String(text), width);
  const offset = Math.max(0, Math.floor((width - strWidth(value)) / 2));
  drawText(screen, x + offset, y, value, st, width - offset);
}

export function rightText(screen, x, y, width, text, st) {
  const value = truncate(String(text), width);
  drawText(screen, x + Math.max(0, width - strWidth(value)), y, value, st, width);
}

export function fillRect(screen, x, y, width, height, st, ch = ' ') {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) screen.set(col, row, ch, st);
  }
}

export function hline(screen, x, y, width, st, ch = '─') {
  for (let col = x; col < x + width; col += 1) screen.set(col, y, ch, st);
}

/**
 * Draw a rounded frame. `border` styles the outline, `fill` the interior.
 * Returns the interior rectangle.
 */
export function frame(screen, x, y, width, height, border, fill, { rounded = true } = {}) {
  if (width < 2 || height < 2) return { x: x + 1, y: y + 1, width: 0, height: 0 };
  fillRect(screen, x + 1, y, width - 2, height, fill);
  const tl = rounded ? '╭' : '┌';
  const tr = rounded ? '╮' : '┐';
  const bl = rounded ? '╰' : '└';
  const br = rounded ? '╯' : '┘';
  screen.set(x, y, tl, border);
  screen.set(x + width - 1, y, tr, border);
  screen.set(x, y + height - 1, bl, border);
  screen.set(x + width - 1, y + height - 1, br, border);
  hline(screen, x + 1, y, width - 2, border);
  hline(screen, x + 1, y + height - 1, width - 2, border);
  for (let row = y + 1; row < y + height - 1; row += 1) {
    screen.set(x, row, '│', border);
    screen.set(x + width - 1, row, '│', border);
  }
  return { x: x + 1, y: y + 1, width: width - 2, height: height - 2 };
}
