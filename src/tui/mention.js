/**
 * Mention autocomplete.
 *
 * Discord only pings someone when the message contains real mention syntax
 * (`<@id>`, `<#id>`), not when it contains plain `@name` text. Typing raw IDs
 * is impractical, so the composer offers candidates for the token under the
 * cursor and inserts the syntax for us.
 *
 * Candidates come from data the client already has locally: users seen as
 * message authors/mentions or DM recipients, and the current guild's channels.
 * No extra API request is made just to populate the menu.
 */

import { graphemes } from '../util.js';
import { displayName } from './model.js';

export const MENTION_LIMIT = 8;

function isSpace(value) {
  return /\s/.test(value);
}

/**
 * Find the `@user` or `#channel` token around the cursor.
 *
 * `start`/`end` cover the whole token so accepting a candidate replaces what
 * was typed (including a partially typed suffix when the cursor is mid-token).
 * `query` only looks backwards from the cursor, which is what the user has
 * typed so far.
 */
export function mentionToken(draft, cursor) {
  const parts = graphemes(String(draft ?? ''));
  const at = Math.max(0, Math.min(Number(cursor) || 0, parts.length));
  let start = at;
  while (start > 0 && !isSpace(parts[start - 1])) start -= 1;
  const marker = parts[start];
  if (marker !== '@' && marker !== '#') return null;

  let end = at;
  while (end < parts.length && !isSpace(parts[end])) end += 1;
  const query = parts.slice(start + 1, at).join('');
  // `<@123>` and similar already-complete syntax should not reopen the menu.
  if (/[<>]/.test(query)) return null;
  return {
    kind: marker === '@' ? 'user' : 'channel',
    start,
    end,
    query,
  };
}

function matchRank(values, query) {
  if (!query) return 1;
  let best = 0;
  for (const value of values) {
    const text = String(value ?? '').toLowerCase();
    if (!text) continue;
    if (text === query) best = Math.max(best, 4);
    else if (text.startsWith(query)) best = Math.max(best, 3);
    else if (text.includes(query)) best = Math.max(best, 2);
  }
  return best;
}

/**
 * `@everyone` / `@here` are literal text mentions, not `<@id>` syntax. They
 * only appear once the user starts typing the name, so an empty `@` cannot
 * accidentally lead to a mass ping.
 */
export function specialMentionItems(token) {
  const query = String(token?.query || '').toLowerCase();
  if (!query) return [];
  const items = [];
  for (const name of ['everyone', 'here']) {
    if (!name.startsWith(query)) continue;
    items.push({
      kind: 'special',
      id: name,
      label: name,
      hint: name === 'everyone' ? 'all members' : 'online members',
      insert: `@${name}`,
    });
  }
  return items;
}

/**
 * Rank users by display name / username / id. Users active in the current
 * channel sort first when the query is empty, so a bare `@` is a quick picker
 * instead of an alphabetical dump of every user ever seen.
 */
export function userMentionItems(users, token, { selfId = '', preferred = [] } = {}) {
  const query = String(token?.query || '').trim().toLowerCase();
  const preferredRank = new Map();
  for (const [index, id] of preferred.entries()) {
    const value = String(id || '');
    if (value) preferredRank.set(value, index);
  }
  const restrict = !query && preferredRank.size > 0;
  const items = [];

  for (const user of users?.values?.() || []) {
    const id = String(user?.id || '');
    if (!id || id === String(selfId || '')) continue;
    if (restrict && !preferredRank.has(id)) continue;
    const names = [user.global_name, user.display_name, user.nick, user.username]
      .filter(Boolean)
      .map(String);
    const rank = matchRank([...names, id], query);
    if (!rank) continue;
    const label = displayName(user, `user ${id.slice(-4)}`);
    const handle = user.username && user.username !== label ? `@${user.username}` : '';
    items.push({
      kind: 'user',
      id,
      label,
      hint: handle,
      insert: `<@${id}>`,
      rank,
      preferred: preferredRank.get(id) ?? Number.POSITIVE_INFINITY,
    });
  }

  items.sort(
    (a, b) => b.rank - a.rank || a.preferred - b.preferred || a.label.localeCompare(b.label),
  );
  return items.slice(0, MENTION_LIMIT).map(({ rank, preferred: _preferred, ...item }) => item);
}

/** Text channels of the current guild, ranked by name/prefix. */
export function channelMentionItems(channels, token) {
  const query = String(token?.query || '').trim().toLowerCase();
  const items = [];
  for (const channel of channels || []) {
    const id = String(channel?.id || '');
    const name = String(channel?.name || '');
    if (!id || !name) continue;
    const rank = matchRank([name, id], query);
    if (!rank) continue;
    items.push({
      kind: 'channel',
      id,
      label: name,
      hint: '',
      insert: `<#${id}>`,
      rank,
      position: Number(channel.position ?? 0),
    });
  }
  items.sort(
    (a, b) => b.rank - a.rank || a.position - b.position || a.label.localeCompare(b.label),
  );
  return items.slice(0, MENTION_LIMIT).map(({ rank, position: _position, ...item }) => item);
}
