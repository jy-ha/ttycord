/** Chat header, message log with grouping, typing line and composer. */

import { asBig, displayWidth, graphemeWidth, graphemes, guildInitial } from '../util.js';
import { pendingAttachmentLabel } from './attach.js';
import { composerLayout, composerTextWidth } from './composer.js';
import {
  centerText,
  drawText,
  fillRect,
  hline,
  rightText,
  strWidth,
  truncate,
  wrapText,
} from './draw.js';
import { blankRow, blit, dividerRow, putCell, putRight, putText } from './layer.js';
import { fitCells, imageRows, isPreviewable } from './image.js';
import { highlightCode, parseFences } from './highlight.js';
import { MAX_ATTACHMENT_ROWS } from './layout.js';
import { REACTION_CHOICES } from './reactions.js';
import { style } from './term.js';
import { C, T, authorColor } from './theme.js';
import {
  attachmentLabel,
  channelIcon,
  channelName,
  channelTopic,
  dayKey,
  dayLabel,
  displayName,
  hhmm,
  isUserMessage,
  mentionsUser,
  messageAuthor,
  messageDate,
  messageExtras,
  messageText,
  reactionItems,
  replySummary,
  shouldGroup,
  systemText,
} from './model.js';

const INLINE_MAX_ROWS = 120;

/** Single-line preview used by the reply/edit banner. */
function excerpt(text, max = 60) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

const INLINE_RE =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\|\|[^|\n]+\|\||`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

/** Split one line into styled inline segments (bold/italic/code/spoiler). */
export function inlineSegments(text) {
  const out = [];
  let last = 0;
  for (const match of String(text).matchAll(INLINE_RE)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });
    const raw = match[0];
    if (raw.startsWith('**')) out.push({ text: raw.slice(2, -2), bold: true });
    else if (raw.startsWith('__')) out.push({ text: raw.slice(2, -2), underline: true });
    else if (raw.startsWith('~~')) out.push({ text: raw.slice(2, -2), strike: true });
    else if (raw.startsWith('||')) {
      out.push({ text: '█'.repeat(displayWidth(raw.slice(2, -2))), spoiler: true });
    } else if (raw.startsWith('`')) out.push({ text: raw.slice(1, -1), code: true });
    else out.push({ text: raw.slice(1, -1), italic: true });
    last = match.index + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function segmentStyle(segment, background, mention) {
  if (segment.code) return style(C.codeFg, C.codeBg);
  const fg = mention ? C.mentionFg : C.text;
  return style(fg, background, {
    bold: segment.bold,
    italic: segment.italic,
    underline: segment.underline,
    dim: segment.strike || segment.spoiler,
  });
}

const CODE_INDENT = 3;

function codeStyle(kind) {
  switch (kind) {
    case 'keyword':
      return T.codeKeyword;
    case 'string':
      return T.codeString;
    case 'number':
      return T.codeNumber;
    case 'comment':
      return T.codeComment;
    case 'punct':
      return T.codePunct;
    case 'func':
      return T.codeFunc;
    case 'builtin':
      return T.codeBuiltin;
    case 'add':
      return T.codeAdd;
    case 'del':
      return T.codeDel;
    case 'hunk':
      return T.codeHunk;
    default:
      return T.codePlain;
  }
}

/** A row whose every cell carries the code background, even where it is blank. */
function codeBlankRow(width) {
  const row = blankRow(width);
  for (let x = 0; x < width; x += 1) putCell(row, x, ' ', T.codePlain);
  return row;
}

/**
 * Render a fenced block with token colours. Long lines wrap at the pane edge;
 * a token can span a wrap, so cells are emitted grapheme by grapheme.
 */
function codeRows(width, block) {
  const rows = [];
  const indent = CODE_INDENT;
  const maxX = Math.max(indent + 4, width - 2);
  if (block.lang) {
    const row = codeBlankRow(width);
    putText(row, indent, truncate(`[${block.lang}]`, width - indent - 2), T.codeLabel);
    rows.push(row);
  }
  for (const tokens of highlightCode(block.lines, block.lang)) {
    let row = codeBlankRow(width);
    let x = indent;
    for (const token of tokens) {
      const st = codeStyle(token.kind);
      for (const g of graphemes(token.text)) {
        const w = graphemeWidth(g);
        if (x + w > maxX) {
          rows.push(row);
          row = codeBlankRow(width);
          x = indent;
        }
        putCell(row, x, g, st);
        x += w;
      }
    }
    rows.push(row);
  }
  return rows;
}

function contentRows(width, text, background, mention, indent = 3) {
  const rows = [];
  const available = Math.max(4, width - indent - 3);
  for (const part of parseFences(text)) {
    if (part.type === 'code') {
      rows.push(...codeRows(width, part));
      continue;
    }
    for (const line of wrapText(part.text, available)) {
      const row = blankRow(width);
      let x = indent;
      for (const segment of inlineSegments(line)) {
        const before = strWidth(segment.text);
        if (x + before > width - 2) break;
        putText(row, x, segment.text, segmentStyle(segment, background, mention), width - 2 - x);
        x += before;
      }
      rows.push(row);
    }
  }
  return rows;
}

function extraRows(width, lines, background, mention) {
  const rows = [];
  const available = Math.max(4, width - 7);
  for (const line of lines) {
    for (const part of wrapText(line, available)) {
      const row = blankRow(width);
      const fg = mention ? C.mentionFg : C.textDim;
      putText(row, 4, part, style(fg, background), width - 6);
      rows.push(row);
    }
  }
  return rows;
}

/** `👍 3   ❤️ 1` under the message body, own reactions highlighted. */
function reactionRow(width, items) {
  const row = blankRow(width);
  let x = 4;
  for (const item of items) {
    const label = `${item.label} ${item.count}`;
    const widthNeeded = displayWidth(label);
    if (x + widthNeeded > width - 2) break;
    putText(row, x, item.label, item.me ? T.reactionMine : T.reaction, width - 2 - x);
    putText(
      row,
      x + displayWidth(item.label) + 1,
      String(item.count),
      item.me ? T.reactionMine : T.reactionCount,
      width - 2 - x,
    );
    x += widthNeeded + 2;
  }
  return row;
}

function authorRow(app, message, width, date, background, mention) {
  const row = blankRow(width);
  const author = messageAuthor(message, app.users);
  const color = authorColor(author?.id || message.author?.id);
  const name = truncate(displayName(author), Math.max(4, width - 26));
  putText(row, 1, name, style(color, background, { bold: true }));
  let x = 1 + strWidth(name) + 1;
  if (author?.bot) {
    putText(row, x, '[bot]', style(mention ? C.mentionFg : C.textGhost, background));
    x += 5;
  }
  if (message.author?.id === app.myId) {
    putText(row, x, '[me]', style(mention ? C.mentionFg : C.textGhost, background));
  }
  putRight(row, width - 2, hhmm(date), style(mention ? C.mentionFg : C.textGhost, background));
  return row;
}

function systemRow(width, text) {
  const row = blankRow(width);
  const label = `-- ${text} --`;
  const start = Math.max(1, Math.floor((width - strWidth(label)) / 2));
  putText(row, start, truncate(label, width - 2), T.msgFaint);
  return row;
}

export function buildMessageRows(app, cache, width) {
  if (cache.layout && cache.layout.width === width && cache.layout.version === cache.version) {
    return cache.layout;
  }

  const rows = [];
  // Row index -> attachment URL. Used by the mouse handler so a click on an
  // inline image (or its `[img]` label) opens the original in a browser.
  const linkRows = new Map();
  // Message id -> row range, so the cursor can highlight exactly one message
  // and the mouse can map a click back to the message under it.
  const spans = [];
  let previous = null;
  let lastDay = '';
  const firstUnread = firstUnreadId(app, cache);

  for (const message of cache.items) {
    const date = messageDate(message);
    const day = dayKey(date);
    if (day !== lastDay) {
      rows.push(dividerRow(width, dayLabel(date)));
      lastDay = day;
      previous = null;
    }
    if (firstUnread && message.id === firstUnread) {
      rows.push(dividerRow(width, 'NEW'));
    }

    if (!isUserMessage(message)) {
      rows.push(systemRow(width, systemText(message, app.users)));
      rows.push(blankRow(width));
      previous = null;
      continue;
    }

    const mention = mentionsUser(message.content, app.myId);
    const background = mention ? C.mentionBg : C.surface;
    const grouped = shouldGroup(previous, message, app.users);
    const spanStart = rows.length;

    if (!grouped) rows.push(authorRow(app, message, width, date, background, mention));

    const reply = replySummary(message, app.users);
    if (reply) {
      const row = blankRow(width);
      putText(row, 3, '>>', style(C.textGhost, background));
      putText(row, 6, truncate(reply, width - 9), style(C.textFaint, background), width - 9);
      rows.push(row);
    }

    const text = messageText(message, { users: app.users });
    if (text) rows.push(...contentRows(width, text, background, mention));

    // Image attachments render inline at the full pane width. Everything else
    // (files, embeds, stickers, polls) stays a text line.
    for (const attachment of message.attachments || []) {
      if (!isPreviewable(attachment)) continue;
      const link = attachment.url || attachment.proxy_url || null;
      const thumb = app.imageThumb?.(attachment);
      if (thumb?.status === 'ready') {
        const maxCols = Math.max(8, width - 8);
        const box = fitCells(thumb.master.width, thumb.master.height, maxCols, INLINE_MAX_ROWS);
        const indent = Math.max(1, Math.min(4, width - box.cols - 2));
        const start = rows.length;
        rows.push(...imageRows(thumb.master, box.cols, box.rows, { indent, width, backdrop: background }));
        if (link) {
          for (let index = start; index < rows.length; index += 1) linkRows.set(index, link);
        }
      } else {
        const suffix = !thumb ? '' : thumb.status === 'error' ? '  (미리보기 실패)' : '  ...';
        const start = rows.length;
        rows.push(...extraRows(width, [attachmentLabel(attachment, suffix)], background, mention));
        if (link) {
          for (let index = start; index < rows.length; index += 1) linkRows.set(index, link);
        }
      }
    }

    const extras = messageExtras(message, { users: app.users, attachments: false });
    if (extras.length) rows.push(...extraRows(width, extras, background, mention));
    const reactions = reactionItems(message);
    if (reactions.length) rows.push(reactionRow(width, reactions));
    if (message.__failed) rows.push(...extraRows(width, ['⚠ 전송 실패'], background, mention));

    // A mention gets a marker in the left gutter. The cursor overwrites the
    // same cell while it sits on this message, which is fine: both mean
    // "this row matters".
    if (mention && rows[spanStart]) putText(rows[spanStart], 0, '!', T.msgMentionBar);
    spans.push({ id: message.id, start: spanStart, end: rows.length });
    rows.push(blankRow(width));
    previous = message;
  }

  cache.layout = {
    width,
    version: cache.version,
    rows,
    links: rows.map((_, index) => linkRows.get(index) || null),
    spans,
  };
  return cache.layout;
}

function firstUnreadId(app, cache) {
  const entry = app.readStates.get(String(cache.id));
  const readId = cache.unreadMarker || entry?.lastMessageId;
  if (!readId) return null;
  const read = asBig(readId);
  for (const message of cache.items) {
    if (asBig(message.id) > read) return message.id;
  }
  return null;
}

export function drawChatHeader(app, pane = null) {
  const view = pane || app.activePane();
  const screen = app.screen;
  const rect = view.rect?.header || app.geo.header;
  if (rect.width <= 0 || rect.height <= 0) return;
  const focused = view.focused !== false;
  const split = Boolean(app.splitMode);
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.chat);

  // The focused column is tinted; the others stay flat so the eye lands on
  // the column the composer belongs to.
  if (split && focused) fillRect(screen, rect.x, rect.y, rect.width, 1, T.paneHeaderFocus);

  const channel = view.channel;
  if (!channel) {
    const label = view.id ? 'channel not loaded' : 'no channel';
    drawText(screen, rect.x + 2, rect.y, label, split && focused ? T.paneHeaderFocus : T.paneHeader, rect.width - 4);
    hline(screen, rect.x, rect.y + 1, rect.width, T.chatDivider, '─');
    return;
  }

  const nameStyle = !split ? T.chatHeader : focused ? T.paneHeaderFocus : T.paneHeader;
  const iconStyle = !split ? T.chatSep : focused ? T.paneHeaderFocusIcon : T.paneHeaderIcon;
  const topicStyle = split ? T.paneHeaderTopic : T.chatTopic;

  // In split view the right edge names the guild (and the pane number), which
  // is the only way to tell two `#general` panes apart. The guild is reduced to
  // its initials so narrow columns keep room for the channel topic.
  const paneCount = app.geo.panes?.length || 1;
  let meta = '';
  if (split && paneCount > 1 && rect.width >= 14) {
    const guildName = channel.guild_id
      ? app.guilds?.find((guild) => String(guild.id) === String(channel.guild_id))?.name || ''
      : '';
    const label = channel.guild_id ? guildInitial(guildName) : 'DM';
    meta = `${label} [${view.index + 1}]`;
  }
  const metaWidth = meta ? Math.min(strWidth(meta), Math.max(0, rect.width - 8)) : 0;
  if (meta) {
    rightText(
      screen,
      rect.x + 2,
      rect.y,
      rect.width - 3,
      truncate(meta, metaWidth),
      focused ? T.paneHeaderMetaFocus : T.paneHeaderMeta,
    );
  }

  const icon = channelIcon(channel);
  drawText(screen, rect.x + 2, rect.y, icon, iconStyle, 2);
  const name = channelName(channel, app.users, app.myId);
  const nameWidth = Math.max(3, Math.min(40, Math.floor(rect.width * 0.45), rect.width - 6 - metaWidth));
  const shown = truncate(name, nameWidth);
  drawText(screen, rect.x + 4, rect.y, shown, nameStyle, nameWidth);
  const topic = channelTopic(channel);
  const sepX = rect.x + 5 + strWidth(shown);
  const room = rect.x + rect.width - metaWidth - (sepX + 3) - 2;
  if (topic && room > 3) {
    drawText(screen, sepX, rect.y, '::', T.chatSep, 2);
    drawText(screen, sepX + 3, rect.y, truncate(topic, room), topicStyle, room);
  }
  hline(screen, rect.x, rect.y + 1, rect.width, T.chatDivider, '─');
}

export function drawMessages(app, pane = null) {
  const view = pane || app.activePane();
  const screen = app.screen;
  const rect = view.rect?.messages || app.geo.messages;
  // Clear the hit map first: every early return below must leave no clickable
  // rows behind from the previously drawn channel.
  app.messagesViews[view.index] = null;
  if (rect.width <= 0 || rect.height <= 0) return;
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.chat);

  const channel = view.channel;
  if (!channel) {
    centerText(
      screen,
      rect.x,
      rect.y + Math.floor(rect.height / 2),
      rect.width,
      view.id ? 'channel not loaded (focus to open)' : 'no channel',
      T.empty,
    );
    return;
  }

  const cache = view.cache || app.chat(channel.id);
  if (!cache || cache.loading) {
    centerText(screen, rect.x, rect.y + Math.floor(rect.height / 2), rect.width, 'loading...', T.loading);
    return;
  }
  if (cache.error) {
    centerText(screen, rect.x, rect.y + Math.floor(rect.height / 2), rect.width, truncate(cache.error, rect.width - 4), T.error);
    return;
  }
  // A restored split pane keeps its layout but does not fetch messages until
  // the user focuses it. Say so instead of pretending the channel is empty.
  if (!cache.loaded && !cache.items.length) {
    centerText(
      screen,
      rect.x,
      rect.y + Math.floor(rect.height / 2),
      rect.width,
      'not loaded (focus to open)',
      T.empty,
    );
    return;
  }
  if (!cache.items.length) {
    centerText(screen, rect.x, rect.y + Math.floor(rect.height / 2), rect.width, 'no messages', T.empty);
    return;
  }

  const { rows, links, spans } = buildMessageRows(app, cache, rect.width);
  const total = rows.length;
  const scrolled = (cache.scroll || 0) > 0;
  const height = Math.max(1, rect.height - (scrolled ? 1 : 0));
  const maxScroll = Math.max(0, total - height);
  cache.scroll = Math.max(0, Math.min(cache.scroll || 0, maxScroll));
  const start = Math.max(0, maxScroll - cache.scroll);
  const topOffset = scrolled ? 1 : 0;
  const y0 = rect.y + topOffset + Math.max(0, height - total);
  blit(screen, rect.x, y0, rows.slice(start), rect.width, height);
  app.messagesViews[view.index] = { total, height, start, maxScroll, y0, links, spans };

  // Message cursor: tint every row of the selected message and mark the left
  // gutter. Painting after the blit keeps the text, only the style changes.
  const cursorId = cache.cursorId ? String(cache.cursorId) : null;
  if (cursorId) {
    const span = spans.find((entry) => entry.id === cursorId);
    if (span) {
      const first = Math.max(span.start, start);
      const last = Math.min(span.end - 1, start + height - 1);
      for (let row = first; row <= last; row += 1) {
        const y = y0 + (row - start);
        const offset = y * screen.cols + rect.x;
        for (let x = 0; x < rect.width; x += 1) screen.styles[offset + x] = T.msgCursor;
        screen.set(rect.x, y, '\u258c', T.msgCursorGutter);
      }
    }
  }

  if (scrolled) {
    rightText(screen, rect.x + 2, rect.y, rect.width - 4, '^ older', T.msgFaint);
  }
}

/** Attachment URL under a terminal row inside the message pane, if any. */
export function messageLinkAt(view, y) {
  if (!view || !view.links) return null;
  const offset = y - view.y0;
  if (offset < 0 || offset >= view.height) return null;
  return view.links[view.start + offset] || null;
}

export function drawTyping(app, pane = null) {
  const view = pane || app.activePane();
  const screen = app.screen;
  const rect = view.rect?.typing || app.geo.typing;
  if (rect.width <= 0 || rect.height <= 0) return;
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.chat);
  // The reaction bar borrows this one-line strip while it is open.
  if (app.reactMode && view.focused !== false) {
    const bar = REACTION_CHOICES.map((choice, index) => `${index + 1}${choice.emoji}`).join(' ');
    const typed = app.reactMode.buffer ? `react: ${app.reactMode.buffer}_` : `react  ${bar}`;
    drawText(screen, rect.x + 4, rect.y, truncate(typed, rect.width - 32), T.reaction, rect.width - 32);
    if (rect.width >= 40) {
      rightText(screen, rect.x + 2, rect.y, rect.width - 4, 'enter ok   esc cancel', T.typing);
    }
    return;
  }
  // While the message cursor is active this strip shows the action keys.
  if (app.focus === 'messages' && view.focused !== false) {
    const hint =
      rect.width >= 74
        ? 'j/k move   r react   R reply   e edit   d del   y link   esc back'
        : 'j/k   r react   R reply   esc back';
    drawText(screen, rect.x + 4, rect.y, truncate(hint, rect.width - 6), T.typing, rect.width - 6);
    return;
  }
  const channel = view.channel;
  if (!channel || !app.live) return;

  const names = app.live
    .typingNames(channel.id)
    .filter((name) => name !== app.myName);
  if (!names.length) return;

  let text;
  if (names.length === 1) text = `typing: ${names[0]}`;
  else if (names.length === 2) text = `typing: ${names[0]}, ${names[1]}`;
  else text = `typing: ${names[0]} +${names.length - 1}`;
  drawText(screen, rect.x + 4, rect.y, truncate(text, rect.width - 6), T.typing, rect.width - 6);
}

export function drawComposer(app, pane = null) {
  const view = pane || app.activePane();
  const screen = app.screen;
  const rect = view.rect?.composer || app.geo.composer;
  if (rect.width <= 0 || rect.height <= 0) return;
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.composer);
  hline(screen, rect.x, rect.y, rect.width, view.focused ? T.composerBarFocus : T.composerBar, '─');

  const cache = view.cache;
  const channel = view.channel;
  const draft = cache?.draft || '';
  const attachments = cache?.attachments || [];
  const focused = view.focused !== false;
  const editing = focused && app.focus === 'composer';
  const available = composerTextWidth(rect.width);
  const layout = composerLayout(draft, cache?.cursor ?? 0, available);

  // Reply / edit banner: one row above the input, only when the geometry
  // reserved it (computeGeometry() adds it for every pane at once).
  let banner = null;
  if (cache?.editingId) {
    const target = cache.byId?.get(String(cache.editingId));
    banner = { text: `edit  ${excerpt(target?.content)}`, hint: 'enter save   esc cancel' };
  } else if (cache?.replyTo) {
    const who = displayName(messageAuthor(cache.replyTo, app.users), '?');
    banner = { text: `>> ${who}: ${excerpt(cache.replyTo.content)}`, hint: 'esc cancel' };
  }
  if (banner && rect.banner) {
    const room = Math.max(8, rect.width - (rect.width >= 46 ? 26 : 4));
    drawText(screen, rect.x + 2, rect.y + 1, truncate(banner.text, room), T.banner, room);
    if (rect.width >= 46) {
      rightText(screen, rect.x + 2, rect.y + 1, rect.width - 4, banner.hint, T.bannerKey);
    }
  }
  const top = rect.y + 1 + (banner && rect.banner ? 1 : 0);

  const promptStyle = editing ? T.composerPrompt : T.composerPromptDim;
  const textStyle = focused ? T.composerText : T.composerTextDim;
  for (let row = 0; row < layout.visible.length; row += 1) {
    const y = top + row;
    drawText(screen, rect.x + 2, y, row === 0 ? '>' : ':', row === 0 ? promptStyle : T.composerHint, 2);
    const text = layout.visible[row];
    if (text) drawText(screen, rect.x + 4, y, text, textStyle, available);
  }

  if (!draft) {
    const placeholder = channel
      ? `message ${channelIcon(channel)}${channelName(channel, app.users, app.myId)}`
      : 'no channel';
    drawText(
      screen,
      rect.x + 4,
      top,
      truncate(placeholder, available),
      focused ? T.composerPlaceholder : T.composerTextDim,
      available,
    );
  }

  if (editing) {
    const caretRow = layout.cursor.row - layout.offset;
    if (caretRow >= 0 && caretRow < layout.visible.length) {
      // A caret at the end of an exactly full row has no cell of its own.
      const caretCol = Math.min(layout.cursor.col, Math.max(0, available - 1));
      screen.setCaret(rect.x + 4 + caretCol, top + caretRow);
    }
  }

  // Pending drag-and-drop attachments sit between the input and the hint.
  const shown = Math.min(attachments.length, MAX_ATTACHMENT_ROWS);
  let row = top + layout.visible.length;
  for (let index = 0; index < shown; index += 1) {
    const label = `  ${pendingAttachmentLabel(attachments[index])}`;
    drawText(screen, rect.x + 2, row, truncate(label, rect.width - 4), T.composerAttach, rect.width - 4);
    row += 1;
  }
  if (attachments.length > MAX_ATTACHMENT_ROWS) {
    const more = `  +${attachments.length - MAX_ATTACHMENT_ROWS} more`;
    drawText(screen, rect.x + 2, row, truncate(more, rect.width - 4), T.composerHint, rect.width - 4);
    row += 1;
  }

  const hintY = rect.y + rect.height - 1;
  let left = '';
  if (!focused) left = '';
  else if (!editing) left = rect.width >= 46 ? 'enter open   tab focus' : 'tab focus';
  else if (attachments.length) {
    left = rect.width >= 60 ? 'enter send   ^u clear   ^x detach' : 'enter send   ^x detach';
  } else if (rect.width >= 80) left = 'enter send   alt+enter nl   @/# mention';
  else if (rect.width >= 50) left = 'enter send   alt+enter nl';
  else left = 'enter send';
  if (left) {
    drawText(screen, rect.x + 2, hintY, truncate(left, Math.floor(rect.width / 2)), T.composerHint, Math.floor(rect.width / 2));
  }
  // Four panes make each composer narrow; the count would just add noise.
  if (rect.width >= 30) {
    const right = `${displayWidth(draft)} chars`;
    rightText(screen, rect.x + 2, hintY, rect.width - 4, right, T.composerHint);
  }
}
