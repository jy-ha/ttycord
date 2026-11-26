import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { TermInput } from '../src/tui/input.js';

function makeInput() {
  const stream = new EventEmitter();
  stream.setRawMode = () => {};
  stream.resume = () => {};
  stream.setEncoding = () => {};
  stream.pause = () => {};
  const input = new TermInput(stream);
  const keys = [];
  const texts = [];
  const pastes = [];
  input.on('key', (key) => keys.push(key));
  input.on('text', (text) => texts.push(text));
  input.on('paste', (text) => pastes.push(text));
  const feed = (chunk) => {
    input.buffer += chunk;
    input.parse();
  };
  return { input, keys, texts, pastes, feed };
}

test('plain Enter is a plain enter key', () => {
  const { keys, feed } = makeInput();
  feed('\r');
  assert.deepEqual(keys, [{ type: 'key', key: 'enter', ctrl: false, alt: false, shift: false }]);
});

test('Ctrl+J arrives as LF and maps to a modified enter', () => {
  const { keys, feed } = makeInput();
  feed('\n');
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key, 'enter');
  assert.equal(keys[0].ctrl, true);
});

test('Alt+Enter is an ESC followed by CR', () => {
  const { keys, feed } = makeInput();
  feed('\u001b\r');
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key, 'enter');
  assert.equal(keys[0].alt, true);
});

test('kitty CSI-u reports Ctrl+Enter, Shift+Enter and Alt+Enter', () => {
  const { keys, feed } = makeInput();
  feed('\u001b[13;5u');
  feed('\u001b[13;2u');
  feed('\u001b[13;3u');
  assert.deepEqual(
    keys.map((key) => [key.key, key.ctrl, key.shift, key.alt]),
    [
      ['enter', true, false, false],
      ['enter', false, true, false],
      ['enter', false, false, true],
    ],
  );
});

test('kitty CSI-u tolerates event-type suffixes', () => {
  const { keys, feed } = makeInput();
  feed('\u001b[13;5:1u');
  assert.equal(keys[0].key, 'enter');
  assert.equal(keys[0].ctrl, true);
});

test('modifyOtherKeys reports Ctrl+Enter and Shift+Enter', () => {
  const { keys, feed } = makeInput();
  feed('\u001b[27;5;13~');
  feed('\u001b[27;2;13~');
  assert.deepEqual(
    keys.map((key) => [key.key, key.ctrl, key.shift]),
    [
      ['enter', true, false],
      ['enter', false, true],
    ],
  );
});

test('modifyOtherKeys reports Ctrl+J as a modified j', () => {
  const { keys, feed } = makeInput();
  feed('\u001b[27;5;106~');
  assert.equal(keys[0].key, 'j');
  assert.equal(keys[0].ctrl, true);
});

test('CSI-u printable text and Ctrl+letters stay usable', () => {
  const { keys, texts, feed } = makeInput();
  feed('\u001b[97u');
  feed('\u001b[97;5u');
  assert.deepEqual(texts, ['a']);
  assert.equal(keys[0].key, 'a');
  assert.equal(keys[0].ctrl, true);
});

test('bracketed paste still delivers multiline text as a paste', () => {
  const { pastes, feed } = makeInput();
  feed('\u001b[200~first\nsecond\u001b[201~');
  assert.deepEqual(pastes, ['first\nsecond']);
});

test('a CSI sequence split across chunks is not misread as Alt+[', () => {
  const { keys, texts, feed } = makeInput();
  feed('\u001b[13;');
  assert.equal(keys.length, 0);
  assert.equal(texts.length, 0);
  feed('5u');
  assert.equal(keys[0].key, 'enter');
  assert.equal(keys[0].ctrl, true);
});

test('a lone escape still resolves after the timeout', async () => {
  const { keys, feed } = makeInput();
  feed('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(keys[0].key, 'escape');
});
