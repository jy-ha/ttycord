import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { playSound, resolveSound } from '../src/tui/sound.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ttycord-sound-'));
}

function touch(file, mode = 0o755) {
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, mode);
  return file;
}

test('TTYCORD_SOUND=off and bell resolve without a player', () => {
  assert.deepEqual(resolveSound({ TTYCORD_SOUND: 'off', PATH: '' }), { mode: 'off' });
  assert.deepEqual(resolveSound({ TTYCORD_SOUND: 'silent', PATH: '' }), { mode: 'off' });
  assert.deepEqual(resolveSound({ TTYCORD_SOUND: 'bell', PATH: '' }), { mode: 'bell' });
});

test('a custom sound file resolves to the first player on PATH', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'ding.oga');
    fs.writeFileSync(file, 'not really audio');
    const paplay = touch(path.join(dir, 'paplay'));
    const plan = resolveSound({ TTYCORD_SOUND: file, PATH: dir });
    assert.equal(plan.mode, 'play');
    assert.equal(plan.command, 'paplay');
    assert.deepEqual(plan.args, [file]);
    assert.equal(plan.file, file);
    assert.ok(fs.existsSync(paplay));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the player order prefers paplay and falls back to aplay', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'ding.oga');
    fs.writeFileSync(file, 'x');
    touch(path.join(dir, 'aplay'));
    const plan = resolveSound({ TTYCORD_SOUND: file, PATH: dir });
    assert.equal(plan.command, 'aplay');
    assert.deepEqual(plan.args, ['-q', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file or player falls back to the terminal bell', () => {
  const dir = tempDir();
  try {
    assert.equal(resolveSound({ TTYCORD_SOUND: path.join(dir, 'missing.oga'), PATH: dir }).mode, 'bell');
    const file = path.join(dir, 'ding.oga');
    fs.writeFileSync(file, 'x');
    assert.equal(resolveSound({ TTYCORD_SOUND: file, PATH: dir }).mode, 'bell');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TTYCORD_SOUND_CMD overrides the player command', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'ding.oga');
    fs.writeFileSync(file, 'x');
    const player = touch(path.join(dir, 'my-player'));
    const plan = resolveSound({
      TTYCORD_SOUND: file,
      TTYCORD_SOUND_CMD: player,
      PATH: '',
    });
    assert.equal(plan.mode, 'play');
    assert.equal(plan.command, player);
    assert.deepEqual(plan.args, [file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('playSound spawns a detached player and reports play', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'ding.oga');
    fs.writeFileSync(file, 'x');
    touch(path.join(dir, 'paplay'));
    const calls = [];
    const spawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      return { on() {}, unref() {} };
    };

    const result = playSound({
      env: { TTYCORD_SOUND: file, PATH: dir },
      spawnFn,
    });

    assert.equal(result, 'play');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'paplay');
    assert.deepEqual(calls[0].args, [file]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('playSound returns the mode without spawning when silent', () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    return { on() {}, unref() {} };
  };
  assert.equal(playSound({ env: { TTYCORD_SOUND: 'off' }, spawnFn }), 'off');
  assert.equal(playSound({ env: { TTYCORD_SOUND: 'bell' }, spawnFn }), 'bell');
  assert.equal(spawned, false);
});

test('a spawn failure degrades to the terminal bell', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'ding.oga');
    fs.writeFileSync(file, 'x');
    touch(path.join(dir, 'paplay'));
    const result = playSound({
      env: { TTYCORD_SOUND: file, PATH: dir },
      spawnFn: () => {
        throw new Error('no audio');
      },
    });
    assert.equal(result, 'bell');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
