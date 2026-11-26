import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordClient } from '../src/client.js';
import { LiveSession } from '../src/live.js';

test('DiscordClient threads baseUrl and gatewayUrl', () => {
  const client = new DiscordClient({
    token: 'tok',
    baseUrl: 'http://127.0.0.1:1111/api/v9',
    gatewayUrl: 'ws://127.0.0.1:2222',
  });
  assert.equal(client.rest.baseUrl, 'http://127.0.0.1:1111/api/v9');
  assert.equal(client.gatewayUrl, 'ws://127.0.0.1:2222');
});

test('DiscordClient leaves the defaults alone', () => {
  const client = new DiscordClient({ token: 'tok' });
  assert.equal(client.rest.baseUrl, 'https://discord.com/api/v9');
  assert.equal(client.gatewayUrl, null);
});

test('LiveSession rewrites resume URLs back onto the proxy', () => {
  const client = { token: 'tok', gatewayUrl: 'ws://127.0.0.1:2222' };
  const live = new LiveSession(client, {});
  assert.equal(live.gateway.url, 'ws://127.0.0.1:2222');
  // Not locked: READY's resume URL is followed, but only via the proxy.
  assert.equal(live.gateway.urlLocked, false);
  const rewritten = live.gateway.urlRewrite(
    'wss://gateway-us-east1-b.discord.gg/?v=9&encoding=json',
  );
  assert.equal(rewritten.url, 'ws://127.0.0.1:2222/?v=9&encoding=json');
  assert.deepEqual(rewritten.headers, { 'X-Spoof-Host': 'gateway-us-east1-b.discord.gg' });
});

test('LiveSession keeps the default gateway without a proxy', () => {
  const client = { token: 'tok', gatewayUrl: null };
  const live = new LiveSession(client, {});
  assert.equal(live.gateway.url, 'wss://gateway.discord.gg');
  assert.equal(live.gateway.urlLocked, false);
});

test('DiscordClient forwards attachment uploads to REST', async () => {
  const client = new DiscordClient({ token: 'tok' });
  const calls = [];
  client.rest.sendMessageWithFiles = async (...args) => {
    calls.push(args);
    return { id: '1' };
  };
  const files = [{ filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('x') }];
  const result = await client.sendMessageWithFiles('42', 'hi', files, { nonce: 'n' });
  assert.equal(result.id, '1');
  assert.deepEqual(calls, [['42', 'hi', files, { nonce: 'n' }]]);
});
