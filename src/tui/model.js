/** Presentation model: guilds, channels, messages and time labels. */

import {
  asBig,
  channelPrefix,
  formatBytes,
  guildInitial,
  isTextChannel,
  mentionsUser,
  renderMentions,
  snowflakeTime,
} from '../util.js';

export { isTextChannel, mentionsUser };

const USER_MESSAGE_TYPES = new Set([0, 19, 20, 23]);
const GROUP_WINDOW = 5 * 60 * 1000;

export function displayName(user, fallback = '알 수 없음') {
  if (!user) return fallback;
  return user.global_name || user.display_name || user.nick || user.username || fallback;
}

export function normalizeGuild(guild) {
  return {
    id: String(guild.id),
    name: guild.name || '이름 없는 서버',
    initials: guildInitial(guild.name || '?'),
    icon: guild.icon || null,
    raw: guild,
  };
}

export function channelName(channel, users = null, myId = '') {
  if (!channel) return '';
  if (channel.name) return channel.name;
  if (channel.type === 1 || channel.type === 3) {
    // Recipients can be full user objects or bare ids (deduped READY payload).
    const objects = new Map();
    for (const recipient of channel.recipients || []) {
      if (recipient && typeof recipient === 'object' && recipient.id) {
        objects.set(String(recipient.id), recipient);
      }
    }
    const ids = [];
    for (const recipient of channel.recipients || []) {
      const id = recipient && typeof recipient === 'object' ? String(recipient.id ?? '') : String(recipient);
      if (id && id !== String(myId || '') && !ids.includes(id)) ids.push(id);
    }
    const names = ids.map((id) =>
      displayName(users?.get?.(id) || objects.get(id), `user ${id.slice(-4)}`),
    );
    if (!names.length) return '다이렉트 메시지';
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}`;
  }
  return `채널 ${String(channel.id).slice(-4)}`;
}

export function channelTopic(channel) {
  if (!channel?.topic) return '';
  return String(channel.topic).replace(/\s+/g, ' ').trim();
}

export function byPosition(a, b) {
  const left = Number(a.position ?? 0);
  const right = Number(b.position ?? 0);
  if (left !== right) return left - right;
  const leftId = asBig(a.id);
  const rightId = asBig(b.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function sortChannels(channels) {
  return [...channels].sort(byPosition);
}

/**
 * Group text channels under their category. Returns
 * `[{ category: channel|null, channels: [...] }]`.
 */
export function groupChannels(channels) {
  const text = sortChannels(channels.filter((channel) => isTextChannel(channel.type)));
  const categories = sortChannels(channels.filter((channel) => Number(channel.type) === 4));
  const known = new Set(categories.map((category) => String(category.id)));
  const byParent = new Map();
  for (const channel of text) {
    const parent = channel.parent_id ? String(channel.parent_id) : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(channel);
  }

  const groups = [];
  const top = byParent.get(null) || [];
  if (top.length) groups.push({ category: null, channels: top });

  for (const category of categories) {
    const children = byParent.get(String(category.id)) || [];
    if (children.length) groups.push({ category, channels: children });
  }

  // Orphaned channels (parent missing from the payload) still need a home.
  for (const [parent, children] of byParent) {
    if (!parent || known.has(parent)) continue;
    groups.push({ category: null, channels: children });
  }
  return groups;
}

export function messageAuthor(message, users = null) {
  const author = message?.author || (message?.author_id ? users?.get?.(message.author_id) : null);
  return author || null;
}

export function messageAuthorName(message, users = null) {
  return displayName(messageAuthor(message, users));
}

export function messageDate(message) {
  const parsed = Date.parse(message?.timestamp || '');
  if (Number.isFinite(parsed)) return new Date(parsed);
  const fromSnowflake = snowflakeTime(message?.id);
  return fromSnowflake || new Date(0);
}

export function dayKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

export function dayLabel(date) {
  const value = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const today = dayKey(now);
  const key = dayKey(value);
  if (key === today) return '오늘';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === dayKey(yesterday)) return '어제';
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][value.getDay()];
  const sameYear = value.getFullYear() === now.getFullYear();
  const ymd = sameYear
    ? `${value.getMonth() + 1}월 ${value.getDate()}일`
    : `${value.getFullYear()}년 ${value.getMonth() + 1}월 ${value.getDate()}일`;
  return `${ymd} ${weekday}요일`;
}

export function hhmm(date) {
  const value = date instanceof Date ? date : new Date(date);
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function clockLabel(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function isUserMessage(message) {
  return USER_MESSAGE_TYPES.has(Number(message?.type ?? 0));
}

export function systemText(message, users = null) {
  const author = messageAuthorName(message, users);
  switch (Number(message?.type)) {
    case 1:
      return `${author}님이 대화에 참여했습니다.`;
    case 2:
      return `${author}님이 대화에서 나갔습니다.`;
    case 3:
      return `${author}님이 통화를 시작했습니다.`;
    case 4:
      return `${author}님이 채널 이름을 변경했습니다.`;
    case 5:
      return `${author}님이 채널 아이콘을 변경했습니다.`;
    case 6:
      return `${author}님이 메시지를 고정했습니다.`;
    case 7:
      return `${author}님이 서버에 참여했습니다.`;
    case 8:
    case 9:
    case 10:
    case 11:
      return `${author}님이 서버를 부스트했습니다.`;
    case 12:
      return `${author}님이 채널을 팔로우했습니다.`;
    case 18:
    case 21:
      return `${author}님이 스레드를 만들었습니다.`;
    case 22:
      return `${author}님이 초대 링크를 공유했습니다.`;
    case 24:
      return `${author}님의 메시지가 자동 검열로 삭제되었습니다.`;
    case 27:
      return `${author}님이 스테이지를 시작했습니다.`;
    case 28:
      return `${author}님이 스테이지를 종료했습니다.`;
    default:
      return `${author}님의 시스템 메시지 (${message?.type})`;
  }
}

export function replySummary(message, users = null) {
  const ref = message?.referenced_message;
  if (!ref) return '';
  const author = messageAuthorName(ref, users);
  const text = messageText(ref, { users });
  const flat = text.replace(/\s+/g, ' ').trim();
  return `${author}: ${flat || '(내용 없음)'}`;
}

export function attachmentLabel(attachment, suffix = '') {
  const name = attachment.filename || attachment.title || 'attachment';
  const size = formatBytes(attachment.size);
  const kind = /image\//.test(attachment.content_type || '') ? '[img]' : '[file]';
  return `${kind} ${name}${size ? ` (${size})` : ''}${suffix}`;
}

export function attachmentLines(message, { images = true } = {}) {
  return (message?.attachments || [])
    .filter((attachment) => images || !/image\//.test(attachment.content_type || ''))
    .map((attachment) => attachmentLabel(attachment));
}

export function embedLines(message) {
  const lines = [];
  for (const embed of message?.embeds || []) {
    const title = embed.title || embed.author?.name || '';
    const description = embed.description ? String(embed.description).replace(/\s+/g, ' ').trim() : '';
    if (title && description) lines.push(`[link] ${title} -- ${description}`);
    else if (title) lines.push(`[link] ${title}`);
    else if (description) lines.push(`[link] ${description}`);
    if (embed.footer?.text) lines.push(`   ${embed.footer.text}`);
  }
  return lines;
}

export function stickerLines(message) {
  return (message?.sticker_items || []).map((sticker) => `[sticker] ${sticker.name || 'sticker'}`);
}

export function messageText(message, { users = null, channels = null, roles = null } = {}) {
  const content = renderMentions(message?.content || '', { users, channels, roles });
  return content;
}

/** Extra lines shown under the message body. */
export function messageExtras(message, { users = null, attachments = true } = {}) {
  const lines = [];
  if (message?.message_snapshots?.length) {
    for (const snapshot of message.message_snapshots) {
      const body = snapshot?.message?.content;
      if (body) lines.push(`↪ ${body.replace(/\s+/g, ' ').trim()}`);
    }
  }
  lines.push(...attachmentLines(message, { images: attachments }));
  lines.push(...embedLines(message));
  lines.push(...stickerLines(message));
  if (message?.poll?.question?.text) lines.push(`[poll] ${message.poll.question.text}`);
  if (message?.edited_timestamp) lines.push('(edited)');
  return lines;
}

/** Stable key for a reaction emoji: the character, or `name:id` for custom. */
export function reactionKey(emoji) {
  if (!emoji) return '';
  if (emoji.id) return `${emoji.name || ''}:${emoji.id}`;
  return String(emoji.name || '');
}

/** How a reaction emoji is drawn: unicode as-is, custom as `:name:`. */
export function reactionLabel(emoji) {
  if (!emoji) return '';
  if (emoji.id) return `:${emoji.name || 'emoji'}:`;
  return String(emoji.name || '');
}

/**
 * Reactions in display order with the viewer's own reaction first-class.
 *
 * `message.reactions` is Discord's array: `{ emoji, count, me, count_details }`.
 * Local updates keep the same shape so rendering and live events agree.
 */
export function reactionItems(message) {
  const items = [];
  for (const reaction of message?.reactions || []) {
    const label = reactionLabel(reaction.emoji);
    if (!label) continue;
    items.push({
      key: reactionKey(reaction.emoji),
      label,
      count: Number(reaction.count) || 0,
      me: Boolean(reaction.me),
      emoji: reaction.emoji,
    });
  }
  return items.filter((item) => item.count > 0);
}

export function shouldGroup(previous, current, users = null) {
  if (!previous || !current) return false;
  if (!isUserMessage(previous) || !isUserMessage(current)) return false;
  if (String(messageAuthor(previous, users)?.id) !== String(messageAuthor(current, users)?.id)) {
    return false;
  }
  if (replySummary(current, users)) return false;
  if ((current.attachments || []).length) return false;
  const left = messageDate(previous).getTime();
  const right = messageDate(current).getTime();
  return Math.abs(right - left) < GROUP_WINDOW;
}

export function unreadLabel(count) {
  if (!count || count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

export function channelIcon(channel) {
  return channelPrefix(channel?.type);
}
