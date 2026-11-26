import test from 'node:test';
import assert from 'node:assert/strict';

import { Screen, enterScreen, leaveScreen } from '../src/tui/term.js';

function capture(run) {
  const chunks = [];
  run({ write: (value) => chunks.push(value) });
  return chunks.join('');
}

test('enterScreen enables mouse, paste and modified-key reporting', () => {
  const out = capture(enterScreen);
  assert.match(out, /\u001b\[\?1049h/); // alternate screen
  assert.match(out, /\u001b\[\?1002h/); // drag motion
  assert.match(out, /\u001b\[\?1006h/); // SGR mouse
  assert.match(out, /\u001b\[\?2004h/); // bracketed paste
  assert.match(out, /\u001b\[>4;2m/); // xterm modifyOtherKeys
  assert.match(out, /\u001b\[>1u/); // kitty keyboard protocol
});

test('leaveScreen resets the keyboard protocols and the screen', () => {
  const out = capture(leaveScreen);
  assert.match(out, /\u001b\[<u/);
  assert.match(out, /\u001b\[>4;0m/);
  assert.match(out, /\u001b\[\?2004l/);
  assert.match(out, /\u001b\[\?1049l/);
});

test('invalidate forces a full repaint after the terminal lost its frame', () => {
  const chunks = [];
  const out = {
    isTTY: true,
    columns: 20,
    rows: 8,
    write(value) {
      chunks.push(value);
    },
  };
  const screen = new Screen(out);
  screen.set(0, 0, 'x');
  screen.flush();
  chunks.length = 0;

  screen.flush();
  assert.doesNotMatch(chunks.join(''), /x/, 'an unchanged cell is not repainted');

  screen.invalidate();
  screen.flush();
  assert.match(chunks.join(''), /x/, 'the next frame is painted again');
});
