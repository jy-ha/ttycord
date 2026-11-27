/**
 * High-level Discord client shared by the CLI and the TUI.
 *
 * Wraps the REST client with small caches for the current user, guilds and
 * channels, and centralises token resolution (CLI/env > config > local client).
 */

import { RestClient } from './protocol/rest.js';
import { BASE_URL } from './protocol/properties.js';
import { guildFoldersFromSettings } from './protocol/guild-order.js';
import { loadConfig, saveConfig } from './store.js';
import { findLocalToken, validateToken } from './token-source.js';
import { redactToken } from './util.js';

export class DiscordClient {
  constructor({
    token,
    tokenType = 'user',
    debug = null,
    fetchImpl = globalThis.fetch,
    baseUrl,
    gatewayUrl = null,
  } = {}) {
    if (!token) throw new Error('Discord token is required');
    this.token = token;
    this.tokenType = tokenType;
    this.debug = debug;
    this.rest = new RestClient({ token, tokenType, debug, fetchImpl, baseUrl });
    this.gatewayUrl = gatewayUrl;
    this.me = null;
    this.guilds = new Map();
    this.channels = new Map();
    this.dms = new Map();
    this.users = new Map();
  }

  async login() {
    this.me = await this.rest.me();
    this.rememberUser(this.me);
    return this.me;
  }

  rememberUser(user) {
    if (user && user.id) this.users.set(String(user.id), user);
    return user;
  }

  rememberChannel(channel) {
    if (!channel || !channel.id) return channel;
    this.channels.set(String(channel.id), channel);
    if (!channel.guild_id) this.dms.set(String(channel.id), channel);
    return channel;
  }

  user(id) {
    return this.users.get(String(id)) || null;
  }

  channel(id) {
    return this.channels.get(String(id)) || null;
  }

  guild(id) {
    return this.guilds.get(String(id)) || null;
  }

  async loadGuilds() {
    const list = await this.rest.myGuilds();
    this.guilds.clear();
    for (const guild of list || []) this.guilds.set(String(guild.id), guild);
    return list || [];
  }

  /** Guild ids in the user's folder order, or `[]` when unavailable. */
  async loadGuildOrder() {
    return (await this.loadGuildFolders()).ids;
  }

  /**
   * Folder tree plus the flattened guild order. Folders without a name are
   * Discord's representation of top-level (unfoldered) guilds.
   */
  async loadGuildFolders() {
    try {
      const data = await this.rest.userSettingsProto(1);
      const folders = guildFoldersFromSettings(data?.settings);
      const ids = [...new Set(folders.flatMap((folder) => folder.guildIds))];
      return { folders, ids };
    } catch (error) {
      this.debug?.(`guild folders unavailable: ${error.message}`);
      return { folders: [], ids: [] };
    }
  }

  async loadChannels(guildId) {
    const list = await this.rest.guildChannels(guildId);
    for (const channel of list || []) this.rememberChannel(channel);
    return list || [];
  }

  async loadDms() {
    const list = await this.rest.privateChannels();
    this.dms.clear();
    for (const channel of list || []) {
      this.rememberChannel(channel);
      for (const recipient of channel.recipients || []) this.rememberUser(recipient);
    }
    return list || [];
  }

  async fetchMessages(channelId, options = {}) {
    const list = await this.rest.messages(channelId, options);
    for (const message of list || []) {
      if (message.author) this.rememberUser(message.author);
      for (const mention of message.mentions || []) this.rememberUser(mention);
      if (message.referenced_message?.author) this.rememberUser(message.referenced_message.author);
    }
    return list || [];
  }

  async fetchChannel(channelId) {
    const channel = await this.rest.channel(channelId);
    this.rememberChannel(channel);
    return channel;
  }

  sendMessage(channelId, content, options = {}) {
    return this.rest.sendMessage(channelId, content, options);
  }

  sendMessageWithFiles(channelId, content, files, options = {}) {
    return this.rest.sendMessageWithFiles(channelId, content, files, options);
  }

  editMessage(channelId, messageId, content) {
    return this.rest.editMessage(channelId, messageId, content);
  }

  deleteMessage(channelId, messageId) {
    return this.rest.deleteMessage(channelId, messageId);
  }

  addReaction(channelId, messageId, emoji) {
    return this.rest.addReaction(channelId, messageId, emoji);
  }

  removeReaction(channelId, messageId, emoji) {
    return this.rest.removeReaction(channelId, messageId, emoji);
  }

  ack(channelId, messageId) {
    return this.rest.ack(channelId, messageId);
  }

  typing(channelId) {
    return this.rest.typing(channelId);
  }

  describeToken() {
    return redactToken(this.token);
  }
}

/**
 * Resolve a token from (in order): explicit argument, `DISCORD_TOKEN`, the
 * saved config, or the locally installed Discord client.
 *
 * Returns `{ token, source, user, dir }`. Throws with a user-facing Korean
 * message when nothing usable is found.
 */
export async function resolveToken({
  token = '',
  fromLocal = true,
  validate = true,
  fetchImpl = globalThis.fetch,
  debug = null,
  persistLocal = false,
  baseUrl = BASE_URL,
} = {}) {
  const explicit = String(token || '').trim() || String(process.env.DISCORD_TOKEN || '').trim();
  if (explicit) {
    const user = validate ? await validateToken(explicit, { fetchImpl, baseUrl }) : null;
    if (validate && !user) throw new Error('the provided token is not valid.');
    return {
      token: explicit,
      source: token ? 'cli' : 'env',
      user,
    };
  }

  let staleConfig = false;
  const config = loadConfig();
  if (config?.token) {
    const user = validate ? await validateToken(config.token, { fetchImpl, baseUrl }) : null;
    if (!validate || user) {
      return { token: config.token, source: 'config', user };
    }
    // The saved token is stale; fall through to the local client instead of
    // failing outright, so `ttycord` keeps working after a re-login.
    staleConfig = true;
  }

  if (!fromLocal) {
    throw new Error(
      'no token found. Use `ttycord login` or the DISCORD_TOKEN environment variable.',
    );
  }

  const local = await findLocalToken({ validate, fetchImpl, baseUrl, debug });
  if (!local) {
    throw new Error(
      staleConfig
        ? 'the saved token expired and no valid token was found in the local ' +
            'Discord client. Save one again with `ttycord login --token ...`.'
        : 'no valid token was found in the local Discord client. Log in to ' +
            'Discord, or pass `--token`.',
    );
  }
  if (persistLocal && local.user) {
    saveConfig({
      token: local.token,
      tokenType: 'user',
      userId: local.user.id,
      username: local.user.username,
      globalName: local.user.global_name || '',
    });
  }
  return { token: local.token, source: 'local', user: local.user, dir: local.dir };
}
