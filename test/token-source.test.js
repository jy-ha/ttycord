import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractTokens,
  findLocalToken,
  scanLevelDb,
  validateToken,
} from '../src/token-source.js';

// Split so the repository never contains a token-shaped literal.
const TOKEN = ['MTAwMDAwMDAwMDAwMDAwMDAw', 'GA0000', 'dGVzdC1zaWduYXR1cmUtZm9yLXR0eWNvcmQtdGVzdHM'].join('.');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ttycord-test-'));
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    async json() {
      return body;
    },
  };
}

test('extractTokens finds and deduplicates tokens', () => {
  const tokens = extractTokens(`x ${TOKEN} y ${TOKEN} z`);
  assert.deepEqual(tokens, [TOKEN]);
  assert.deepEqual(extractTokens('no token here'), []);
});

test('scanLevelDb reads .ldb and .log but ignores other files', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, '000001.ldb'), `junk ${TOKEN} junk`);
    fs.writeFileSync(path.join(dir, '000002.log'), `again ${TOKEN}`);
    fs.writeFileSync(path.join(dir, 'notes.txt'), TOKEN);
    assert.deepEqual(scanLevelDb(dir), [TOKEN]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateToken returns the user on success', async () => {
  const user = await validateToken(TOKEN, {
    fetchImpl: async () => response(200, { id: '1', username: 'me' }),
  });
  assert.equal(user.username, 'me');
});

test('validateToken returns null on failure', async () => {
  const user = await validateToken(TOKEN, {
    fetchImpl: async () => response(401, { message: 'Unauthorized' }),
  });
  assert.equal(user, null);
});

test('findLocalToken validates candidates in order', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, '000001.ldb'), TOKEN);
    const found = await findLocalToken({
      dirs: [dir],
      fetchImpl: async () => response(200, { id: '1', username: 'me' }),
    });
    assert.equal(found.token, TOKEN);
    assert.equal(found.user.username, 'me');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateToken sends the same browser headers as the REST client', async () => {
  let headers = null;
  await validateToken(TOKEN, {
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return response(200, { id: '1', username: 'me' });
    },
  });
  assert.match(headers['User-Agent'], /Chrome\/154\.0\.0\.0/);
  assert.match(headers['Sec-Ch-Ua'], /Google Chrome";v="154"/);
  assert.equal(headers.Priority, 'u=1, i');
  assert.ok(headers['X-Super-Properties']);
});
