/**
 * Cell-grid terminal renderer.
 *
 * Keeps a front and back buffer, diffs them and emits only the changed runs.
 * Styles are interned objects so the diff can compare by identity.
 */

import { graphemeWidth } from '../util.js';

const cache = new Map();

function rgb(hex) {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function buildSgr(style) {
  const codes = ['0'];
  if (style.fg) codes.push(`38;2;${rgb(style.fg).join(';')}`);
  if (style.bg) codes.push(`48;2;${rgb(style.bg).join(';')}`);
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.reverse) codes.push('7');
  return `\x1b[${codes.join(';')}m`;
}

/** Interned style. `style(fg, bg, {bold})`. */
export function style(fg = null, bg = null, options = {}) {  const key =
    `${fg}|${bg}|${options.bold ? 1 : 0}${options.dim ? 1 : 0}` +
    `${options.italic ? 1 : 0}${options.underline ? 1 : 0}${options.reverse ? 1 : 0}`;
  let found = cache.get(key);
  if (!found) {
    // Image previews create one interned style per cell; cap the cache so a
    // long session cannot grow it without bound.
    if (cache.size >= 20_000) cache.clear();
    found = {
      fg,
      bg,
      bold: Boolean(options.bold),
      dim: Boolean(options.dim),
      italic: Boolean(options.italic),
      underline: Boolean(options.underline),
      reverse: Boolean(options.reverse),
    };
    found.sgr = buildSgr(found);
    cache.set(key, found);
  }
  return found;
}

/**
 * Style object that is *not* interned.
 *
 * Image cells create thousands of unique color pairs. Interning them would
 * evict everything else from the shared cache, so image rows build their
 * styles once and keep their own references instead.
 */
export function rawStyle(fg = null, bg = null, options = {}) {
  const st = {
    fg,
    bg,
    bold: Boolean(options.bold),
    dim: Boolean(options.dim),
    italic: Boolean(options.italic),
    underline: Boolean(options.underline),
    reverse: Boolean(options.reverse),
  };
  st.sgr = buildSgr(st);
  return st;
}

export class Screen {
  constructor(out = process.stdout) {
    this.out = out;
    this.cols = 0;
    this.rows = 0;
    this.chars = [];
    this.styles = [];
    this.prevChars = [];
    this.prevStyles = [];
    this.caret = null;
    this.resize(out.columns || 100, out.rows || 30);
  }

  resize(cols, rows) {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    const size = this.cols * this.rows;
    this.chars = new Array(size).fill(' ');
    this.styles = new Array(size).fill(null);
    this.prevChars = new Array(size).fill('\u0001');
    this.prevStyles = new Array(size).fill(null);
    this.caret = null;
  }

  /**
   * Force the next flush to repaint every cell. Terminals can lose their
   * contents across suspend/resume or a VT switch while the app still thinks
   * the previous frame is on screen.
   */
  invalidate() {
    this.prevChars.fill('\u0001');
    this.prevStyles.fill(null);
    this.caret = null;
  }

  index(x, y) {
    return y * this.cols + x;
  }

  clear(background) {
    this.chars.fill(' ');
    this.styles.fill(background);
  }

  set(x, y, ch, st) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const index = this.index(x, y);
    // Overwriting the trailing half of a wide glyph leaves a dangling base.
    if (this.chars[index] === '' && x > 0) {
      this.chars[index - 1] = ' ';
      this.styles[index - 1] = st;
    }
    this.chars[index] = ch;
    this.styles[index] = st;
    if (ch && graphemeWidth(ch) === 2 && x + 1 < this.cols) {
      if (this.chars[index + 2] === '') {
        this.chars[index + 2] = ' ';
        this.styles[index + 2] = st;
      }
      this.chars[index + 1] = '';
      this.styles[index + 1] = st;
    }
  }

  setCaret(x, y) {
    this.caret = x === null ? null : { x, y };
  }

  flush() {
    if (!this.out.isTTY) {
      this.prevChars = this.chars.slice();
      this.prevStyles = this.styles.slice();
      return;
    }
    let output = '';
    let current = null;

    for (let y = 0; y < this.rows; y += 1) {
      let x = 0;
      while (x < this.cols) {
        const index = y * this.cols + x;
        if (
          this.chars[index] === this.prevChars[index] &&
          this.styles[index] === this.prevStyles[index]
        ) {
          x += 1;
          continue;
        }

        let start = x;
        if (this.chars[index] === '' && start > 0) start -= 1;

        let end = x;
        while (end < this.cols) {
          const cursor = y * this.cols + end;
          if (
            end > x &&
            this.chars[cursor] === this.prevChars[cursor] &&
            this.styles[cursor] === this.prevStyles[cursor]
          ) {
            break;
          }
          end += 1;
        }

        output += `\x1b[${y + 1};${start + 1}H`;
        for (let k = start; k < end; k += 1) {
          const cursor = y * this.cols + k;
          const ch = this.chars[cursor];
          if (ch === '') continue;
          if (this.styles[cursor] !== current) {
            current = this.styles[cursor];
            output += current ? current.sgr : '\x1b[0m';
          }
          output += ch;
        }
        x = end;
      }
    }

    if (this.caret) {
      output += `\x1b[${this.caret.y + 1};${this.caret.x + 1}H\x1b[?25h`;
    } else {
      output += '\x1b[?25l';
    }

    if (output) this.out.write(output);
    this.prevChars = this.chars.slice();
    this.prevStyles = this.styles.slice();
  }

  /** Plain-text snapshot, useful for tests and `--dump`. */
  renderToString() {
    const lines = [];
    for (let y = 0; y < this.rows; y += 1) {
      let line = '';
      for (let x = 0; x < this.cols; x += 1) {
        const ch = this.chars[y * this.cols + x];
        line += ch === '' ? '' : ch;
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
}

export function enterScreen(out = process.stdout) {
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  // 1000 = click, 1002 = drag motion, 1006 = SGR coordinates.
  out.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  out.write('\x1b[?2004h');
  // Ask terminals that support it to report modified Enter/Tab as CSI-u:
  // xterm's modifyOtherKeys and the kitty keyboard protocol. Unsupported
  // terminals (VTE 0.68 and older) ignore both; Alt+Enter and Ctrl+J remain
  // available as newline fallbacks there.
  out.write('\x1b[>4;2m');
  out.write('\x1b[>1u');
}

export function leaveScreen(out = process.stdout) {
  out.write('\x1b[<u');
  out.write('\x1b[>4;0m');
  out.write('\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l');
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
}
