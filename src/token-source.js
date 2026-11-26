/**
 * Token discovery.
 *
 * The official desktop client keeps its user token in Chromium's leveldb
 * `Local Storage` directory. We scan those files read-only, extract token
 * shaped strings, and validate candidates against `/users/@me`. The token is
 * never written to logs or printed in full.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BASE_URL } from './protocol/properties.js';
import { discordHeaders } from './protocol/rest.js';

// `[\w-]{20,}` covers the current base64 user-id prefix; the older mfa form is
// kept for completeness.
export const TOKEN_PATTERN = /(mfa\.[\w-]{80,}|[\w-]{20,}\.[\w-]{6}\.[\w-]{25,})/g;

const home = (...parts) => path.join(os.homedir(), ...parts);
const appData = process.env.APPDATA ? path.join(process.env.APPDATA) : null;
const macSupport = (...parts) => home('Library', 'Application Support', ...parts);

/** Candidate leveldb directories, most common installs first. */
export function defaultTokenDirs() {
  const env = process.env.TTYCORD_TOKEN_DIRS;
  if (env) return env.split(path.delimiter).filter(Boolean);

  const dirs = [
    home('.var/app/com.discordapp.Discord/config/discord/Local Storage/leveldb'),
    home('.var/app/com.discordapp.DiscordCanary/config/discordcanary/Local Storage/leveldb'),
    home('.var/app/com.discordapp.DiscordPTB/config/discordptb/Local Storage/leveldb'),
    home('.config/discord/Local Storage/leveldb'),
    home('.config/discordcanary/Local Storage/leveldb'),
    home('.config/discordptb/Local Storage/leveldb'),
    macSupport('discord', 'Local Storage', 'leveldb'),
    macSupport('discordcanary', 'Local Storage', 'leveldb'),
    macSupport('discordptb', 'Local Storage', 'leveldb'),
  ];
  if (appData) {
    dirs.push(
      path.join(appData, 'discord', 'Local Storage', 'leveldb'),
      path.join(appData, 'discordcanary', 'Local Storage', 'leveldb'),
      path.join(appData, 'discordptb', 'Local Storage', 'leveldb'),
    );
  }
  return dirs;
}

/** Extract unique token candidates from an arbitrary buffer/string. */
export function extractTokens(text) {
  const source = typeof text === 'string' ? text : Buffer.from(text).toString('latin1');
  const found = new Set();
  for (const match of source.matchAll(TOKEN_PATTERN)) found.add(match[1]);
  return [...found];
}

export function scanLevelDb(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const tokens = new Set();
  for (const name of entries) {
    if (!/\.(ldb|log)$/i.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      // Chromium's Local Storage files are a few MB; skip anything absurd.
      if (stat.size > 128 * 1024 * 1024) continue;
      const text = fs.readFileSync(file).toString('latin1');
      for (const token of extractTokens(text)) tokens.add(token);
    } catch {
      /* locked or unreadable; try the next file */
    }
  }
  return [...tokens];
}

/** Scan every known location. Returns `{ token, dir }` candidates. */
export function scanLocalTokens({ dirs = defaultTokenDirs() } = {}) {
  const seen = new Set();
  const results = [];
  for (const dir of dirs) {
    for (const token of scanLevelDb(dir)) {
      if (seen.has(token)) continue;
      seen.add(token);
      results.push({ token, dir });
    }
  }
  return results;
}

/** Ask Discord who a token belongs to. Returns the user object or null. */
export async function validateToken(
  token,
  { fetchImpl = globalThis.fetch, timeout = 12_000, baseUrl = BASE_URL } = {},
) {
  if (!token || typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/users/@me`, {
      headers: discordHeaders({ token }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user || !user.id) return null;
    return user;
  } catch {
    return null;
  }
}

/**
 * Find and validate a token from the locally installed Discord client.
 * Returns `{ token, dir, user }` or null.
 */
export async function findLocalToken({ dirs, validate = true, fetchImpl, baseUrl, debug } = {}) {
  const candidates = scanLocalTokens({ dirs });
  debug?.(`token scan: ${candidates.length} candidate(s)`);
  if (!candidates.length) return null;
  if (!validate) return candidates[0];

  for (const candidate of candidates) {
    const user = await validateToken(candidate.token, { fetchImpl, baseUrl });
    if (user) return { ...candidate, user };
  }
  return null;
}
