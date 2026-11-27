/**
 * Reconnecting live Discord session.
 *
 * Wraps the gateway and turns raw dispatches into the small set of events the
 * TUI and `watch` command care about: ready, message, typing, channel and
 * read-state changes.
 */

import { EventEmitter } from 'node:events';

import { Gateway } from './protocol/gateway.js';

const TYPING_TTL = 10_000;
const ACK_THROTTLE = 2_000;
const TYPING_THROTTLE = 8_000;

// Discord's `message_notifications` enum: 0 all, 1 mentions, 2 nothing,
// 3 inherit (only meaningful on a channel override).
const NOTIFY_INHERIT = 3;

function notificationLevel(value) {
  if (value === null || value === undefined || value === '') return NOTIFY_INHERIT;
  const level = Number(value);
  return Number.isFinite(level) ? level : NOTIFY_INHERIT;
}

function muteActive(entry, now) {
  if (!entry?.muted) return false;
  const raw = entry?.mute_config?.end_time;
  const end = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
  // No end time means an indefinite mute; a future end time is still muted.
  return !(Number.isFinite(end) && end > 0 && end <= now);
}

/**
 * Normalise READY `user_guild_settings` into a Map keyed by guild id ('' for
 * DMs). Each entry carries the guild default plus per-channel overrides, which
 * is all the TUI needs to decide whether a channel may make a sound.
 */
export function parseGuildSettings(list, now = Date.now()) {
  const map = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry) continue;
    const guildId = entry.guild_id ? String(entry.guild_id) : '';
    const channels = new Map();
    for (const override of entry.channel_overrides || []) {
      if (!override?.channel_id) continue;
      channels.set(String(override.channel_id), {
        level: notificationLevel(override.message_notifications),
        muted:
          override.muted === null || override.muted === undefined
            ? null
            : muteActive(override, now),
      });
    }
    map.set(guildId, {
      level: notificationLevel(entry.message_notifications),
      muted: muteActive(entry, now),
      channels,
    });
  }
  return map;
}

export function parseGuildSetting(entry, now = Date.now()) {
  if (!entry) return null;
  const guildId = entry.guild_id ? String(entry.guild_id) : '';
  return parseGuildSettings([entry], now).get(guildId) || null;
}

export class LiveSession extends EventEmitter {
  constructor(client, { debug = null, typingIndicator = true } = {}) {
    super();
    this.client = client;
    this.debug = debug;
    this.typingIndicator = typingIndicator !== false;
    // Through the proxy, READY's resume URL points at a shard host the proxy
    // does not know about. Rewrite it back onto the local listener and pass the
    // real host as a hint so RESUME still works (and never leaves the proxy).
    const proxy = client.gatewayUrl || null;
    this.gateway = new Gateway({
      token: client.token,
      debug,
      url: proxy || undefined,
      urlRewrite: proxy
        ? (remote) => {
            const parsed = new URL(remote);
            const local = new URL(proxy);
            local.pathname = parsed.pathname;
            local.search = parsed.search;
            return { url: local.toString(), headers: { 'X-Spoof-Host': parsed.host } };
          }
        : null,
    });
    this.started = false;
    this.state = 'offline';
    this.user = null;
    this.guilds = [];
    this.privateChannels = [];
    this.readStates = new Map();
    this.guildSettings = new Map();
    this.typers = new Map();
    this.lastAck = new Map();
    this.pendingAck = new Map();
    this.ackTimer = null;
    this.lastTyping = new Map();
    this._wired = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.wire();
    this.gateway.connect();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.gateway.close();
    for (const channel of this.typers.values()) {
      for (const entry of channel.values()) clearTimeout(entry.timer);
    }
    this.typers.clear();
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.lastAck.clear();
    this.pendingAck.clear();
    this.lastTyping.clear();
  }

  wire() {
    if (this._wired) return;
    this._wired = true;

    this.gateway.on('state', (event) => {
      this.state = event.state;
      this.emit('state', event);
    });
    this.gateway.on('ready', (data) => this.handleReady(data));
    this.gateway.on('resumed', () => this.emit('resumed'));
    this.gateway.on('fatal', (error) => this.emit('fatal', error));
    this.gateway.on('dispatch', ({ t, d }) => this.handleDispatch(t, d));
  }

  handleReady(data) {
    this.user = data.user || null;
    this.guilds = Array.isArray(data.guilds) ? data.guilds : [];
    this.privateChannels = Array.isArray(data.private_channels) ? data.private_channels : [];

    // With the DedupeUserObjects capability, READY sends every user once in
    // `users` and refers to them by id elsewhere (DM recipients, relationships).
    // Hydrate those references so display names keep working.
    const users = new Map();
    for (const user of data.users || []) {
      if (user?.id) users.set(String(user.id), user);
    }
    const hydrate = (user) => (user?.id && users.get(String(user.id))) || user;

    this.readStates.clear();
    // VersionedReadStates (enabled in IDENTIFY) sends `{ entries, partial,
    // version }`; older payloads send a plain array.
    const readState = data.read_state;
    const readEntries = Array.isArray(readState)
      ? readState
      : Array.isArray(readState?.entries)
        ? readState.entries
        : [];
    for (const entry of readEntries) {
      if (!entry?.id) continue;
      this.readStates.set(String(entry.id), {
        lastMessageId: entry.last_message_id ? String(entry.last_message_id) : '',
        mentionCount: Number(entry.mention_count) || 0,
        lastViewed: Number(entry.last_viewed) || 0,
        flags: Number(entry.flags) || 0,
      });
    }

    if (this.user) this.client.rememberUser(hydrate(this.user));
    for (const channel of this.privateChannels) {
      if (Array.isArray(channel.recipients)) {
        channel.recipients = channel.recipients.map(hydrate);
      }
      this.client.rememberChannel(channel);
      for (const recipient of channel.recipients || []) this.client.rememberUser(recipient);
    }
    // READY can carry full guild objects (channels included) for user accounts.
    for (const guild of this.guilds) {
      this.client.guilds.set(String(guild.id), guild);
      for (const channel of guild.channels || []) this.client.rememberChannel(channel);
      for (const member of guild.members || []) {
        if (member?.user) this.client.rememberUser(hydrate(member.user));
      }
    }

    this.guildSettings = parseGuildSettings(data.user_guild_settings);

    this.emit('ready', {
      user: this.user,
      guilds: this.guilds,
      privateChannels: this.privateChannels,
      readStates: this.readStates,
      guildSettings: this.guildSettings,
    });
  }

  handleDispatch(type, data) {
    switch (type) {
      case 'MESSAGE_CREATE':
        this.onMessage(data);
        break;
      case 'MESSAGE_UPDATE':
        this.onMessageUpdate(data);
        break;
      case 'MESSAGE_DELETE':
        this.emit('message_delete', {
          channelId: String(data.channel_id),
          messageId: String(data.id),
        });
        break;
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE':
      case 'MESSAGE_REACTION_REMOVE_ALL':
      case 'MESSAGE_REACTION_REMOVE_EMOJI':
        this.emit('reaction', {
          type: type === 'MESSAGE_REACTION_ADD' ? 'add' : type === 'MESSAGE_REACTION_REMOVE' ? 'remove' : type === 'MESSAGE_REACTION_REMOVE_ALL' ? 'remove_all' : 'remove_emoji',
          channelId: String(data.channel_id),
          messageId: String(data.message_id),
          userId: data.user_id ? String(data.user_id) : '',
          emoji: data.emoji || null,
        });
        break;
      case 'TYPING_START':
        this.onTyping(data);
        break;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        this.client.rememberChannel(data);
        this.emit('channel', {
          type: type === 'CHANNEL_CREATE' ? 'create' : 'update',
          channel: data,
        });
        break;
      case 'CHANNEL_DELETE':
        this.client.channels.delete(String(data.id));
        this.client.dms.delete(String(data.id));
        this.emit('channel', { type: 'delete', channel: data });
        break;
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE':
        this.client.guilds.set(String(data.id), data);
        this.emit('guild', { type: type === 'GUILD_CREATE' ? 'create' : 'update', guild: data });
        break;
      case 'GUILD_DELETE':
        this.client.guilds.delete(String(data.id));
        this.emit('guild', { type: 'delete', guild: data });
        break;
      case 'USER_GUILD_SETTINGS_UPDATE': {
        const guildId = data?.guild_id ? String(data.guild_id) : '';
        const settings = parseGuildSetting(data);
        if (settings) {
          this.guildSettings.set(guildId, settings);
          this.emit('guild_settings', {
            guildId,
            settings,
            guildSettings: this.guildSettings,
          });
        }
        break;
      }
      case 'MESSAGE_ACK':
        this.emit('read_state', {
          channelId: String(data.channel_id),
          messageId: data.message_id ? String(data.message_id) : '',
          mentionCount: 0,
          remote: true,
        });
        break;
      case 'PRESENCE_UPDATE':
        this.emit('presence', data);
        break;
      case 'GUILD_MEMBER_UPDATE':
        if (data.user) this.client.rememberUser(data.user);
        this.emit('member', data);
        break;
      case 'RELATIONSHIP_ADD':
      case 'RELATIONSHIP_REMOVE':
        this.emit('relationship', { type, data });
        break;
      default:
        break;
    }
  }

  onMessage(message) {
    if (!message?.channel_id) return;
    if (message.author) this.client.rememberUser(message.author);
    for (const mention of message.mentions || []) this.client.rememberUser(mention);

    const channel = this.client.channel(message.channel_id);
    if (channel) channel.last_message_id = message.id;
    this.emit('message', { message, channelId: String(message.channel_id) });
  }

  onMessageUpdate(message) {
    if (!message?.channel_id) return;
    if (message.author) this.client.rememberUser(message.author);
    this.emit('message_update', {
      message,
      channelId: String(message.channel_id),
    });
  }

  onTyping(data) {
    const channelId = String(data.channel_id);
    const userId = String(data.user_id);
    const user = data.member?.user || this.client.user(userId);
    const name =
      user?.global_name || user?.username || data.member?.nick || `user ${userId.slice(-4)}`;

    let channel = this.typers.get(channelId);
    if (!channel) {
      channel = new Map();
      this.typers.set(channelId, channel);
    }
    const existing = channel.get(userId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      const current = this.typers.get(channelId);
      if (!current) return;
      current.delete(userId);
      if (!current.size) this.typers.delete(channelId);
      this.emit('typing_expire', { channelId, userId });
    }, TYPING_TTL);
    timer.unref?.();

    channel.set(userId, { name, until: Date.now() + TYPING_TTL, timer });
    this.emit('typing', { channelId, userId, name });
  }

  typingNames(channelId) {
    const channel = this.typers.get(String(channelId));
    if (!channel) return [];
    return [...channel.values()].map((entry) => entry.name);
  }

  /** Mark a channel read. Safe to call often; repeats are throttled. */
  async ack(channelId, messageId) {
    const id = String(channelId);
    if (!messageId) return false;
    const now = Date.now();
    const last = this.lastAck.get(id) || 0;
    if (now - last < ACK_THROTTLE) {
      // Remember the newest id and send it once the window closes, so the
      // server does not end up stuck on a stale read position.
      this.pendingAck.set(id, String(messageId));
      this.scheduleAckFlush(ACK_THROTTLE - (now - last));
      return false;
    }
    this.lastAck.set(id, now);
    return this.sendAck(id, String(messageId));
  }

  scheduleAckFlush(delay) {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      const pending = [...this.pendingAck];
      this.pendingAck.clear();
      for (const [channelId, messageId] of pending) {
        this.lastAck.set(channelId, Date.now());
        this.sendAck(channelId, messageId);
      }
    }, Math.max(0, delay));
    this.ackTimer.unref?.();
  }

  async sendAck(channelId, messageId) {
    try {
      await this.client.ack(channelId, messageId);
      this.emit('read_state', {
        channelId,
        messageId,
        mentionCount: 0,
        local: true,
      });
      return true;
    } catch (error) {
      this.debug?.(`ack failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Resume from suspend / SIGCONT. Typing state is stale after a long pause,
   * and the gateway probe reconnects immediately when the socket is a zombie.
   */
  wake() {
    if (!this.started) return;
    for (const channel of this.typers.values()) {
      for (const entry of channel.values()) clearTimeout(entry.timer);
    }
    this.typers.clear();
    this.emit('typing_expire', {});
    this.lastTyping.clear();
    this.gateway.wake();
  }

  /** Send a typing indicator, at most once per 8 seconds per channel. */
  async sendTyping(channelId) {
    if (!this.typingIndicator) return;
    const id = String(channelId);
    const now = Date.now();
    const last = this.lastTyping.get(id);
    if (last && now - last < TYPING_THROTTLE) return;
    this.lastTyping.set(id, now);
    try {
      await this.client.typing(id);
    } catch (error) {
      this.debug?.(`typing failed: ${error.message}`);
    }
  }
}
