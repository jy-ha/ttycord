import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { proxyBinaryPath, spoofEnabled, startSpoofProxy } from '../src/spoof.js';

function fixture(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ttycord-spoof-'));
  const file = path.join(dir, 'spoof-proxy');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return { dir, file };
}

test('proxyBinaryPath honours the environment override', () => {
  const env = { TTYCORD_SPOOF_PROXY: '/opt/custom/proxy' };
  assert.equal(proxyBinaryPath(env, 'linux'), '/opt/custom/proxy');
});

test('proxyBinaryPath falls back to the built helper', () => {
  const linux = proxyBinaryPath({}, 'linux');
  assert.match(linux, /spoof-proxy[/\\]bin[/\\]spoof-proxy$/);
  const windows = proxyBinaryPath({}, 'win32');
  assert.match(windows, /spoof-proxy\.exe$/);
});

test('startSpoofProxy explains how to build a missing helper', async () => {
  await assert.rejects(
    startSpoofProxy({ binary: '/nonexistent/spoof-proxy' }),
    /npm run build:proxy/,
  );
});

test('startSpoofProxy reads the ready line and can be closed', async () => {
  const { dir, file } = fixture(`
    console.log(JSON.stringify({ rest: 'http://127.0.0.1:1111', gateway: 'ws://127.0.0.1:2222', profile: 'Chrome 154' }));
    setInterval(() => {}, 1000);
  `);
  try {
    const proxy = await startSpoofProxy({ binary: file });
    assert.equal(proxy.restUrl, 'http://127.0.0.1:1111');
    assert.equal(proxy.gatewayUrl, 'ws://127.0.0.1:2222');
    assert.equal(proxy.profile, 'Chrome 154');
    proxy.close();
    proxy.close(); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startSpoofProxy rejects when the helper exits early', async () => {
  const { dir, file } = fixture('process.exit(3);');
  try {
    await assert.rejects(startSpoofProxy({ binary: file }), /종료되었습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startSpoofProxy rejects an unparseable ready line', async () => {
  const { dir, file } = fixture(`
    console.log('not json');
    setInterval(() => {}, 1000);
  `);
  try {
    await assert.rejects(startSpoofProxy({ binary: file }), /해석할 수 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the proxy is on by default', () => {
  assert.equal(spoofEnabled({ spoof: true, noSpoof: false }, {}), true);
  assert.equal(spoofEnabled({}, {}), true);
});

test('--no-spoof and TTYCORD_SPOOF=0 disable the proxy', () => {
  assert.equal(spoofEnabled({ spoof: true, noSpoof: true }, {}), false);
  for (const value of ['0', 'false', 'off', 'no', 'FALSE']) {
    assert.equal(spoofEnabled({ spoof: true }, { TTYCORD_SPOOF: value }), false);
  }
});

test('TTYCORD_SPOOF=1 re-enables the proxy', () => {
  for (const value of ['1', 'true', 'on', 'yes']) {
    assert.equal(spoofEnabled({ spoof: false }, { TTYCORD_SPOOF: value }), true);
  }
});
