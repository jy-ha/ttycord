import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clipboardDir, readClipboard, sweepClipboard } from '../src/tui/clipboard-read.js';

/** Stand-in for `spawn`: `handler(command, args, child)` drives the child. */
function fakeSpawn(handler) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    setImmediate(() => handler(command, args, child));
    return child;
  };
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ttycord-clip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('readClipboard turns a clipboard image into an attachable file', async (t) => {
  const dir = await tempDir(t);
  let seen = null;
  const spawnImpl = fakeSpawn((command, args, child) => {
    seen = { command, args };
    const target = args[2];
    // The helper saves the pixbuf itself; mimic that side effect.
    writeFile(target, PNG_HEAD).then(() => {
      child.stdout.emit('data', JSON.stringify({ kind: 'image', file: target }));
      child.emit('close', 0);
    });
  });

  const result = await readClipboard({ dir, spawnImpl, platform: 'linux' });
  assert.equal(seen.command, 'python3');
  assert.equal(result.kind, 'image');
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.size, PNG_HEAD.length);
  assert.match(result.name, /^clipboard-\d{8}-\d{6}\.png$/);
  assert.equal(result.path, join(dir, result.name));
});

test('readClipboard ignores an image claim with no file on disk', async (t) => {
  const dir = await tempDir(t);
  const spawnImpl = fakeSpawn((_command, args, child) => {
    child.stdout.emit('data', JSON.stringify({ kind: 'image', file: args[2] }));
    child.emit('close', 0);
  });
  assert.deepEqual(await readClipboard({ dir, spawnImpl, platform: 'linux' }), { kind: 'none' });
});

test('readClipboard passes copied files and plain text through', async (t) => {
  const dir = await tempDir(t);

  const files = fakeSpawn((_command, _args, child) => {
    child.stdout.emit('data', JSON.stringify({ kind: 'files', uris: ['file:///tmp/a.png'] }));
    child.emit('close', 0);
  });
  assert.deepEqual(await readClipboard({ dir, spawnImpl: files, platform: 'linux' }), {
    kind: 'files',
    uris: ['file:///tmp/a.png'],
  });

  const text = fakeSpawn((_command, _args, child) => {
    child.stdout.emit('data', JSON.stringify({ kind: 'text', text: 'hello' }));
    child.emit('close', 0);
  });
  assert.deepEqual(await readClipboard({ dir, spawnImpl: text, platform: 'linux' }), {
    kind: 'text',
    text: 'hello',
  });
});

test('readClipboard survives a broken or missing helper', async (t) => {
  const dir = await tempDir(t);
  const garbage = fakeSpawn((_command, _args, child) => {
    child.stdout.emit('data', 'not json at all');
    child.emit('close', 1);
  });
  assert.deepEqual(await readClipboard({ dir, spawnImpl: garbage, platform: 'linux' }), {
    kind: 'none',
  });

  const missing = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  assert.deepEqual(await readClipboard({ dir, spawnImpl: missing, platform: 'linux' }), {
    kind: 'none',
  });
});

test('readClipboard is a no-op on platforms without a reader', async () => {
  assert.deepEqual(await readClipboard({ platform: 'win32' }), { kind: 'none' });
});

test('sweepClipboard deletes stale images and keeps fresh ones', async (t) => {
  const dir = await tempDir(t);
  const old = join(dir, 'old.png');
  const fresh = join(dir, 'fresh.png');
  await writeFile(old, PNG_HEAD);
  await writeFile(fresh, PNG_HEAD);
  const past = Date.now() / 1000 - 48 * 60 * 60;
  await utimes(old, past, past);

  assert.equal(sweepClipboard({ dir }), 1);
  assert.equal(sweepClipboard({ dir }), 0);
});

test('clipboardDir lives under the XDG cache and is created', async (t) => {
  const base = await tempDir(t);
  const dir = clipboardDir({ XDG_CACHE_HOME: base });
  assert.equal(dir, join(base, 'ttycord', 'clipboard'));
});
