/** Raw-mode terminal input: keys, SGR mouse and bracketed paste. */

import { EventEmitter } from 'node:events';

const ESC_TIMEOUT = 30;

const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
};

const TILDE_KEYS = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

function modifiers(value) {
  const mask = Math.max(1, value || 1) - 1;
  return {
    shift: Boolean(mask & 1),
    alt: Boolean(mask & 2),
    ctrl: Boolean(mask & 4),
  };
}

/** Non-printable key codes shared by the CSI-u and modifyOtherKeys forms. */
function namedKey(code) {
  switch (code) {
    case 8:
    case 127:
      return 'backspace';
    case 9:
      return 'tab';
    case 13:
      return 'enter';
    case 27:
      return 'escape';
    default:
      return '';
  }
}

export class TermInput extends EventEmitter {
  constructor(stream = process.stdin) {
    super();
    this.stream = stream;
    this.buffer = '';
    this.timer = null;
    this.started = false;
    this.onData = (chunk) => {
      this.buffer += chunk;
      this.parse();
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stream.setRawMode(true);
    this.stream.resume();
    this.stream.setEncoding('utf8');
    this.stream.on('data', this.onData);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.stream.off('data', this.onData);
    if (this.stream.isTTY) this.stream.setRawMode(false);
    this.stream.pause();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  parse() {
    while (this.buffer) {
      if (!this.parseOne()) return;
    }
  }

  parseOne() {
    // A previous chunk may have armed the lone-ESC / incomplete-sequence
    // timeout; the buffer changed, so restart the decision from scratch.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const buffer = this.buffer;

    if (buffer[0] === '\u001b') {
      if (buffer.startsWith('\u001b[200~')) {
        const end = buffer.indexOf('\u001b[201~', 6);
        if (end < 0) return this.wait();
        const text = buffer.slice(6, end);
        this.buffer = buffer.slice(end + 6);
        this.emit('paste', text);
        return true;
      }

      const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buffer);
      if (mouse) {
        this.buffer = buffer.slice(mouse[0].length);
        this.emitMouse(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4]);
        return true;
      }

      const csi = /^\u001b\[([0-9;:]*)([A-Za-z~])/.exec(buffer);
      if (csi) {
        this.buffer = buffer.slice(csi[0].length);
        this.emitCsi(csi[1], csi[2]);
        return true;
      }

      const ss3 = /^\u001bO([A-Za-z])/.exec(buffer);
      if (ss3) {
        this.buffer = buffer.slice(ss3[0].length);
        const key = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }[ss3[1]];
        if (key) this.emit('key', { type: 'key', key, ctrl: false, alt: false, shift: false });
        return true;
      }

      if (buffer.length === 1) return this.wait();

      // An incomplete CSI/SS3 sequence (the rest may arrive in another chunk).
      // Wait instead of treating ESC as Alt+[ or Alt+O.
      if (buffer.startsWith('\u001b[') || buffer.startsWith('\u001bO')) return this.wait();

      // Alt+Enter: ESC followed by CR/LF. VTE and most terminals send this,
      // which makes it a reliable "newline" fallback where Ctrl+Enter is not
      // distinguishable from plain Enter.
      if (buffer.startsWith('\u001b\r') || buffer.startsWith('\u001b\n')) {
        this.buffer = buffer.slice(2);
        this.emit('key', { type: 'key', key: 'enter', ctrl: false, alt: true, shift: false });
        return true;
      }

      const ch = String.fromCodePoint(buffer.codePointAt(1));
      this.buffer = buffer.slice(1 + ch.length);
      this.emit('key', {
        type: 'key',
        key: ch,
        text: ch,
        ctrl: false,
        alt: true,
        shift: false,
      });
      return true;
    }

    const ch = String.fromCodePoint(buffer.codePointAt(0));
    this.buffer = buffer.slice(ch.length);

    if (ch === '\r') {
      this.emit('key', { type: 'key', key: 'enter', ctrl: false, alt: false, shift: false });
      return true;
    }
    if (ch === '\n') {
      // Ctrl+J is a second newline fallback for terminals that cannot report
      // modified Enter. Plain Enter arrives as CR on every common terminal.
      this.emit('key', { type: 'key', key: 'enter', ctrl: true, alt: false, shift: false });
      return true;
    }
    if (ch === '\u007f' || ch === '\b') {
      this.emit('key', { type: 'key', key: 'backspace', ctrl: false, alt: false, shift: false });
      return true;
    }
    if (ch === '\t') {
      this.emit('key', { type: 'key', key: 'tab', ctrl: false, alt: false, shift: false });
      return true;
    }
    const code = ch.codePointAt(0);
    if (code < 32) {
      this.emit('key', {
        type: 'key',
        key: String.fromCharCode(96 + code),
        ctrl: true,
        alt: false,
        shift: false,
      });
      return true;
    }
    this.emit('text', ch);
    return true;
  }

  emitCsi(params, final) {
    const parts =
      params === ''
        ? []
        : params.split(';').map((value) => Number(value.split(':')[0] || 0));
    const base = parts[0] || 0;
    const mods = modifiers(parts[1] ?? 1);

    // Kitty keyboard protocol: CSI code ; modifier u
    if (final === 'u') {
      this.emitCode(base, mods);
      return;
    }
    // xterm modifyOtherKeys: CSI 27 ; modifier ; code ~
    if (final === '~' && base === 27 && parts.length >= 3) {
      this.emitCode(parts[2] || 0, mods);
      return;
    }
    if (CSI_KEYS[final]) {
      let key = CSI_KEYS[final];
      if (final === 'Z') {
        this.emit('key', { type: 'key', key: 'tab', ctrl: false, alt: false, shift: true });
        return;
      }
      this.emit('key', { type: 'key', key, ...mods });
      return;
    }
    if (final === '~') {
      const key = TILDE_KEYS[base];
      if (key) this.emit('key', { type: 'key', key, ...mods });
    }
  }

  /** Emit a key described by a Unicode code point plus modifiers. */
  emitCode(code, mods) {
    if (!code) return;
    const named = namedKey(code);
    if (named) {
      this.emit('key', { type: 'key', key: named, ...mods });
      return;
    }
    if (code < 32) {
      // CSI-u form of Ctrl+letter.
      const key = String.fromCharCode(96 + code);
      this.emit('key', { type: 'key', key, text: key, ...mods });
      return;
    }
    const ch = String.fromCodePoint(code);
    if (mods.ctrl || mods.alt) {
      this.emit('key', { type: 'key', key: ch, text: ch, ...mods });
      return;
    }
    // Normal typing still arrives as text on terminals that only enable the
    // "disambiguate" flag, but handle CSI-u text too.
    this.emit('text', mods.shift && /[a-z]/.test(ch) ? ch.toUpperCase() : ch);
  }

  emitMouse(button, x, y, final) {
    const wheel = button & 64;
    this.emit('mouse', {
      type: 'mouse',
      x: x - 1,
      y: y - 1,
      button: button & 3,
      wheel: wheel ? (button & 1 ? 'down' : 'up') : null,
      action: final === 'M' ? 'press' : 'release',
      // Bit 32 marks a motion event (button held down); 1002 mode only sends
      // these while a button is pressed, which is exactly what drag selection
      // needs.
      motion: Boolean(button & 32),
      shift: Boolean(button & 4),
      alt: Boolean(button & 8),
      ctrl: Boolean(button & 16),
    });
  }

  wait() {
    if (this.timer) return false;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.buffer === '\u001b') {
        this.buffer = '';
        this.emit('key', { type: 'key', key: 'escape', ctrl: false, alt: false, shift: false });
        return;
      }
      // A malformed / unsupported sequence: drop the ESC and keep the rest.
      this.buffer = this.buffer.replace(/^\u001b\[?/, '');
      this.parse();
    }, ESC_TIMEOUT);
    return false;
  }
}
