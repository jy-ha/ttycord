import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveSession } from '../src/live.js';

function makeClient() {
  const me = { id: '1', username: 'me' };
  const users = new Map([[me.id, me]]);
  const channels = new Map();
  const guilds = new Map();
  const acks = [];
  return {
    token: 'test-token',
    me,
    users,
    channels,
    guilds,
    acks,
    user(id) {
      return users.get(String(id)) || null;
    },
    channel(id) {
      return channels.get(String(id)) || null;
    },
    rememberUser(user) {
      if (user?.id) users.set(String(user.id), user);
      return user;
    },
    rememberChannel(channel) {
      if (channel?.id) channels.set(String(channel.id), channel);
      return channel;
    },
    async ack(channelId, messageId) {
      acks.push([channelId, messageId]);
      return true;
    },
    async typing() {},
  };
}

test('READY hydrates guilds, DMs and read states', () => {
  const live = new LiveSession(makeClient());
  live.handleReady({
    user: { id: '1', username: 'me' },
    guilds: [
      {
        id: '10',
        name: 'Rust Korea',
        channels: [{ id: '101', type: 0, name: 'general' }],
      },
    ],
    private_channels: [{ id: '201', type: 1, recipients: [{ id: '2', username: 'mira' }] }],
    read_state: { entries: [{ id: '101', last_message_id: '5', mention_count: 2 }] },
  });
  assert.equal(live.guilds.length, 1);
  assert.equal(live.privateChannels.length, 1);
  assert.equal(live.readStates.get('101').mentionCount, 2);
  assert.ok(live.client.channel('101'));
  assert.ok(live.client.channel('201'));
  live.stop();
});

test('MESSAGE_CREATE is re-emitted with the channel id', () => {
  const client = makeClient();
  const live = new LiveSession(client);
  live.handleReady({
    user: client.me,
    guilds: [{ id: '10', name: 'G', channels: [{ id: '101', type: 0, name: 'general' }] }],
    private_channels: [],
    read_state: { entries: [] },
  });
  let event = null;
  live.on('message', (payload) => {
    event = payload;
  });
  live.handleDispatch('MESSAGE_CREATE', {
    id: '6',
    channel_id: '101',
    author: { id: '2', username: 'mira' },
    content: 'hi',
  });
  assert.equal(event.channelId, '101');
  assert.equal(event.message.content, 'hi');
  assert.equal(client.channel('101').last_message_id, '6');
  live.stop();
});

test('typing indicators are tracked', async () => {
  const client = makeClient();
  const live = new LiveSession(client);
  live.handleReady({
    user: client.me,
    guilds: [],
    private_channels: [],
    read_state: { entries: [] },
  });
  client.rememberUser({ id: '2', username: 'mira' });
  live.handleDispatch('TYPING_START', { channel_id: '101', user_id: '2' });
  assert.deepEqual(live.typingNames('101'), ['mira']);
  live.stop();
});

test('ack calls the REST client and emits read_state', async () => {
  const client = makeClient();
  const live = new LiveSession(client);
  let event = null;
  live.on('read_state', (payload) => {
    event = payload;
  });
  const ok = await live.ack('101', '900');
  assert.equal(ok, true);
  assert.deepEqual(client.acks[0], ['101', '900']);
  assert.equal(event.channelId, '101');
  assert.equal(event.messageId, '900');
  live.stop();
});

test('READY hydrates deduped users and accepts array read states', () => {
  const client = makeClient();
  const live = new LiveSession(client);
  live.handleReady({
    user: { id: '1' },
    users: [
      { id: '1', username: 'me' },
      { id: '2', username: 'mira', global_name: 'Mira' },
    ],
    guilds: [],
    private_channels: [{ id: '201', type: 1, recipients: [{ id: '2' }] }],
    // Non-versioned payloads send a plain array.
    read_state: [{ id: '201', last_message_id: '7', mention_count: 1 }],
  });
  assert.equal(client.channel('201').recipients[0].username, 'mira');
  assert.equal(client.user('2').global_name, 'Mira');
  assert.equal(live.readStates.get('201').lastMessageId, '7');
  live.stop();
});

test('typing indicator can be turned off', async () => {
  const calls = [];
  const client = makeClient();
  client.typing = async (channelId) => {
    calls.push(channelId);
  };

  const on = new LiveSession(client);
  await on.sendTyping('101');
  assert.deepEqual(calls, ['101']);

  const off = new LiveSession(client, { typingIndicator: false });
  await off.sendTyping('102');
  assert.deepEqual(calls, ['101'], 'disabled session must not call the API');
});

// -------------------------------------------------- notification settings
test('READY parses per-guild and per-channel notification settings', () => {
  const live = new LiveSession(makeClient());
  let ready = null;
  live.on('ready', (data) => {
    ready = data;
  });

  live.handleReady({
    user: { id: '1' },
    guilds: [],
    user_guild_settings: [
      {
        guild_id: '10',
        message_notifications: 1,
        muted: false,
        channel_overrides: [
          { channel_id: '101', message_notifications: 0, muted: false },
          { channel_id: '102', message_notifications: 2, muted: true },
        ],
      },
      { guild_id: null, message_notifications: 0, muted: false, channel_overrides: [] },
    ],
  });

  assert.ok(ready.guildSettings instanceof Map);
  const guild = ready.guildSettings.get('10');
  assert.equal(guild.level, 1, 'guild default is mentions only');
  assert.equal(guild.channels.get('101').level, 0, 'channel override is all messages');
  assert.equal(guild.channels.get('102').muted, true);
  assert.equal(ready.guildSettings.get('').level, 0, 'DMs are keyed by an empty guild id');
});

test('USER_GUILD_SETTINGS_UPDATE replaces one guild entry', () => {
  const live = new LiveSession(makeClient());
  const events = [];
  live.on('guild_settings', (event) => events.push(event));

  live.handleDispatch('USER_GUILD_SETTINGS_UPDATE', {
    guild_id: '10',
    message_notifications: 2,
    muted: true,
    channel_overrides: [{ channel_id: '101', message_notifications: 3, muted: null }],
  });

  assert.equal(live.guildSettings.get('10').level, 2);
  assert.equal(live.guildSettings.get('10').muted, true);
  assert.equal(live.guildSettings.get('10').channels.get('101').muted, null, 'null inherits the guild mute');
  assert.equal(events.length, 1);
  assert.equal(events[0].guildId, '10');
  assert.equal(events[0].guildSettings.get('10').level, 2);
});

test('expired mute configurations no longer mute a guild', () => {
  const now = Date.now();
  const live = new LiveSession(makeClient());
  live.handleReady({
    user: { id: '1' },
    guilds: [],
    user_guild_settings: [
      {
        guild_id: '10',
        message_notifications: 0,
        muted: true,
        mute_config: { end_time: now - 1_000 },
      },
      {
        guild_id: '20',
        message_notifications: 0,
        muted: true,
        mute_config: { end_time: now + 60_000 },
      },
    ],
  });

  assert.equal(live.guildSettings.get('10').muted, false);
  assert.equal(live.guildSettings.get('20').muted, true);
});

// ------------------------------------------------------------ wake/recovery
test('wake probes the gateway and clears stale typing state', () => {
  const live = new LiveSession(makeClient());
  live.started = true;
  let probes = 0;
  live.gateway.wake = () => {
    probes += 1;
  };
  const timer = setTimeout(() => {}, 10_000);
  timer.unref?.();
  live.typers.set('101', new Map([['2', { name: 'mira', timer }]]));
  live.lastTyping.set('101', Date.now());

  live.wake();
  assert.equal(probes, 1);
  assert.equal(live.typers.size, 0, 'old typing indicators expire on wake');
  assert.equal(live.lastTyping.size, 0);
  live.stop();
});
