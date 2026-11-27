/** Top bar, guild rail, channel sidebar, status bar, help overlay and toasts. */

import { asBig } from '../util.js';
import {
  drawText,
  fillRect,
  frame,
  hline,
  rightText,
  strWidth,
  truncate,
} from './draw.js';
import { style } from './term.js';
import { C, T } from './theme.js';
import { channelIcon, channelName, groupChannels, unreadLabel } from './model.js';
import { selectionRanges } from './clipboard.js';

const STATE_COLORS = {
  online: C.green,
  connecting: C.amber,
  retrying: C.amber,
  offline: C.red,
  stopped: C.textFaint,
};

const STATE_LABELS = {
  online: 'ONLINE',
  connecting: 'CONNECTING',
  retrying: 'RETRYING',
  offline: 'OFFLINE',
  stopped: 'STOPPED',
};

export function drawTopBar(app) {
  const screen = app.screen;
  const { cols } = app.geo;
  fillRect(screen, 0, 0, cols, 1, T.topbar);

  drawText(screen, 1, 0, 'ttycord', T.brand);
  if (cols >= 34) {
    drawText(screen, 9, 0, '::', T.topSep);
    drawText(screen, 12, 0, truncate(app.myName || 'me', 20), T.topName, 20);
  }

  const channel = app.currentChannel?.();
  if (channel && cols >= 80) {
    const label = `${channelIcon(channel)} ${channelName(channel, app.users, app.myId)}`;
    drawText(screen, 36, 0, truncate(label, Math.max(0, cols - 60)), T.topDim, cols - 60);
  }

  rightText(screen, 1, 0, cols - 2, app.clock, T.clock);
}

export function drawRail(app) {
  const screen = app.screen;
  const rect = app.geo.rail;
  if (rect.width <= 0) return;
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.rail);

  // Home (direct messages) row. It stays pinned while the guild list scrolls.
  const homeY = rect.y + 1;
  const dmSelected = app.railIndex === 0;
  const dmUnread = hasUnread(app, null);
  if (dmSelected) fillRect(screen, rect.x, homeY, rect.width, 1, T.railIconSel);
  screen.set(rect.x, homeY, dmSelected ? '>' : dmUnread ? '*' : ' ', dmSelected ? T.railMark : T.railBar);
  drawText(screen, rect.x + 2, homeY, 'DM', dmSelected ? T.railIconSel : T.railIcon, 2);
  drawText(
    screen,
    rect.x + 5,
    homeY,
    truncate('direct msgs', Math.max(2, rect.width - 6)),
    dmSelected ? T.railNameSel : T.railName,
    Math.max(2, rect.width - 6),
  );

  // The separator sits *below* the DM row. Drawing it on the same line used to
  // erase the home entry and shift every guild up by one row.
  if (rect.width >= 3) hline(screen, rect.x, rect.y + 2, rect.width, T.railDim, '─');

  const list = railRows(app).slice(1);
  const top = rect.y + 3;
  const height = Math.max(1, rect.height - 3);
  const selected = Math.max(0, app.railIndex - 1);
  let start = app.railOffset || 0;
  if (selected < start) start = selected;
  if (selected >= start + height) start = selected - height + 1;
  start = Math.max(0, Math.min(start, Math.max(0, list.length - height)));
  app.railOffset = start;

  for (let offset = 0; offset < height; offset += 1) {
    const rowIndex = start + offset;
    const row = list[rowIndex];
    if (!row) break;
    const y = top + offset;
    const isSelected = rowIndex === selected && app.railIndex > 0;

    if (row.kind === 'folder') {
      const tint = folderTint(row.folder);
      const base = tint
        ? style(tint, isSelected ? C.railSel : C.railBg, { bold: true })
        : isSelected ? T.railFolderSel : T.railFolder;
      if (isSelected) fillRect(screen, rect.x, y, rect.width, 1, T.railSel);
      screen.set(rect.x, y, isSelected ? '>' : ' ', isSelected ? T.railMark : T.railBar);
      drawText(screen, rect.x + 2, y, row.collapsed ? '[+]' : '[-]', base, 3);
      const label = row.collapsed ? `${row.label} (${row.count})` : row.label;
      drawText(screen, rect.x + 5, y, truncate(label, rect.width - 5), base, rect.width - 5);
      continue;
    }

    const guild = row.guild;
    const unread = guildHasUnread(app, guild);
    const label = String(row.index + 1).padStart(2, '0');
    const nameWidth = Math.max(2, rect.width - 5);

    if (isSelected) fillRect(screen, rect.x, y, rect.width, 1, T.railSel);
    screen.set(rect.x, y, isSelected ? '>' : unread ? '*' : ' ', isSelected ? T.railMark : T.railBar);
    // A dim bar shows which guilds live inside a folder.
    if (row.folderId) screen.set(rect.x + 1, y, '│', isSelected ? T.railNameSel : T.railDim);
    drawText(screen, rect.x + 2, y, label, isSelected ? T.railIconSel : unread ? T.railIconUnread : T.railIcon, 2);
    drawText(
      screen,
      rect.x + 5,
      y,
      truncate(guild.name, nameWidth),
      isSelected ? T.railNameSel : unread ? T.railIconUnread : T.railName,
      nameWidth,
    );
  }
}

/** Stable key for a guild folder. Anonymous singleton folders get no key. */
export function folderKey(folder) {
  if (!folder) return '';
  if (folder.id) return String(folder.id);
  if (folder.name) return `name:${folder.name}`;
  const ids = folder.guildIds || [];
  return ids.length > 1 ? `ids:${ids.join(',')}` : '';
}

/** Optional per-folder colour from Discord's `color` wrapper. */
function folderTint(folder) {
  const color = Number(folder?.color || 0);
  if (!Number.isFinite(color) || color <= 0) return '';
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * Flatten the rail into drawable rows. Row 0 is the DM home entry; the rest
 * are folder headers (with their guilds when expanded) and top-level guilds.
 *
 * Discord stores a guild outside any user folder as a nameless singleton
 * folder, so those are rendered as plain guild rows rather than `[+]` headers.
 */
export function railRows(app) {
  const rows = [{ kind: 'dm' }];
  const guilds = Array.isArray(app.guilds) ? app.guilds : [];
  const byId = new Map(guilds.map((guild, index) => [String(guild.id), { guild, index }]));
  const collapsed = app.collapsedFolders instanceof Set
    ? app.collapsedFolders
    : new Set(app.collapsedFolders || []);
  const placed = new Set();

  for (const folder of app.folders || []) {
    const members = (folder.guildIds || [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
    if (!members.length) continue;
    const key = folderKey(folder);
    if (!key) {
      // Discord represents a guild outside any folder as an anonymous
      // singleton folder; draw those as plain guild rows.
      for (const member of members) {
        rows.push({ kind: 'guild', guild: member.guild, index: member.index, folderId: null });
        placed.add(String(member.guild.id));
      }
      continue;
    }
    const isCollapsed = collapsed.has(key);
    rows.push({
      kind: 'folder',
      folder,
      key,
      label: String(folder.name || '').trim() || 'folder',
      collapsed: isCollapsed,
      count: members.length,
    });
    for (const member of members) placed.add(String(member.guild.id));
    if (!isCollapsed) {
      for (const member of members) {
        rows.push({ kind: 'guild', guild: member.guild, index: member.index, folderId: key });
      }
    }
  }

  // Guilds the settings payload did not mention (or a failed settings fetch)
  // still need a row.
  for (let index = 0; index < guilds.length; index += 1) {
    const guild = guilds[index];
    if (placed.has(String(guild.id))) continue;
    rows.push({ kind: 'guild', guild, index, folderId: null });
  }
  return rows;
}

function guildHasUnread(app, guild) {
  if (!guild) return false;
  for (const channel of guild.channels || []) {
    if (hasUnread(app, channel.id)) return true;
  }
  return false;
}

function hasUnread(app, channelId) {
  if (channelId === null) {
    for (const [id, entry] of app.unread) {
      const channel = app.client?.channel(id);
      if (channel && !channel.guild_id && (entry.count > 0 || entry.mentions > 0)) return true;
    }
    return false;
  }
  const entry = app.unread.get(String(channelId));
  return Boolean(entry && (entry.count > 0 || entry.mentions > 0));
}

/**
 * Map a terminal row in the rail to a rail index (0 = DM home, 1..n = the
 * scrollable list of folders/guilds). Returns `null` for the separator and for
 * rows outside the list.
 *
 * The rail layout is fixed: row 0 is the DM entry, row 1 the separator and the
 * list starts at row 2. Keeping the arithmetic here means drawing and
 * hit-testing cannot drift apart.
 */
export function railHitIndex(y, rail, offset, listCount) {
  const row = y - (rail.y + 1);
  if (row === 0) return 0;
  if (row < 2) return null;
  const index = Math.max(0, offset || 0) + (row - 2);
  return index < listCount ? index + 1 : null;
}

/** Map a terminal row in the sidebar to an item index, or `null`. */
export function sidebarHitIndex(y, sidebar, offset) {
  const row = y - (sidebar.y + 2);
  if (row < 0) return null;
  return Math.max(0, offset || 0) + row;
}

/** Flat list of sidebar rows. `channel` rows are the selectable ones. */
export function sidebarItems(app) {
  const items = [];
  if (app.selectedGuildId === null) {
    const dms = [...app.dms].sort((a, b) => {
      const left = asBig(a.last_message_id || 0);
      const right = asBig(b.last_message_id || 0);
      return left < right ? 1 : left > right ? -1 : 0;
    });
    for (const channel of dms) items.push({ kind: 'channel', channel });
    return items;
  }

  const guild = app.guilds.find((entry) => entry.id === app.selectedGuildId);
  const groups = groupChannels(guild?.channels || []);
  for (const group of groups) {
    if (group.category) {
      const collapsed = categoryCollapsed(app, group.category.id);
      items.push({
        kind: 'category',
        channel: group.category,
        label: String(group.category.name || 'category').toUpperCase(),
        collapsed,
      });
      if (collapsed) continue;
    }
    for (const channel of group.channels) items.push({ kind: 'channel', channel });
  }
  return items;
}

/** Whether a channel category is collapsed. Accepts a Set or a plain array. */
export function categoryCollapsed(app, categoryId) {
  const id = String(categoryId);
  const state = app.collapsedCategories;
  if (state instanceof Set) return state.has(id);
  return Array.isArray(state) && state.map(String).includes(id);
}

export function selectableChannels(app) {
  return sidebarItems(app)
    .filter((item) => item.kind === 'channel')
    .map((item) => item.channel);
}

export function drawSidebar(app) {
  const screen = app.screen;
  const rect = app.geo.sidebar;
  if (rect.width <= 0) return;
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.sidebar);

  const guild =
    app.selectedGuildId === null
      ? null
      : app.guilds.find((entry) => entry.id === app.selectedGuildId);
  const title = guild ? guild.name : 'direct messages';
  drawText(screen, rect.x + 1, rect.y, '::', T.sideSep);
  drawText(screen, rect.x + 4, rect.y, truncate(title, rect.width - 5), T.sideTitle, rect.width - 5);
  hline(screen, rect.x, rect.y + 1, rect.width, T.sideDim, '─');

  const items = sidebarItems(app);
  app.sideItems = items;
  const top = rect.y + 2;
  const height = rect.height - 2;

  const selectedRow = items.findIndex(
    (item) => item.kind === 'channel' && item.channel.id === app.selectedChannelId,
  );
  // A collapsed category can hide the selected channel; in that case leave the
  // scroll position alone instead of snapping back to the top.
  if (selectedRow >= 0) {
    if (selectedRow < app.sideOffset) app.sideOffset = selectedRow;
    if (selectedRow >= app.sideOffset + height) app.sideOffset = selectedRow - height + 1;
  }
  app.sideOffset = Math.max(0, Math.min(app.sideOffset, Math.max(0, items.length - height)));

  for (let row = 0; row < height; row += 1) {
    const index = app.sideOffset + row;
    const item = items[index];
    if (!item) break;
    const y = top + row;

    if (item.kind === 'category') {
      const labelWidth = Math.max(2, rect.width - 4);
      drawText(screen, rect.x + 1, y, item.collapsed ? '[+]' : '[-]', T.sideCategory, 3);
      drawText(screen, rect.x + 4, y, truncate(item.label, labelWidth), T.sideCategory, labelWidth);
      continue;
    }

    const channel = item.channel;
    const selected = channel.id === app.selectedChannelId;
    const entry = app.unread.get(String(channel.id));
    const unread = Boolean(entry && (entry.count > 0 || entry.mentions > 0));
    const mentions = Number(entry?.mentions || 0);

    if (selected) fillRect(screen, rect.x, y, rect.width, 1, T.channelSel);

    const iconStyle = selected ? T.channelIconSel : T.channelIcon;
    const textStyle = selected
      ? T.channelSel
      : unread
        ? T.channelUnread
        : T.channel;

    screen.set(rect.x + 1, y, selected ? '>' : unread ? '*' : ' ', selected ? T.channelMark : T.channelUnread);
    drawText(screen, rect.x + 3, y, channelIcon(channel), iconStyle, 2);
    const nameWidth = Math.max(2, rect.width - 9);
    drawText(
      screen,
      rect.x + 5,
      y,
      truncate(channelName(channel, app.users, app.myId), nameWidth),
      textStyle,
      nameWidth,
    );

    if (mentions > 0) {
      const label = `(${unreadLabel(mentions)})`;
      rightText(screen, rect.x + 1, y, rect.width - 2, label, selected ? T.channelSel : T.badge);
    } else if (unread) {
      rightText(screen, rect.x + 1, y, rect.width - 2, '*', selected ? T.channelSel : T.channelUnread);
    }
  }
}

/**
 * Dropdown above the composer with `@user` / `#channel` candidates. Drawn
 * after the chat so it floats over messages without changing the layout.
 */
export function drawMentionMenu(app) {
  app.mentionMenu = null;
  const state = app.mentionState?.();
  if (!state) return;
  const items = state.items;
  const screen = app.screen;
  const composer = app.geo.composer;
  const minTop = app.geo.messages.y;
  const available = composer.y - minTop;
  if (available < 3) return;
  const rows = Math.max(1, Math.min(items.length, available - 2));
  const width = Math.max(20, Math.min(composer.width - 4, 56));
  const height = rows + 2;
  const x = Math.max(0, Math.min(composer.x + 2, app.geo.cols - width));
  const top = Math.max(minTop, composer.y - 1 - height + 1);

  const inner = frame(screen, x, top, width, height, T.menuBorder, T.menuBg, { rounded: false });
  const index = Math.max(0, Math.min(app.mentionIndex || 0, items.length - 1));
  const offset = index >= rows ? index - rows + 1 : 0;

  for (let row = 0; row < rows; row += 1) {
    const item = items[offset + row];
    if (!item) break;
    const y = inner.y + row;
    const selected = offset + row === index;
    const st = selected ? T.menuSel : T.menuBg;
    fillRect(screen, inner.x, y, inner.width, 1, st);
    drawText(screen, inner.x, y, selected ? '>' : ' ', selected ? T.menuSel : T.menuDim, 1);
    const marker = item.kind === 'channel' ? '#' : '@';
    drawText(screen, inner.x + 2, y, marker, selected ? T.menuSel : T.menuKey, 1);
    const hint = item.hint ? String(item.hint) : '';
    const hintWidth = hint ? Math.min(strWidth(hint), Math.floor(inner.width / 2)) : 0;
    const labelWidth = Math.max(1, inner.width - 4 - (hintWidth ? hintWidth + 1 : 0));
    drawText(screen, inner.x + 4, y, truncate(item.label, labelWidth), st, labelWidth);
    if (hintWidth) {
      rightText(
        screen,
        inner.x,
        y,
        inner.width - 1,
        truncate(hint, hintWidth),
        selected ? T.menuSel : T.menuDim,
      );
    }
  }

  app.mentionMenu = {
    x,
    y: top,
    width,
    height,
    rows: Array.from({ length: rows }, (_, row) => inner.y + row),
    offset,
  };
}

/**
 * Click-to-act popup for a message. It is positioned inside the pane that was
 * clicked and painted after the message log, so it sits above the cursor band.
 */
export function drawMessageMenu(app) {
  const menu = app.messageMenu;
  if (!menu) return;
  const screen = app.screen;
  const pane = app.geo.panes?.[menu.paneIndex] || app.geo;
  const area = pane.messages || pane;
  if (!area || area.width < 8 || area.height < 4) return;

  const labels = menu.items.map((item) => `${item.label}${item.hint ? `  ${item.hint}` : ''}`);
  const width = Math.min(
    Math.max(20, Math.max(...labels.map((label) => strWidth(label))) + 6),
    Math.max(8, area.width - 2),
  );
  const height = menu.items.length + 2;
  let x = menu.px + 2;
  if (x + width > area.x + area.width - 1) x = area.x + area.width - width - 1;
  x = Math.max(area.x + 1, x);
  let y = menu.py - 1;
  if (y + height > area.y + area.height - 1) y = area.y + area.height - height - 1;
  y = Math.max(area.y + 1, y);

  const inner = frame(screen, x, y, width, height, T.menuBorder, T.menuBg, { rounded: false });
  menu.x = x;
  menu.y = y;
  menu.width = width;
  menu.height = height;
  menu.rows = [];

  for (let index = 0; index < menu.items.length; index += 1) {
    const item = menu.items[index];
    const rowY = inner.y + index;
    menu.rows.push(rowY);
    const danger = item.key === 'delete' && menu.confirmDelete;
    const st = danger ? T.menuDanger : T.menuBg;
    fillRect(screen, inner.x, rowY, inner.width, 1, st);
    drawText(screen, inner.x, rowY, '>', danger ? T.menuDanger : T.menuKey, 1);
    drawText(screen, inner.x + 2, rowY, truncate(item.label, inner.width - 4), st, inner.width - 4);
    if (item.hint) {
      rightText(screen, inner.x, rowY, inner.width - 2, item.hint, T.menuDim);
    }
  }
}

export function drawStatus(app) {
  const screen = app.screen;
  const rect = app.geo.status;
  if (rect.height <= 0) return;
  fillRect(screen, rect.x, rect.y, rect.width, rect.height, T.status);

  const stateStyle = style(STATE_COLORS[app.state] || C.textFaint, C.panel, { bold: true });
  const stateText = `[${STATE_LABELS[app.state] || ''}]`;
  drawText(screen, 1, rect.y, stateText, stateStyle);

  if (rect.width >= 40) {
    const focusLabel =
      { rail: 'rail', sidebar: 'chan', composer: 'input', messages: 'msg' }[app.focus] || app.focus;
    const sepX = 2 + strWidth(stateText);
    drawText(screen, sepX, rect.y, '::', T.statusSep);
    const panes = app.geo.panes?.length || 1;
    const split = app.splitMode && panes > 1 ? `  ${app.activePaneIndex() + 1}/${panes}` : '';
    const label = `focus:${focusLabel}${split}`;
    drawText(screen, sepX + 3, rect.y, truncate(label, rect.width - sepX - 4), T.status, rect.width - sepX - 4);
  }

  if (rect.width >= 78) {
    const hints = app.selection
      ? '^c copy   esc cancel'
      : app.reactMode
        ? '1-8 pick   type emoji / name   enter ok   esc cancel'
        : app.focus === 'messages'
          ? 'j/k move   r react   R reply   e edit   d del   y link   esc back'
          : app.splitMode
            ? '1-4 pane   ^w close   s off   z wide   ? help   ^c x2 quit'
            : 'm msg   i img   z wide   s split   tab focus   ^v paste   ? help';
    rightText(screen, rect.x + 1, rect.y, rect.width - 2, hints, T.status);
  }
}

/**
 * Rules between split panes. Vertical rules separate columns; a horizontal
 * rule separates the two rows of the 2x2/three-pane layouts. The rule touching
 * the focused pane brightens so the active pane is obvious even when its
 * header is scrolled out of view.
 */
export function drawPaneDividers(app) {
  const screen = app.screen;
  const panes = app.geo.panes || [];
  if (panes.length < 2) return;
  const active = app.activePaneIndex();
  const dividers = app.geo.dividers;
  if (!dividers) return;

  for (const rule of dividers.vertical) {
    const focused = rule.left === active || rule.right === active;
    const ruleStyle = focused ? T.paneDividerFocus : T.paneDivider;
    for (let y = rule.y; y < rule.y + rule.height; y += 1) {
      screen.set(rule.x, y, '│', ruleStyle);
    }
  }

  for (const rule of dividers.horizontal) {
    const focused = (rule.rows || []).some((band) =>
      (app.geo.bands?.[band]?.panes || []).includes(active),
    );
    const ruleStyle = focused ? T.paneDividerFocus : T.paneDivider;
    for (let x = rule.x; x < rule.x + rule.width; x += 1) {
      screen.set(x, rule.y, '─', ruleStyle);
    }
    // Where the horizontal rule meets a column divider, use the matching
    // junction: a full cross in the 2x2 grid, a T where only the row above has
    // two columns (the three-pane layout).
    for (const x of rule.junctions || []) {
      const above = dividers.vertical.some((rule2) => rule2.x === x && rule2.band === rule.rows?.[0]);
      const below = dividers.vertical.some((rule2) => rule2.x === x && rule2.band === rule.rows?.[1]);
      const glyph = above && below ? '┼' : above ? '┴' : below ? '┬' : '─';
      screen.set(x, rule.y, glyph, ruleStyle);
    }
  }
}

/**
 * Paint the mouse-drag selection over the finished frame.
 *
 * Only styles change; text extraction reads the same cell grid, so the
 * highlight and the copied text can never disagree.
 */
export function drawSelection(app) {
  if (!app.selection) return;
  const screen = app.screen;
  // Same ranges as the copied text: first line anchor -> end, full middle
  // lines, last line start -> focus. Never a rectangle, and bounded to the
  // pane where the drag started.
  const bounds = app.selectionBounds?.() ?? null;
  for (const { y, start, end } of selectionRanges(screen, app.selection, bounds)) {
    for (let x = start; x <= end; x += 1) {
      screen.styles[y * screen.cols + x] = T.selection;
    }
  }
}

export function drawHelp(app) {
  const screen = app.screen;
  const { cols, rows } = app.geo;
  const width = Math.min(68, Math.max(40, cols - 6));
  const height = Math.min(28, rows - 4);
  const x = Math.floor((cols - width) / 2);
  const y = Math.floor((rows - height) / 2);

  fillRect(screen, 0, 0, cols, rows, T.helpBg);
  fillRect(screen, x, y, width, height, T.helpBg);
  frame(screen, x, y, width, height, T.helpBorder, T.helpBg, { rounded: false });
  drawText(screen, x + 3, y + 1, 'ttycord', T.helpTitle);
  drawText(screen, x + 11, y + 1, '::', T.helpDim);
  drawText(screen, x + 14, y + 1, 'keys', T.helpText);

  const rowsData = [
    ['tab / S-tab', 'focus rail / channels / input'],
    ['j / k, up/down', 'move selection / message cursor'],
    ['enter / ^enter', 'open or send / newline (alt+enter, ^j)'],
    ['space', 'collapse folder / category'],
    ['esc', 'input -> channel list, cancel selection'],
    ['h / l, left/right', 'move rail / channels / input'],
    ['pgup / pgdn', 'scroll messages'],
    ['i', 'toggle inline images'],
    ['z', 'toggle wide chat (hide rail/channels)'],
    ['s', 'split view on/off (2x2 grid, up to 4)'],
    ['1-4', 'focus a split pane'],
    ['^left / ^right', 'previous / next split pane'],
    ['^w', 'close the focused split pane'],
    ['^r', 'reload messages'],
    ['^u', 'clear input'],
    ['^x', 'remove last staged attachment'],
    ['^v', 'paste clipboard image / file'],
    ['m', 'message mode (click for the action menu)'],
    ['r / R', 'react (1-8 or a name) / reply'],
    ['e / d / y', 'edit / delete (twice) / copy link'],
    ['@ / #', 'mention a user / channel'],
    ['mouse', 'click a message for actions / an image to open'],
    ['drag + ^c', 'select text and copy it'],
    ['drag file', 'drop a file path to attach it'],
    ['?', 'close this help'],
    ['^c', 'copy selection / quit (twice)'],
  ];

  let row = y + 3;
  for (const [key, text] of rowsData) {
    if (row >= y + height - 2) break;
    drawText(screen, x + 3, row, key, T.helpKey, 18);
    drawText(screen, x + 22, row, text, T.helpText, width - 25);
    row += 1;
  }
  drawText(screen, x + 3, y + height - 2, 'press any key', T.helpDim);
}

export function drawToasts(app) {
  const screen = app.screen;
  const { cols } = app.geo;
  const now = Date.now();
  const toasts = app.toasts.filter((toast) => toast.until > now).slice(-3);
  let y = app.geo.status.y - 1;
  for (let index = toasts.length - 1; index >= 0; index -= 1) {
    const toast = toasts[index];
    const prefix = toast.kind === 'error' ? '[!]' : toast.kind === 'ok' ? '[+]' : '[i]';
    const label = `${prefix} ${toast.text}`;
    const width = Math.min(cols - 4, Math.max(12, strWidth(label) + 4));
    const x = cols - width - 2;
    const base = toast.kind === 'error' ? T.toastError : toast.kind === 'ok' ? T.toastOk : T.toast;
    fillRect(screen, x, y, width, 1, base);
    drawText(screen, x + 2, y, truncate(label, width - 4), base, width - 4);
    y -= 1;
    if (y < 1) break;
  }
}
