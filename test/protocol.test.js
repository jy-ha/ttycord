import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordError, RestClient } from '../src/protocol/rest.js';
import { discordLocale } from '../src/protocol/properties.js';

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    headers: new Headers(headers),
    async text() {
      if (body === undefined || body === null) return '';
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

test('REST client sends browser headers and parses JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(200, { id: '1', username: 'me' });
  };
  const client = new RestClient({ token: 'tok', fetchImpl, minInterval: 0 });
  const me = await client.me();
  assert.equal(me.username, 'me');
  assert.match(calls[0].url, /\/users\/@me$/);
  assert.equal(calls[0].init.headers.Authorization, 'tok');
  assert.ok(calls[0].init.headers['X-Super-Properties']);
  assert.match(calls[0].init.headers['User-Agent'], /Chrome\/154\.0\.0\.0/);
  assert.match(calls[0].init.headers['Sec-Ch-Ua'], /Chromium";v="154"/);
  assert.match(calls[0].init.headers['Sec-Ch-Ua'], /Google Chrome";v="154"/);
  assert.equal(calls[0].init.headers.Priority, 'u=1, i');
  assert.equal(calls[0].init.headers['Sec-Ch-Ua-Platform'], '"Linux"');
  assert.equal(calls[0].init.headers['X-Discord-Locale'], discordLocale());
  assert.equal(calls[0].init.headers['Accept-Encoding'], 'gzip, deflate, br');
  // Chrome does not send Origin on a same-origin GET.
  assert.equal(calls[0].init.headers.Origin, undefined);
});

test('REST client supports bot authorization', async () => {
  let authorization = '';
  const fetchImpl = async (_url, init) => {
    authorization = init.headers.Authorization;
    return response(200, { ok: true });
  };
  const client = new RestClient({ token: 'abc', tokenType: 'bot', fetchImpl, minInterval: 0 });
  await client.get('/x');
  assert.equal(authorization, 'Bot abc');
});

test('REST client retries 429 responses', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    if (count === 1) {
      return response(429, { message: 'rate limited', retry_after: 0.001 }, { 'retry-after': '0.001' });
    }
    return response(200, { ok: true });
  };
  const client = new RestClient({ token: 't', fetchImpl, minInterval: 0, maxRetries: 1 });
  const data = await client.get('/rate');
  assert.deepEqual(data, { ok: true });
  assert.equal(count, 2);
});

test('REST client raises DiscordError for API errors', async () => {
  const fetchImpl = async () =>
    response(401, { message: '401: Unauthorized', code: 0 });
  const client = new RestClient({ token: 'bad', fetchImpl, minInterval: 0, maxRetries: 0 });
  await assert.rejects(
    () => client.me(),
    (error) => {
      assert.ok(error instanceof DiscordError);
      assert.equal(error.status, 401);
      assert.match(error.message, /Unauthorized/);
      return true;
    },
  );
});

test('REST client builds query strings and skips empty values', async () => {
  let url = '';
  const fetchImpl = async (target) => {
    url = target;
    return response(200, []);
  };
  const client = new RestClient({ token: 't', fetchImpl, minInterval: 0 });
  await client.messages('123', { limit: 50, before: '', after: undefined });
  assert.match(url, /\/channels\/123\/messages\?limit=50$/);
});

test('REST client ack posts the documented payload', async () => {
  let body = '';
  const fetchImpl = async (_url, init) => {
    body = init.body;
    return response(204, undefined);
  };
  const client = new RestClient({ token: 't', fetchImpl, minInterval: 0 });
  const result = await client.ack('123', '456');
  assert.equal(result, null);
  assert.deepEqual(JSON.parse(body), { token: null });
});

test('identity is a consistent Chrome 154 web client', async () => {
  const { USER_AGENT, SEC_CH_UA_PLATFORM, secChUa, superProperties } = await import(
    '../src/protocol/properties.js'
  );
  assert.match(USER_AGENT, /Chrome\/154\.0\.0\.0/);
  assert.doesNotMatch(USER_AGENT, /Electron|discord\//);
  assert.equal(SEC_CH_UA_PLATFORM, '"Linux"');

  // Chromium's GREASE algorithm for major 154.
  assert.equal(
    secChUa(),
    '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
  );
  // Another branch of the same algorithm: major 120.
  assert.equal(
    secChUa('Chrome', '120'),
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  );

  const props = superProperties();
  assert.equal(props.browser, 'Chrome');
  assert.equal(props.browser_version, '154.0.0.0');
  assert.equal(props.device, '');
  assert.equal(props.device_model_name, '');
  assert.equal(props.browser_user_agent, USER_AGENT);
  // The web client's build number, not the desktop shell's.
  assert.equal(props.client_build_number, 671535);
  // Desktop-only fields: the web client omits them entirely.
  assert.equal(props.os_arch, undefined);
  assert.equal(props.app_arch, undefined);
  assert.equal(props.native_build_number, undefined);
  // A Linux UA carries no OS version, so the browser-side value is empty.
  assert.equal(props.os_version, '');
});

test('Discord locale is normalised to its own enum', async () => {
  const { acceptLanguage, discordLocale } = await import('../src/protocol/properties.js');

  // Discord's Korean locale is `ko`; `ko-KR` is not a valid X-Discord-Locale.
  assert.equal(discordLocale('ko-KR'), 'ko');
  assert.equal(discordLocale('en-US'), 'en-US');
  assert.equal(discordLocale('en-GB'), 'en-GB');
  assert.equal(discordLocale('ja-JP'), 'ja');
  assert.equal(discordLocale('zh-CN'), 'zh-CN');
  assert.equal(discordLocale('pt-BR'), 'pt-BR');
  assert.equal(discordLocale('en'), 'en-US');
  assert.equal(discordLocale('xx-YY'), 'en-US');

  // Accept-Language keeps the BCP-47 tag and does not duplicate it.
  assert.equal(acceptLanguage('ko-KR'), 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.equal(acceptLanguage('en-US'), 'en-US,en;q=0.9');
  assert.equal(acceptLanguage('ko'), 'ko,en-US;q=0.8,en;q=0.7');
});

test('POST requests carry Origin like Chrome, GET does not', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(200, { ok: true });
  };
  const client = new RestClient({ token: 'tok', fetchImpl, minInterval: 0 });
  await client.get('/channels/1/messages');
  await client.post('/channels/1/messages', { content: 'hi' });
  assert.equal(calls[0].init.headers.Origin, undefined);
  assert.equal(calls[1].init.headers.Origin, 'https://discord.com');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
});

test('sendMessageWithFiles uses payload_json and files[n] parts', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(200, { id: '5', content: 'hi', attachments: [] });
  };
  const client = new RestClient({ token: 'tok', fetchImpl, minInterval: 0 });
  const result = await client.sendMessageWithFiles(
    '123',
    'hi',
    [
      { filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') },
      { filename: 'b.png', contentType: 'image/png', data: new Uint8Array([1, 2, 3]) },
    ],
    { nonce: 'n1' },
  );

  assert.equal(result.id, '5');
  const { init } = calls[0];
  assert.match(calls[0].url, /\/channels\/123\/messages$/);
  // fetch must be allowed to set the multipart boundary itself.
  assert.equal(init.headers['Content-Type'], undefined);
  assert.ok(init.body instanceof FormData);

  const payload = JSON.parse(init.body.get('payload_json'));
  assert.deepEqual(payload, {
    content: 'hi',
    tts: false,
    nonce: 'n1',
    attachments: [
      { id: 0, filename: 'a.txt' },
      { id: 1, filename: 'b.png' },
    ],
  });

  const first = init.body.get('files[0]');
  assert.equal(first.name, 'a.txt');
  assert.equal(await first.text(), 'hello');
  const second = init.body.get('files[1]');
  assert.equal(second.name, 'b.png');
  assert.equal(second.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [1, 2, 3]);
});

test('sendMessageWithFiles without files stays JSON', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return response(200, { id: '6' });
  };
  const client = new RestClient({ token: 'tok', fetchImpl, minInterval: 0 });
  await client.sendMessageWithFiles('123', 'hi', [], { nonce: 'n2' });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { content: 'hi', tts: false, nonce: 'n2' });
});
