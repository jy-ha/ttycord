import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway, closeReason, isFatalCloseCode } from '../src/protocol/gateway.js';

test('fatal close codes are classified', () => {
  assert.equal(isFatalCloseCode(4004), true);
  assert.equal(isFatalCloseCode(4014), true);
  assert.equal(isFatalCloseCode(4000), false);
  assert.match(closeReason(4004), /인증/);
  assert.match(closeReason(9999), /종료/);
});

test('HELLO triggers IDENTIFY', () => {
  const gateway = new Gateway({ token: 'tok' });
  const sent = [];
  gateway.send = (payload) => {
    sent.push(payload);
    return true;
  };
  gateway.handlePayload({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 2);
  assert.equal(sent[0].d.token, 'tok');
  assert.equal(sent[0].d.capabilities, 8701);
  assert.equal(sent[0].d.compress, false);
  gateway.close();
});

test('READY stores the session and emits', () => {
  const gateway = new Gateway({ token: 'tok' });
  let ready = null;
  gateway.on('ready', (data) => {
    ready = data;
  });
  gateway.handlePayload({
    op: 0,
    s: 1,
    t: 'READY',
    d: {
      session_id: 'session-1',
      resume_gateway_url: 'wss://resume.example',
      user: { id: '1', username: 'me' },
    },
  });
  assert.equal(gateway.sessionId, 'session-1');
  assert.equal(gateway.resumeUrl, 'wss://resume.example');
  assert.equal(gateway.seq, 1);
  assert.equal(gateway.state, 'online');
  assert.equal(ready.user.username, 'me');
  gateway.close();
});

test('heartbeat requests are answered with the sequence', () => {
  const gateway = new Gateway({ token: 'tok' });
  const sent = [];
  gateway.send = (payload) => {
    sent.push(payload);
    return true;
  };
  gateway.seq = 42;
  gateway.handlePayload({ op: 1 });
  assert.deepEqual(sent[0], { op: 1, d: 42 });
  gateway.close();
});

test('RESUME is sent when a session exists', () => {
  const gateway = new Gateway({ token: 'tok' });
  const sent = [];
  gateway.send = (payload) => {
    sent.push(payload);
    return true;
  };
  gateway.sessionId = 'session-1';
  gateway.seq = 7;
  gateway.handlePayload({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(sent[0].op, 6);
  assert.equal(sent[0].d.session_id, 'session-1');
  assert.equal(sent[0].d.seq, 7);
  gateway.close();
});

test('invalid session without resume clears the session', () => {
  const gateway = new Gateway({ token: 'tok' });
  gateway.sessionId = 'session-1';
  gateway.seq = 3;
  gateway.handleInvalidSession(false);
  assert.equal(gateway.sessionId, null);
  assert.equal(gateway.seq, null);
  gateway.close();
});

test('urlLocked ignores the advertised resume gateway', () => {
  const gateway = new Gateway({ token: 'tok', url: 'ws://127.0.0.1:9000', urlLocked: true });
  gateway.handlePayload({
    op: 0,
    s: 1,
    t: 'READY',
    d: { session_id: 's1', resume_gateway_url: 'wss://resume.example', user: { id: '1' } },
  });
  assert.equal(gateway.sessionId, 's1');
  assert.equal(gateway.resumeUrl, null);
  gateway.close();
});

test('a locked gateway reconnects through its own URL', () => {
  const seen = [];
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) {
      seen.push(url);
      this.readyState = 0;
    }
    addEventListener() {}
    close() {}
  };
  try {
    const gateway = new Gateway({ token: 'tok', url: 'ws://127.0.0.1:9000', urlLocked: true });
    gateway.sessionId = 's1';
    gateway.resumeUrl = 'wss://resume.example';
    gateway.connect();
    assert.equal(seen[0], 'ws://127.0.0.1:9000/?v=9&encoding=json');
    gateway.close();
  } finally {
    globalThis.WebSocket = original;
  }
});

// ------------------------------------------------------------ wake/recovery
test('an unacknowledged heartbeat reconnects without waiting for the interval', async () => {
  const gateway = new Gateway({ token: 'tok', ackTimeout: 10 });
  let reconnects = 0;
  gateway.send = () => true;
  gateway.reconnect = () => {
    reconnects += 1;
  };

  gateway.sendHeartbeat();
  assert.equal(gateway.acked, false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reconnects, 1);
  gateway.close();
});

test('a heartbeat ACK clears the watchdog', async () => {
  const gateway = new Gateway({ token: 'tok', ackTimeout: 20 });
  let reconnects = 0;
  gateway.send = () => true;
  gateway.reconnect = () => {
    reconnects += 1;
  };

  gateway.sendHeartbeat();
  gateway.handlePayload({ op: 11 });
  assert.equal(gateway.acked, true);
  assert.equal(gateway.ackTimer, null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reconnects, 0);
  gateway.close();
});

test('wake probes a socket that still looks open', () => {
  const gateway = new Gateway({ token: 'tok' });
  const sent = [];
  gateway.ws = { readyState: 1 };
  gateway.acked = true;
  gateway.send = (payload) => {
    sent.push(payload);
    return true;
  };

  gateway.wake();
  assert.deepEqual(sent, [{ op: 1, d: null }]);
  assert.equal(gateway.acked, false);
  assert.ok(gateway.ackTimer, 'the probe is guarded by the ACK timeout');
  gateway.close();
});

test('wake reconnects immediately when a heartbeat was in flight', () => {
  const gateway = new Gateway({ token: 'tok' });
  const calls = [];
  gateway.ws = { readyState: 1 };
  gateway.acked = false;
  gateway.sessionId = 'session-1';
  gateway.reconnect = (resume, options) => {
    calls.push([resume, options]);
  };

  gateway.wake();
  assert.deepEqual(calls, [[true, { immediate: true }]]);
  gateway.close();
});

test('wake reconnects a dead socket without a session from scratch', () => {
  const gateway = new Gateway({ token: 'tok' });
  const calls = [];
  gateway.ws = null;
  gateway.sessionId = null;
  gateway.reconnect = (resume, options) => {
    calls.push([resume, options]);
  };

  gateway.wake();
  assert.deepEqual(calls, [[false, { immediate: true }]]);
  gateway.close();
});

test('an immediate reconnect skips the backoff delay', async () => {
  const gateway = new Gateway({ token: 'tok', urlLocked: true, url: 'ws://127.0.0.1:9000' });
  let connects = 0;
  gateway.connect = () => {
    connects += 1;
  };
  gateway.sessionId = 'session-1';
  gateway.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connects, 1);
  gateway.close();
});

test('wake reconnects immediately when the socket has been silent', () => {
  const gateway = new Gateway({ token: 'tok' });
  const calls = [];
  gateway.ws = { readyState: 1 };
  gateway.acked = true;
  gateway.lastActivityAt = Date.now() - 120_000;
  gateway.reconnect = (resume, options) => {
    calls.push([resume, options]);
  };

  gateway.wake();
  assert.deepEqual(calls, [[false, { immediate: true }]]);
  gateway.close();
});

test('the watchdog reconnects a socket that stopped producing payloads', () => {
  const gateway = new Gateway({ token: 'tok' });
  const calls = [];
  gateway.state = 'online';
  gateway.ws = { readyState: 1 };
  gateway.lastActivityAt = Date.now() - 120_000;
  gateway.reconnect = (resume, options) => {
    calls.push([resume, options]);
  };

  gateway.checkHealth();
  assert.deepEqual(calls, [[false, { immediate: true }]]);
  gateway.close();
});

test('the watchdog leaves a recently active socket alone', () => {
  const gateway = new Gateway({ token: 'tok' });
  let reconnects = 0;
  gateway.state = 'online';
  gateway.ws = { readyState: 1 };
  gateway.lastActivityAt = Date.now();
  gateway.reconnect = () => {
    reconnects += 1;
  };

  gateway.checkHealth();
  assert.equal(reconnects, 0);
  gateway.close();
});

test('any gateway payload counts as activity', () => {
  const gateway = new Gateway({ token: 'tok' });
  gateway.lastActivityAt = 0;
  gateway.handlePayload({ op: 11 });
  assert.ok(gateway.lastActivityAt > 0);
  gateway.close();
});
