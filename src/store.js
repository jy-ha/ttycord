/**
 * Config storage for the Discord token.
 *
 * The token lives in `~/.config/ttycord/config.json` with mode 0600.
 * `TTYCORD_CONFIG_DIR` overrides the location (useful for tests).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
  const override = process.env.TTYCORD_CONFIG_DIR;
  const dir = override
    ? path.resolve(override)
    : path.join(os.homedir(), '.config', 'ttycord');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

/**
 * Before the rename the token lived under `~/.config/discord-tui`. Keep
 * reading it once and copy it forward so an existing login survives. Tests
 * that point `TTYCORD_CONFIG_DIR` at a temp dir never touch the real home.
 */
function legacyConfigPath() {
  if (process.env.TTYCORD_CONFIG_DIR) return '';
  return path.join(os.homedir(), '.config', 'discord-tui', 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writePrivate(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort on odd filesystems */
  }
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  let data = readJson(configPath());
  if (!data || typeof data !== 'object') {
    const legacy = legacyConfigPath();
    data = legacy ? readJson(legacy) : null;
    // Migrate on first read; subsequent writes use the ttycord path.
    if (data && typeof data === 'object') writePrivate(configPath(), data);
  }
  if (!data || typeof data !== 'object') return null;
  return {
    token: typeof data.token === 'string' ? data.token : '',
    tokenType: data.tokenType === 'bot' || data.tokenType === 'bearer' ? data.tokenType : 'user',
    userId: data.userId ? String(data.userId) : '',
    username: typeof data.username === 'string' ? data.username : '',
    globalName: typeof data.globalName === 'string' ? data.globalName : '',
    // Sending a typing indicator is a visible, real request. Default on (it is
    // what a chat client does) but allow turning it off.
    typingIndicator: data.typingIndicator !== false,
    // Local view state, same as the official client keeps client-side.
    collapsedFolders: Array.isArray(data.collapsedFolders)
      ? data.collapsedFolders.map(String)
      : [],
    collapsedCategories: Array.isArray(data.collapsedCategories)
      ? data.collapsedCategories.map(String)
      : [],
    // The view the user left behind, so reopening the TUI lands on the same
    // server/DM instead of always jumping to the first guild.
    lastView: sanitizeLastView(data.lastView),
    // Last channel visited in each guild, so switching servers returns to the
    // channel the user was reading instead of the first one in the list.
    lastChannels: sanitizeLastChannels(data.lastChannels),
  };
}

function sanitizeLastChannels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [guildId, channelId] of Object.entries(value)) {
    if (count >= 200) break;
    const guild = String(guildId);
    const channel = String(channelId ?? '');
    if (!/^\d{1,32}$/.test(guild) || !/^\d{1,32}$/.test(channel)) continue;
    out[guild] = channel;
    count += 1;
  }
  return out;
}

function sanitizeSplit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.enabled === false) return null;
  const panes = [];
  if (Array.isArray(value.panes)) {
    for (const raw of value.panes) {
      const id = String(raw ?? '');
      if (!/^\d{1,32}$/.test(id) || panes.includes(id)) continue;
      panes.push(id);
      if (panes.length >= 4) break;
    }
  }
  // A single pane is just the normal view; only a real split is restored.
  if (panes.length < 2) return null;
  const requested = Math.trunc(Number(value.focus));
  const focus = Number.isFinite(requested) ? Math.min(panes.length - 1, Math.max(0, requested)) : 0;
  return { enabled: true, panes, focus };
}

function sanitizeLastView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const guildId = value.guildId ? String(value.guildId) : '';
  const channelId = value.channelId ? String(value.channelId) : '';
  const dm = Boolean(value.dm);
  const wide = Boolean(value.wide);
  // A view with neither a guild nor a channel is not worth restoring.
  if (!guildId && !channelId) return null;
  const view = { guildId, channelId, dm, wide };
  const split = sanitizeSplit(value.split);
  if (split) view.split = split;
  return view;
}

export function saveConfig(patch) {
  const current = loadConfig() || {};
  const next = { ...current, ...patch };
  writePrivate(configPath(), next);
  return next;
}

export function clearConfig() {
  let removed = false;
  for (const file of [configPath(), legacyConfigPath()].filter(Boolean)) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

export function hasConfig() {
  return fs.existsSync(configPath()) || Boolean(legacyConfigPath() && fs.existsSync(legacyConfigPath()));
}
