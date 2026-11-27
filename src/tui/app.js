/** Application state, live wiring and input handling for the Discord TUI. */

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { asBig, clamp, formatBytes, graphemes, isTextChannel, mentionsUser, sleep } from '../util.js';
import { orderGuilds } from '../protocol/guild-order.js';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  isPathLike,
  looksLikeFileDrop,
  parseAttachmentText,
} from './attach.js';
import {
  composerLineCount,
  composerMoveVertical,
  composerTextWidth,
} from './composer.js';
import { MAX_PANES, computeLayout } from './layout.js';
import {
  clockLabel,
  displayName,
  groupChannels,
  normalizeGuild,
  reactionKey,
  sortChannels,
} from './model.js';
import { drawChatHeader, drawComposer, drawMessages, drawTyping, messageLinkAt } from './pane.js';
import { copyText, selectionText } from './clipboard.js';
import { REACTION_CHOICES, reactionChoice, resolveReaction } from './reactions.js';
import { readClipboard } from './clipboard-read.js';
import {
  MENTION_LIMIT,
  channelMentionItems,
  mentionToken,
  specialMentionItems,
  userMentionItems,
} from './mention.js';
import {
  downloadImage,
  imageCapability,
  imageKey,
  isPreviewable,
  masterImage,
} from './image.js';
import { playSound } from './sound.js';
import { T } from './theme.js';
import {
  drawHelp,
  drawMentionMenu,
  drawMessageMenu,
  drawPaneDividers,
  drawRail,
  drawSelection,
  drawSidebar,
  drawStatus,
  drawToasts,
  drawTopBar,
  folderKey,
  railHitIndex,
  railRows,
  selectableChannels,
  sidebarHitIndex,
} from './views.js';

const FOCUS_ORDER = ['rail', 'sidebar', 'composer'];
const PAGE = 8;
const TOAST_MS = 4_000;
// Ctrl+C copies a selection; quitting takes a second press (like readline's
// "press again" guard) so a stray Ctrl+C cannot kill the session.
const QUIT_CONFIRM_MS = 2_000;
const HISTORY_LIMIT = 50;
// Notifications: a bell on new activity plus the unread/mention counts in the
// terminal title. The bell policy is `mention` by default so a busy guild does
// not beep on every line; `all` and `off` are the other two settings.
const BELL_MODES = new Set(['mention', 'all', 'off']);
const BELL_COOLDOWN = 1_500;
// The clock ticks every second. A much larger gap means the process (or the
// whole machine) was suspended; timers and sockets are usually stale then.
const WAKE_GAP_MS = 10_000;
// Give the network a moment to come back before refetching the visible panes.
const WAKE_REFRESH_DELAY = 1_500;
// A resume often beats Wi-Fi/DHCP back, and the TLS proxy may still hold a
// dead pooled connection. Retry quietly instead of showing "502 upstream".
const WAKE_REFRESH_RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000];
// Coming back to the terminal after this long should probe the gateway and
// refetch the visible panes, even if the machine itself never suspended.
const FOCUS_WAKE_MS = 15_000;
// A gateway reconnect that kept us offline for at least this long can have
// lost events (an expired session gets a fresh READY instead of a RESUME).
const OFFLINE_REFRESH_MS = 5_000;

function bellModeFromEnv() {
  const raw = String(process.env.TTYCORD_BELL || '').trim().toLowerCase();
  return BELL_MODES.has(raw) ? raw : 'mention';
}
// Keyboard-driven guards. Discord's documented limits are per channel, so a
// fixed global interval is not enough: `Ctrl+R` and `Enter` are the two paths
// where a user can outrun the server.
const RELOAD_COOLDOWN = 1_500;
const CHANNEL_SETTLE_MS = 120;
const SEND_WINDOW_MS = 5_000;
const SEND_WINDOW_MAX = 4;
// Inline images: decode a bounded window of the newest attachments, two at a
// time, so opening a channel does not fan out into dozens of CDN requests.
const IMAGE_AUTOLOAD = 24;
const IMAGE_CONCURRENCY = 2;
// Some terminals (notably VTE) deliver a file drop as ordinary characters
// instead of a bracketed paste. Paths arrive as a rapid burst, so buffer
// path-shaped text briefly and decide once the burst ends.
const RAW_DROP_MS = 90;
// Human typing has gaps between characters; a drop/paste arrives as one burst.
const RAW_DROP_MAX_GAP_MS = 45;
const RAW_DROP_MIN_CHARS = 8;

/** Character that can begin a dropped path or a quoted path. */
function isPathStart(text) {
  return (
    text.length === 1 &&
    (text === '/' ||
      text === '~' ||
      text === '.' ||
      text === '\\' ||
      text === "'" ||
      text === '"')
  );
}

/**
 * Does the buffered text look like a path list rather than a slash command or
 * prose? Requiring at least two separators (or a URI/drive prefix) keeps
 * `/help` typed into the composer from being mistaken for a missing file.
 */
function hasStrongPathShape(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => {
    let value = line;
    if (
      value.length >= 2 &&
      ((value[0] === "'" && value.at(-1) === "'") ||
        (value[0] === '"' && value.at(-1) === '"'))
    ) {
      value = value.slice(1, -1);
    }
    if (/^file:\/\//i.test(value)) return true;
    if (/^~[\\/]/.test(value)) return true;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    if (value.startsWith('\\\\')) return true;
    if (value.startsWith('./') || value.startsWith('../')) return true;
    return (value.match(/[\\/]/g) || []).length >= 2;
  });
}

function newChat(id) {
  return {
    id: String(id),
    items: [],
    byId: new Map(),
    version: 0,
    loaded: false,
    loading: false,
    error: null,
    draft: '',
    cursor: 0,
    // Files staged for the next send. Kept per channel, like the draft.
    attachments: [],
    scroll: 0,
    layout: null,
    oldestId: null,
    hasMore: true,
    unreadMarker: null,
    // Message cursor + pending reply/edit for this channel.
    cursorId: null,
    replyTo: null,
    editingId: null,
    editBackup: null,
    history: [],
    historyIndex: null,
  };
}

function normalizeMessage(message) {
  if (!message) return null;
  return {
    ...message,
    id: String(message.id),
    channel_id: String(message.channel_id || ''),
    author: message.author
      ? { ...message.author, id: String(message.author.id) }
      : message.author,
  };
}

function messageOrder(message) {
  return /^\d+$/.test(message.id) ? asBig(message.id) : 2n ** 63n;
}

export class App {
  constructor({
    client,
    live = null,
    screen,
    input = null,
    out = process.stdout,
    version = '',
    debug = null,
    images = true,
    preferences = null,
    copy = copyText,
    paste = readClipboard,
    sound = playSound,
  }) {
    this.client = client;
    this.live = live;
    this.screen = screen;
    this.input = input;
    this.out = out;
    this.version = version;
    this.debug = debug;

    // Half-block previews need 24-bit color; probe once so the toggle can
    // explain itself instead of silently doing nothing.
    const capability = images ? imageCapability() : { ok: false, reason: '--no-images' };
    this.images = {
      supported: Boolean(capability.ok),
      enabled: Boolean(capability.ok),
      reason: capability.reason || '',
    };
    this.thumbs = new Map();
    this.thumbQueue = [];
    this.thumbActive = 0;

    this.myId = String(client.me?.id || '');
    this.myName = displayName(client.me, 'me');
    this.users = client.users;

    this.guilds = [];
    this.dms = [];
    this.guildOrder = [];
    this.folders = [];
    // Collapse state is client-local (Discord does not sync it either), but it
    // is persisted through the injected `persist` callback when available.
    this.collapsedFolders = new Set(preferences?.collapsedFolders || []);
    this.collapsedCategories = new Set(preferences?.collapsedCategories || []);
    this.lastView = preferences?.lastView || null;
    // Guild id -> last channel visited in that guild. Kept across server
    // switches (and across restarts through `lastChannels`).
    this.lastChannelByGuild = new Map(
      Object.entries(preferences?.lastChannels || {}).map(([guildId, channelId]) => [
        String(guildId),
        String(channelId),
      ]),
    );
    this.persistPrefs = preferences?.persist || null;
    // Clipboard delivery is injectable so tests do not need wl-copy/xclip.
    this.copy = copy;
    // Clipboard *reading* (Ctrl+V) is injectable too; the real reader shells
    // out to a GTK helper because terminals never forward clipboard images.
    this.paste = paste;
    this.clipboardBusy = false;
    // Temp PNGs written by the clipboard reader; deleted once sent.
    this.clipboardFiles = new Set();
    // Message cursor: `focus === 'messages'` routes keys to the selected
    // message, and `reactMode` is the open reaction bar.
    this.reactMode = null;
    this.deleteArmed = null;
    this.messageMenu = null;
    this.selection = null;
    // Raw (non-bracketed) file-drop burst buffer.
    this.rawDropBuffer = '';
    this.rawDropLastAt = 0;
    this.rawDropMaxGap = 0;
    this.rawDropTimer = null;
    this.rawDropProbe = false;
    this.mentionIndex = 0;
    this.mentionMuted = false;
    this.mentionMenu = null;
    this.selectedGuildId = null;
    this.selectedChannelId = null;
    this.railIndex = 0;
    this.railOffset = 0;
    this.sideOffset = 0;
    this.sideItems = [];
    // Split view: `panes` holds up to MAX_PANES channel ids, `paneIndex` is the
    // focused column. `selectedChannelId` always mirrors the focused pane so
    // every single-channel code path (composer, mentions, ack) keeps working.
    this.splitMode = false;
    this.panes = [];
    this.paneIndex = 0;
    this.messagesViews = [];
    this.messagesView = null;

    this.focus = 'sidebar';
    this.help = false;
    this.wide = Boolean(this.lastView?.wide);
    this.toasts = [];
    this.chats = new Map();
    this.readStates = new Map();
    this.unread = new Map();

    this.state = 'connecting';
    this.clock = clockLabel();
    this.geo = this.computeGeometry();
    this.running = false;
    this.bootstrapped = false;
    this.selecting = false;
    this.guildLoads = new Map();
    this.guildSeq = 0;
    this.tmpSeq = 0;
    // Selection generation: a load that finishes after the user moved on must
    // not mark another channel read or steal focus back.
    this.channelSeq = 0;
    this.lastReloadAt = 0;
    this.lastSendToastAt = 0;
    this.quitArmedAt = 0;
    this.sendTimes = new Map();
    this.lastTickAt = Date.now();
    this.wakeTimer = null;
    this.needWakeRefresh = false;
    // DECSET 1004 focus tracking. Terminals that do not implement it simply
    // never send the events, so the app stays in the "focused" state.
    this.focused = true;
    this.blurredAt = 0;
    this.offlineAt = 0;
    this.bellMode = bellModeFromEnv();
    // Discord's per-guild/channel notification settings, keyed by guild id
    // ('' for DMs). Filled from READY and kept current by gateway updates.
    this.guildSettings = new Map();
    // Playback is injectable so tests never spawn an audio player.
    this.sound = sound;
    this.lastBellAt = 0;
    this.title = '';
    this.clockTimer = null;
    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.running = true;
    this.lastTickAt = Date.now();
    this.attachInput();
    this.attachLive();
    this.clockTimer = setInterval(() => this.tick(), 1000);
    this.clockTimer.unref?.();
    this.draw();
    this.live?.start?.();
    this.bootstrap();
    return this.done;
  }

  quit() {
    if (!this.running) return;
    this.running = false;
    this.cancelRawDrop();
    this.messageMenu = null;
    this.releaseClipboardFiles([...this.clipboardFiles]);
    this.saveView();
    // Do not leave a stale unread count in the title after the TUI exits.
    this.writeTerminal('\x1b]0;\x07');
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.needWakeRefresh = false;
    try {
      this.live?.stop?.();
    } catch {
      /* already down */
    }
    this._resolveDone();
  }

  resize(cols, rows) {
    this.screen.resize(cols, rows);
    // Cell coordinates from before the resize no longer point at the text.
    this.selection = null;
    this.messageMenu = null;
    this.geo = this.computeGeometry();
    this.draw();
  }

  /**
   * Layout depends on the pane count and on the tallest draft/attachment stack
   * among the panes: all columns must share a baseline so their composers line
   * up. Two passes because the text width (and therefore the wrap) is only
   * known after the columns are split.
   */
  computeGeometry() {
    const ids = this.paneIds();
    const count = Math.max(1, ids.length);
    let attachments = 0;
    for (const id of ids) {
      attachments = Math.max(attachments, this.chat(id).attachments?.length || 0);
    }
    // A reply or an in-progress edit adds one banner row to every composer so
    // the panes keep their baseline.
    const banner = ids.some((id) => {
      const cache = this.chat(id);
      return Boolean(cache.replyTo || cache.editingId);
    })
      ? 1
      : 0;
    const options = {
      wide: this.wide,
      attachments,
      composerLines: 1,
      banner,
      panes: count,
      focus: this.activePaneIndex(),
    };
    const base = computeLayout(this.screen.cols, this.screen.rows, options);
    const width = Math.min(...base.panes.map((pane) => composerTextWidth(pane.composer.width)));
    let lines = 1;
    for (const id of ids) {
      lines = Math.max(lines, composerLineCount(this.chat(id).draft || '', width));
    }
    if (lines <= 1) return base;
    return computeLayout(this.screen.cols, this.screen.rows, { ...options, composerLines: lines });
  }

  // ------------------------------------------------------------------- panes
  /** Channel ids currently on screen, in row-major pane order. */
  paneIds() {
    if (!this.splitMode) return this.selectedChannelId ? [this.selectedChannelId] : [];
    return this.panes.slice(0, MAX_PANES);
  }

  activePaneIndex() {
    const count = this.paneIds().length;
    if (!count) return 0;
    return clamp(this.paneIndex, 0, count - 1);
  }

  /** Focused pane, with the rects and cache the draw/input code needs. */
  activePane() {
    const index = this.activePaneIndex();
    const id = this.paneIds()[index] || null;
    const channel = id ? this.channelById(id) : null;
    return {
      index,
      id,
      channel,
      cache: id ? this.chat(id) : null,
      rect: this.geo?.panes?.[index] || this.geo?.chat || { x: 0, y: 0, width: 1, height: 1 },
      focused: true,
    };
  }

  /** Every visible pane in draw order. */
  paneViews() {
    const ids = this.paneIds();
    const list = ids.length ? ids : [null];
    const active = this.activePaneIndex();
    const rects = this.geo?.panes || [];
    return list.map((id, index) => {
      const channel = id ? this.channelById(id) : null;
      return {
        index,
        id,
        channel,
        cache: id ? this.chat(id) : null,
        rect: rects[index] || rects[0] || this.geo?.chat,
        focused: index === active,
      };
    });
  }

  /**
   * Put an opened channel into the split layout.
   *
   * Already-open channels just get focus. New ones append until four panes
   * exist; after that the focused pane is replaced, which is the overflow rule
   * the split view promises.
   */
  selectPaneFor(channelId) {
    const id = String(channelId);
    if (!this.splitMode) {
      this.panes = [id];
      this.paneIndex = 0;
      return;
    }
    const existing = this.panes.indexOf(id);
    if (existing >= 0) {
      this.paneIndex = existing;
      return;
    }
    if (this.panes.length >= MAX_PANES) {
      this.paneIndex = clamp(this.paneIndex, 0, this.panes.length - 1);
      this.panes[this.paneIndex] = id;
      return;
    }
    this.panes.push(id);
    this.paneIndex = this.panes.length - 1;
  }

  toggleSplit() {
    if (!this.splitMode) {
      this.splitMode = true;
      this.panes = this.selectedChannelId ? [this.selectedChannelId] : [];
      this.paneIndex = 0;
      this.toast('split view on · opening channels fills up to 4 panes');
    } else {
      const id = this.selectedChannelId;
      this.splitMode = false;
      this.panes = id ? [id] : [];
      this.paneIndex = 0;
      this.toast('split view off');
    }
    this.selection = null;
    this.invalidateLayouts();
    this.draw();
  }

  /**
   * Guild that owns a channel. Some payloads omit `guild_id` on channels that
   * arrived through READY, so fall back to scanning the loaded guilds before
   * treating a channel as a DM.
   */
  channelGuildId(channel, channelId = channel?.id) {
    if (channel?.guild_id) return String(channel.guild_id);
    const id = String(channelId || '');
    if (!id) return null;
    const owner = this.guilds.find((guild) =>
      (guild.channels || []).some((entry) => String(entry.id) === id),
    );
    return owner ? String(owner.id) : null;
  }

  /**
   * Make the rail/sidebar follow a channel from any split pane. Focusing or
   * closing a column can land on a different guild (or a DM) than the one the
   * sidebar was showing.
   */
  syncGuildContext(channel) {
    if (!channel) return;
    const id = String(channel.id || '');
    const guildId = this.channelGuildId(channel);
    if (guildId) {
      if (guildId === String(this.selectedGuildId)) return;
      this.selectedGuildId = guildId;
      const guildIndex = this.guilds.findIndex((guild) => String(guild.id) === guildId);
      if (guildIndex >= 0) this.railIndex = this.railIndexForGuild(guildId, guildIndex + 1);
      this.sideOffset = 0;
      const guild = this.guilds[guildIndex];
      if (guild && !guild.channels?.length) this.loadGuildChannels(guild.id);
      if (guild) this.revealChannel(channel);
      return;
    }
    // Only a real DM (or an unknown channel that is not in any guild) clears
    // guild context. A guild channel with a missing `guild_id` must not send
    // the sidebar to the DM list.
    if (this.dms.some((entry) => String(entry.id) === id)) {
      this.selectedGuildId = null;
      this.railIndex = 0;
      this.sideOffset = 0;
    }
  }

  /** Focus pane `index` (0-based) without reloading its messages. */
  focusPane(index) {
    const ids = this.paneIds();
    if (index < 0 || index >= ids.length) return false;
    if (index === this.activePaneIndex()) return true;
    const id = ids[index];
    this.paneIndex = index;
    this.selectedChannelId = id;
    this.selection = null;
    this.resetMention();
    this.syncGuildContext(this.channelById(id));
    // Return the open promise so callers/tests can wait for a lazily resolved
    // pane; ordinary key/mouse handlers still ignore the return value.
    return this.openChannel(id, { focus: false, resetScroll: false, resolve: true });
  }

  /** Close the focused split column; the last one stays. */
  closePane() {
    if (!this.splitMode) {
      this.toast('split view is off (press s to enable)');
      return;
    }
    if (this.panes.length <= 1) {
      this.toast('cannot close the last pane (s: turn split view off)');
      return;
    }
    const index = this.activePaneIndex();
    this.panes.splice(index, 1);
    this.paneIndex = clamp(index, 0, this.panes.length - 1);
    this.selection = null;
    this.resetMention();
    const id = this.panes[this.paneIndex];
    this.selectedChannelId = id;
    this.toast('pane closed');
    this.syncGuildContext(this.channelById(id));
    this.openChannel(id, { focus: false, resetScroll: false, resolve: true });
  }

  /** Split pane under a screen cell, if any. */
  paneAt(point) {
    for (const pane of this.paneViews()) {
      const rect = pane.rect?.chat;
      if (!rect) continue;
      if (
        point.x >= rect.x &&
        point.x < rect.x + rect.width &&
        point.y >= rect.y &&
        point.y < rect.y + rect.height
      ) {
        return pane;
      }
    }
    return null;
  }

  tick() {
    const now = Date.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap > WAKE_GAP_MS) this.wake();
    this.clock = clockLabel();
    if (this.toasts.some((toast) => toast.until <= now)) {
      this.toasts = this.toasts.filter((toast) => toast.until > now);
    }
    this.draw();
  }

  /**
   * Recover from suspend, SIGCONT, or a long stay in a background terminal
   * tab. A WebSocket that looks open may already be dead, and Discord's
   * session may have expired, so probe/reconnect and refresh the visible
   * channels from REST once the network is back.
   */
  wake() {
    if (!this.running) return;
    this.lastTickAt = Date.now();
    this.lastBellAt = 0;
    this.debug?.('wake detected; probing live connection');
    // The terminal may have been reset while the machine slept.
    this.screen.invalidate?.();
    this.live?.wake?.();
    this.scheduleRefresh(WAKE_REFRESH_DELAY);
    this.draw();
  }

  /** Queue a quiet refresh once the gateway is known to be online. */
  scheduleRefresh(delay = WAKE_REFRESH_DELAY) {
    this.needWakeRefresh = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.tryWakeRefresh();
    }, delay);
    this.wakeTimer.unref?.();
  }

  /**
   * Terminal focus reporting (DECSET 1004). Discord's own client only marks a
   * channel read while its window is focused; without this, messages arriving
   * in the visible channel while the tab was in the background were silently
   * marked read and never rang or showed up in the title.
   */
  onBlur() {
    if (!this.running) return;
    this.focused = false;
    this.blurredAt = Date.now();
    this.debug?.('terminal focus lost');
  }

  onFocus() {
    if (!this.running) return;
    const away = this.blurredAt ? Date.now() - this.blurredAt : 0;
    this.focused = true;
    this.blurredAt = 0;
    this.screen.invalidate?.();
    this.debug?.(`terminal focus after ${away}ms`);
    if (away >= FOCUS_WAKE_MS) {
      this.wake();
      return;
    }
    // Short tab switch: the gateway kept delivering, so just clear the unread
    // state for the panes now on screen.
    this.markVisibleRead();
    this.draw();
  }

  /** Mark the channels currently on screen read, without scrolling them. */
  markVisibleRead() {
    for (const id of new Set(this.paneIds())) {
      const cache = this.chats.get(String(id));
      if (!cache || cache.loading || (cache.scroll || 0) > 0) continue;
      const last = cache.items[cache.items.length - 1]?.id;
      if (last) this.ackVisibleChannel(id, this.unread.has(String(id)));
    }
  }

  /**
   * Refresh only once the gateway is back online. If the probe triggered a
   * reconnect, the timer can fire while the socket is still down; waiting for
   * `online` avoids a pointless failed REST request on a dead network.
   */
  tryWakeRefresh() {
    if (!this.needWakeRefresh || !this.running) return;
    if (this.state !== 'online') return;
    this.needWakeRefresh = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.refreshAfterWake();
  }

  /**
   * Refetch the latest page for visible panes that are at the bottom. This
   * closes the gap when a fresh READY replaced an expired gateway session.
   * Panes the user scrolled up in are left alone.
   */
  async refreshAfterWake(attempt = 0, onlyIds = null) {
    if (!this.running) return;
    const ids = onlyIds || [...new Set(this.paneIds())];
    let refreshed = 0;
    const failed = [];
    for (const id of ids) {
      const cache = this.chats.get(String(id));
      if (!cache || cache.loading || (cache.scroll || 0) > 0) continue;
      // Quiet: a failed attempt is retried below, so do not flash a 502 toast
      // or replace the pane with an error banner.
      const loaded = await this.loadMessages(id, { force: true, quiet: true });
      if (!this.running) return;
      if (!loaded) {
        failed.push(String(id));
        continue;
      }
      // Do not mark anything read while the terminal is in the background;
      // the unread count and bell must survive until the user comes back.
      if (this.focused && this.paneIds().includes(String(id)) && (cache.scroll || 0) === 0) {
        const previousRead = this.readStates.get(String(id))?.lastMessageId || '';
        const last = cache.items[cache.items.length - 1]?.id || '';
        this.ackVisibleChannel(id, Boolean(last && (!previousRead || asBig(last) > asBig(previousRead))));
      }
      refreshed += 1;
    }

    if (failed.length && attempt < WAKE_REFRESH_RETRY_DELAYS.length) {
      const delay = WAKE_REFRESH_RETRY_DELAYS[attempt];
      this.debug?.(`wake refresh failed for ${failed.join(',')}; retry in ${delay}ms`);
      this.needWakeRefresh = true;
      if (this.wakeTimer) clearTimeout(this.wakeTimer);
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        if (!this.running) return;
        // Leave the flag set; onState('online') will run the refresh.
        if (this.state !== 'online') return;
        this.needWakeRefresh = false;
        this.refreshAfterWake(attempt + 1, failed);
      }, delay);
      this.wakeTimer.unref?.();
      this.draw();
      return;
    }

    this.needWakeRefresh = false;
    if (failed.length) {
      this.toast('could not refresh messages. press ctrl+r to retry', 'error');
    } else if (refreshed) {
      this.toast('connection restored; view refreshed', 'ok');
    }
    this.draw();
  }

  /**
   * Write an OSC/control sequence to the real terminal. The screen object owns
   * the frame; the title and bell are side channels and are skipped when the
   * output is not a TTY (tests, `--dump`) so no escape codes leak into pipes.
   */
  writeTerminal(sequence) {
    const out = this.out;
    if (!out?.isTTY || typeof out.write !== 'function') return;
    out.write(sequence);
  }

  /** `ttycord !2` in the terminal title: mentions only, not every unread line. */
  updateTitle() {
    let mentions = 0;
    for (const entry of this.unread.values()) {
      mentions += Number(entry.mentions) || 0;
    }
    const title = mentions ? `ttycord !${mentions}` : 'ttycord';
    if (title === this.title) return;
    this.title = title;
    this.writeTerminal(`\x1b]0;${title}\x07`);
  }

  /**
   * Effective notification level for a channel: `all`, `mention` or `off`.
   *
   * Discord's own setting wins so muting a channel (or setting it to mentions
   * only) is respected. `TTYCORD_BELL=off` is a master mute and `all` forces
   * every channel, otherwise unknown settings fall back to `mention`.
   */
  notificationLevel(channelId) {
    if (this.bellMode === 'off') return 'off';
    if (this.bellMode === 'all') return 'all';

    const id = String(channelId ?? '');
    const channel = id ? this.client.channel(id) : null;
    // Unknown channels (e.g. a live event before hydration) must not inherit
    // the DM settings by accident.
    if (!channel) return this.bellMode;
    const guildId = channel.guild_id ? String(channel.guild_id) : '';
    const group = this.guildSettings.get(guildId) || null;
    if (!group) return this.bellMode;

    const override = group.channels.get(id) || null;
    if (override?.muted ?? group.muted) return 'off';
    const level = override && override.level !== 3 ? override.level : group.level;
    if (level === 0) return 'all';
    if (level === 1) return 'mention';
    if (level === 2) return 'off';
    return this.bellMode;
  }

  /** Play the notification sound for activity the user cannot already see. */
  maybeBell({ mention, channelId }) {
    const level = this.notificationLevel(channelId);
    if (level === 'off') return;
    if (level === 'mention' && !mention) return;
    const now = Date.now();
    if (now - this.lastBellAt < BELL_COOLDOWN) return;
    this.lastBellAt = now;
    // The system sound is preferred; a terminal bell is only the fallback.
    if (this.sound() === 'bell') this.writeTerminal('\x07');
  }

  draw() {
    if (!this.running) return;
    const screen = this.screen;
    screen.setCaret(null);
    screen.clear(T.screen);
    this.geo = this.computeGeometry();

    drawTopBar(this);
    drawRail(this);
    drawSidebar(this);
    for (const pane of this.paneViews()) {
      drawChatHeader(this, pane);
      drawMessages(this, pane);
      drawTyping(this, pane);
      drawComposer(this, pane);
    }
    drawPaneDividers(this);
    // `messagesView` stays the focused column so the existing scroll/link
    // helpers keep their meaning.
    this.messagesView = this.messagesViews[this.activePaneIndex()] || null;
    drawMessageMenu(this);
    drawMentionMenu(this);
    drawStatus(this);
    drawToasts(this);
    if (this.help) drawHelp(this);
    drawSelection(this);
    screen.flush();
    this.updateTitle();
  }

  toast(text, kind = 'info') {
    this.toasts.push({ text: String(text), kind, until: Date.now() + TOAST_MS });
    if (this.toasts.length > 6) this.toasts.shift();
    this.draw();
  }

  // ------------------------------------------------------------------- input
  attachInput() {
    if (!this.input) return;
    this.input.on('key', (key) => this.handleKey(key));
    this.input.on('text', (text) => this.handleText(text));
    this.input.on('paste', (text) => this.handlePaste(text));
    this.input.on('mouse', (mouse) => this.handleMouse(mouse));
    this.input.on('focus', () => this.onFocus());
    this.input.on('blur', () => this.onBlur());
  }

  handlePaste(text) {
    this.cancelRawDrop();
    if (this.help) {
      this.help = false;
      this.draw();
    }
    // A file manager drop arrives as pasted paths (or file:// URIs). Only
    // intercept the paste when the whole paste is paths; multiline prose that
    // merely mentions a path (a stack trace, a log) stays ordinary text.
    // Drops work even when the composer is not focused.
    const parsed = parseAttachmentText(text);
    if ((parsed.files.length || parsed.rejected.length) && looksLikeFileDrop(text)) {
      this.stageAttachments(parsed);
      return;
    }
    if (this.focus !== 'composer') return;
    // Keep line breaks now that the composer is multiline; normalize CRLF so
    // the draft only ever contains `\n`.
    this.insertText(String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' '));
  }

  /**
   * Ctrl+V: attach whatever the system clipboard holds.
   *
   * Terminals never forward clipboard images through bracketed paste, so read
   * the clipboard through the desktop helper instead of waiting for a paste
   * event. An image is written to a temp PNG and staged like a dragged file,
   * copied files attach by path, and plain text falls back to a normal paste.
   */
  async pasteClipboard() {
    if (this.clipboardBusy) return;
    this.clipboardBusy = true;
    try {
      const result = await this.paste();
      if (result?.kind === 'image' && result.path) {
        this.clipboardFiles.add(result.path);
        this.stageAttachments({
          files: [
            {
              path: result.path,
              name: result.name || 'clipboard.png',
              size: result.size || 0,
              contentType: result.contentType || 'image/png',
            },
          ],
        });
        return;
      }
      if (result?.kind === 'files' && result.uris?.length) {
        const parsed = parseAttachmentText(result.uris.join('\n'));
        if (parsed.files.length || parsed.rejected.length) {
          this.stageAttachments(parsed);
          return;
        }
        this.toast('could not attach the clipboard files', 'error');
        return;
      }
      if (result?.kind === 'text' && result.text) {
        const text = String(result.text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
        // Copying a path as text is a common way to attach a file.
        const parsed = parseAttachmentText(text);
        if (parsed.files.length && !parsed.rejected.length && looksLikeFileDrop(text)) {
          this.stageAttachments(parsed);
          return;
        }
        this.focus = 'composer';
        this.insertText(text);
        this.draw();
        return;
      }
      this.toast('no image or file on the clipboard', 'error');
    } catch (error) {
      this.toast(`clipboard read failed: ${error.message}`, 'error');
    } finally {
      this.clipboardBusy = false;
    }
  }

  /** Clipboard images are temp files; delete them once they are sent. */
  releaseClipboardFiles(files = []) {
    for (const file of files) {
      const filePath = typeof file === 'string' ? file : file?.path;
      if (!filePath || !this.clipboardFiles.has(filePath)) continue;
      this.clipboardFiles.delete(filePath);
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* best effort: the cache sweep removes stragglers */
      }
    }
  }

  cancelRawDrop() {
    if (this.rawDropTimer) clearTimeout(this.rawDropTimer);
    this.rawDropTimer = null;
    this.rawDropBuffer = '';
    this.rawDropLastAt = 0;
    this.rawDropMaxGap = 0;
    this.rawDropProbe = false;
  }

  /** Accumulate a possible raw file drop; decide when the burst goes quiet. */
  queueRawDrop(text) {
    const now = Date.now();
    if (!this.rawDropBuffer) {
      this.rawDropMaxGap = 0;
    } else {
      this.rawDropMaxGap = Math.max(this.rawDropMaxGap, now - this.rawDropLastAt);
    }
    this.rawDropLastAt = now;
    this.rawDropBuffer += text;
    // A leading `f` might be the start of `file://`. Keep it only while the
    // buffer still matches that prefix; ordinary words flush immediately.
    if (this.rawDropProbe) {
      const lower = this.rawDropBuffer.toLowerCase();
      if (lower.startsWith('file:/')) {
        this.rawDropProbe = false;
      } else if (!'file:'.startsWith(lower)) {
        this.flushRawDrop();
        return;
      }
    }
    if (this.rawDropTimer) clearTimeout(this.rawDropTimer);
    this.rawDropTimer = setTimeout(() => this.flushRawDrop(), RAW_DROP_MS);
    this.rawDropTimer.unref?.();
  }

  /** Try the literal text, then the `file://` form of a URI pasted raw. */
  parseRawDrop(text) {
    const direct = parseAttachmentText(text);
    if (direct.files.length) return direct;
    // Buffering starts at the first slash, so a raw `file:///x` arrives as
    // `///x`. Put the scheme back so percent-encoded names decode correctly.
    if (/^\s*\/{2,}/m.test(text)) {
      const rebuilt = text.replace(
        /(^|\n)(\s*)(\/{2,})/g,
        (_match, newline, space, slashes) => `${newline}${space}file:${slashes}`,
      );
      if (rebuilt !== text) {
        const parsed = parseAttachmentText(rebuilt);
        if (parsed.files.length) return parsed;
      }
    }
    return direct;
  }

  /**
   * Finish a raw drop burst. Existing files are always staged (so a typed
   * absolute path is a shortcut too); a missing path is only treated as a drop
   * when it arrived as a fast burst and looks like a real path, never like
   * `/help` typed into the composer.
   */
  flushRawDrop() {
    if (this.rawDropTimer) clearTimeout(this.rawDropTimer);
    this.rawDropTimer = null;
    const text = this.rawDropBuffer;
    const maxGap = this.rawDropMaxGap;
    this.rawDropBuffer = '';
    this.rawDropLastAt = 0;
    this.rawDropMaxGap = 0;
    this.rawDropProbe = false;
    if (!text) return false;

    const parsed = this.parseRawDrop(text);
    const fastBurst = maxGap <= RAW_DROP_MAX_GAP_MS;
    const strongShape = hasStrongPathShape(text);
    if (
      parsed.files.length ||
      (fastBurst && strongShape && parsed.rejected.length && text.length >= RAW_DROP_MIN_CHARS)
    ) {
      this.stageAttachments(parsed);
      return true;
    }
    this.applyText(text);
    return false;
  }

  /** Add parsed drag-and-drop files to the current channel's composer. */
  stageAttachments({ files = [], rejected = [] } = {}, { silent = false } = {}) {
    const channel = this.currentChannel();
    if (!channel) {
      this.toast('select a channel first', 'error');
      return;
    }
    const cache = this.chat(channel.id);
    let added = 0;
    for (const file of files) {
      if (cache.attachments.some((item) => item.path === file.path)) continue;
      if (cache.attachments.length >= MAX_ATTACHMENTS) {
        this.toast(`up to ${MAX_ATTACHMENTS} attachments per message`, 'error');
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        this.toast(
          `${file.name}: too large (${formatBytes(file.size)} / max ${formatBytes(MAX_ATTACHMENT_BYTES)})`,
          'error',
        );
        continue;
      }
      cache.attachments.push(file);
      added += 1;
    }
    for (const item of rejected.slice(0, 2)) {
      const reason = item.reason === 'directory' ? 'folders cannot be attached' : 'file not found';
      this.toast(`${item.name}: ${reason}`, 'error');
    }
    if (added) {
      this.focus = 'composer';
      if (!silent) {
        this.toast(
          `attached ${added} (${cache.attachments.length}/${MAX_ATTACHMENTS})`,
          'ok',
        );
      }
    }
    this.draw();
  }

  /** Ctrl+X in the composer removes the most recently staged file. */
  removeLastAttachment() {
    const cache = this.currentChat();
    if (!cache) return;
    const removed = cache.attachments.pop();
    if (!removed) return;
    this.releaseClipboardFiles([removed]);
    this.toast(`removed attachment: ${removed.name}`);
    this.draw();
  }

  handleText(text) {
    if (this.help) {
      this.help = false;
      this.draw();
      return;
    }
    if (this.reactMode) {
      this.handleReactText(text);
      return;
    }
    if (this.messageMenu) {
      this.messageMenu = null;
      this.draw();
    }
    // A terminal that does not bracket-paste a file drop sends its path as a
    // burst of ordinary characters. Buffer path-shaped input so it can become
    // an attachment instead of triggering rail/sidebar shortcuts.
    if (this.rawDropBuffer || isPathStart(text)) {
      this.queueRawDrop(text);
      return;
    }
    // `file://` starts with a letter; probe it without delaying other words.
    if (text.toLowerCase() === 'f') {
      this.rawDropProbe = true;
      this.queueRawDrop(text);
      return;
    }
    if (this.focus === 'messages') {
      this.handleMessageText(text);
      return;
    }
    this.applyText(text);
  }

  /** Apply text after it has been ruled out as a raw file drop. */
  applyText(text) {
    if (this.focus === 'composer') {
      this.insertText(text);
      return;
    }
    if (text === '?') {
      this.help = true;
      this.draw();
      return;
    }
    switch (text) {
      case ' ':
        this.toggleFocusedGroup();
        break;
      case 'j':
        this.moveSelection(1);
        break;
      case 'k':
        this.moveSelection(-1);
        break;
      case 'h':
        this.moveFocus(-1);
        break;
      case 'l':
        this.moveFocus(1);
        break;
      case 'g':
        this.jumpSelection(0);
        break;
      case 'G':
        this.jumpSelection(-1);
        break;
      case 'i':
        this.toggleImages();
        break;
      case 'm':
        // Keyboard entry into message mode; clicking a message does the same.
        this.enterMessageMode();
        break;
      case 's':
        this.toggleSplit();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        if (this.splitMode) this.focusPane(Number(text) - 1);
        break;
      case 'z':
        this.wide = !this.wide;
        this.invalidateLayouts();
        this.draw();
        break;
      default:
        break;
    }
  }

  handleKey(key) {
    // A raw drop burst may end with Enter/backspace. Settle it first so the
    // path is not left half-buffered or lost, and do not let the terminal's
    // trailing newline immediately send the freshly staged attachment.
    if (this.rawDropBuffer) {
      const wasDrop = this.flushRawDrop();
      if (wasDrop && key.key === 'enter') return;
    }
    if (key.ctrl && key.key === 'c') {
      // Ctrl+C copies the current mouse selection. Without a selection the
      // first press arms quitting and the second (within the window) exits.
      if (this.selection) {
        this.quitArmedAt = Date.now();
        this.copySelection();
        return;
      }
      const now = Date.now();
      if (now - this.quitArmedAt < QUIT_CONFIRM_MS) {
        this.quit();
        return;
      }
      this.quitArmedAt = now;
      this.toast('press ctrl+c again to quit');
      return;
    }
    if (key.key === 'escape' && this.selection) {
      this.selection = null;
      this.draw();
      return;
    }
    if (this.help) {
      this.help = false;
      this.draw();
      return;
    }
    if (this.messageMenu) {
      if (key.key === 'escape') {
        this.closeMessageMenu();
        return;
      }
      // Any other key dismisses the popup and then acts normally.
      this.messageMenu = null;
    }
    // Ctrl+V reads the system clipboard directly. Terminals only forward text
    // through bracketed paste, so a copied screenshot would otherwise be
    // invisible to the app; this also handles copied files and plain text.
    if (key.ctrl && key.key === 'v' && !key.alt) {
      this.pasteClipboard();
      return;
    }
    if (this.reactMode) {
      this.handleReactKey(key);
      return;
    }
    // Split-view keys work from any focus: closing a column or stepping
    // between columns should not require leaving the composer first.
    if (this.splitMode) {
      if (key.ctrl && key.key === 'w') {
        this.closePane();
        return;
      }
      if (key.ctrl && (key.key === 'left' || key.key === 'right')) {
        const count = this.paneIds().length;
        if (count > 1) {
          const step = key.key === 'left' ? -1 : 1;
          this.focusPane((this.activePaneIndex() + step + count) % count);
          return;
        }
      }
    }
    if (this.focus === 'messages') {
      this.handleMessageKey(key);
      return;
    }
    // The mention menu owns Enter/Tab/arrows/Escape while it is open. It is
    // recomputed from the draft, so it only exists while the cursor sits in an
    // `@name` or `#channel` token.
    if (this.focus === 'composer') {
      const mention = this.mentionState();
      if (mention) {
        const plainEnter = key.key === 'enter' && !key.ctrl && !key.alt && !key.shift;
        if ((key.key === 'tab' && !key.shift) || plainEnter) {
          this.acceptMention();
          return;
        }
        if (key.key === 'escape') {
          this.mentionMuted = true;
          this.draw();
          return;
        }
        if (key.key === 'up' || key.key === 'down') {
          this.moveMention(key.key === 'up' ? -1 : 1);
          return;
        }
      }
    }
    if (key.key === 'tab') {
      this.moveFocus(key.shift ? -1 : 1);
      return;
    }
    if (this.focus === 'composer') {
      this.handleComposerKey(key);
      return;
    }
    this.handleListKey(key);
  }

  handleComposerKey(key) {
    const cache = this.currentChat();
    if (!cache) return;
    switch (key.key) {
      case 'enter':
        // Plain Enter sends. Ctrl+Enter, Alt+Enter, Shift+Enter and Ctrl+J
        // insert a line break instead.
        if (key.ctrl || key.alt || key.shift) this.insertText('\n');
        else this.sendDraft();
        break;
      case 'backspace':
        this.deleteBeforeCursor();
        break;
      case 'delete':
        this.deleteAtCursor();
        break;
      case 'left':
        cache.cursor = Math.max(0, cache.cursor - 1);
        this.resetMention();
        this.draw();
        break;
      case 'right':
        cache.cursor = Math.min(graphemes(cache.draft).length, cache.cursor + 1);
        this.resetMention();
        this.draw();
        break;
      case 'home':
        cache.cursor = 0;
        this.resetMention();
        this.draw();
        break;
      case 'end':
        cache.cursor = graphemes(cache.draft).length;
        this.resetMention();
        this.draw();
        break;
      case 'up':
        if (!this.moveComposerVertical(-1)) this.browseHistory(-1);
        break;
      case 'down':
        if (!this.moveComposerVertical(1)) this.browseHistory(1);
        break;
      case 'pageup':
        this.scrollMessages(PAGE, true);
        break;
      case 'pagedown':
        this.scrollMessages(-PAGE, true);
        break;
      case 'escape':
        if (this.cancelComposerMode()) break;
        this.focus = 'sidebar';
        this.draw();
        break;
      case 'j':
        // Some terminals report Ctrl+J as a modified 'j' instead of LF when
        // modifyOtherKeys is enabled.
        if (key.ctrl) this.insertText('\n');
        break;
      case 'r':
        if (key.ctrl) this.reloadMessages();
        break;
      case 'u':
        if (key.ctrl) {
          cache.draft = '';
          cache.cursor = 0;
          this.resetMention();
          this.draw();
        }
        break;
      case 'x':
        if (key.ctrl) this.removeLastAttachment();
        break;
      default:
        break;
    }
  }

  handleListKey(key) {
    switch (key.key) {
      case 'up':
        this.moveSelection(-1);
        break;
      case 'down':
        this.moveSelection(1);
        break;
      case 'left':
        this.moveFocus(-1);
        break;
      case 'right':
        this.moveFocus(1);
        break;
      case 'enter':
        this.activateSelection();
        break;
      case 'escape':
        this.focus = this.currentChannel() ? 'composer' : 'sidebar';
        this.draw();
        break;
      case 'pageup':
        this.scrollMessages(PAGE, true);
        break;
      case 'pagedown':
        this.scrollMessages(-PAGE, true);
        break;
      case 'home':
        this.jumpSelection(0);
        break;
      case 'end':
        this.jumpSelection(-1);
        break;
      case 'r':
        if (key.ctrl) this.reloadMessages();
        break;
      default:
        break;
    }
  }

  handleMouse(mouse) {
    if (mouse.wheel) {
      // A popup anchored to a row would point at different text after a scroll.
      if (this.messageMenu) this.closeMessageMenu({ draw: false });
      // The selected cells would point at different text after scrolling.
      if (this.selection) {
        this.selection = null;
        this.draw();
      }
      const pane = this.paneAt(mouse);
      if (pane && this.pointIn(mouse, pane.rect.messages)) {
        if (pane.index !== this.activePaneIndex()) this.focusPane(pane.index);
        this.scrollMessages(mouse.wheel === 'up' ? 3 : -3, false);
      } else if (this.pointIn(mouse, this.geo.sidebar)) {
        this.focus = 'sidebar';
        this.moveSelection(mouse.wheel === 'up' ? -1 : 1);
      } else if (this.pointIn(mouse, this.geo.rail)) {
        this.focus = 'rail';
        this.moveSelection(mouse.wheel === 'up' ? -1 : 1);
      }
      return;
    }

    if (mouse.motion) {
      const sel = this.selection;
      if (!sel || mouse.button !== 0) return;
      sel.fx = clamp(mouse.x, 0, this.screen.cols - 1);
      sel.fy = clamp(mouse.y, 0, this.screen.rows - 1);
      if (sel.fx !== sel.ax || sel.fy !== sel.ay) sel.dragging = true;
      this.draw();
      return;
    }

    if (mouse.action === 'release') {
      const sel = this.selection;
      if (!sel) return;
      if (mouse.button !== 0) {
        this.selection = null;
        this.draw();
        return;
      }
      if (sel.dragging) {
        // Keep the highlight so Ctrl+C can copy it. The final release position
        // may be newer than the last motion event.
        sel.fx = clamp(mouse.x, 0, this.screen.cols - 1);
        sel.fy = clamp(mouse.y, 0, this.screen.rows - 1);
        this.draw();
        return;
      }
      // A press and release on the same cell is a click, not a selection.
      this.selection = null;
      this.draw();
      this.handleClick(mouse);
      return;
    }

    if (mouse.action !== 'press') return;
    if (mouse.button !== 0) {
      if (this.selection) {
        this.selection = null;
        this.draw();
      }
      return;
    }
    if (this.messageMenu && !this.pointIn(mouse, this.messageMenu)) {
      this.closeMessageMenu({ draw: false });
    }
    // Mouse reporting is on, so the terminal will not select text for us.
    // Start our own selection; a plain click is resolved on release.
    this.selection = {
      ax: clamp(mouse.x, 0, this.screen.cols - 1),
      ay: clamp(mouse.y, 0, this.screen.rows - 1),
      fx: clamp(mouse.x, 0, this.screen.cols - 1),
      fy: clamp(mouse.y, 0, this.screen.rows - 1),
      dragging: false,
    };
  }

  /** Resolve a left click after a press/release that did not drag. */
  handleClick(mouse) {
    // The mention dropdown floats over the message pane, so it must be hit
    // tested before the panes underneath it.
    const menu = this.mentionMenu;
    if (menu && this.pointIn(mouse, menu)) {
      const row = menu.rows.indexOf(mouse.y);
      if (row >= 0) {
        this.mentionIndex = menu.offset + row;
        this.acceptMention();
      }
      return;
    }

    // The message action popup floats above a pane, so it is hit tested before
    // the pane underneath. A click outside dismisses it and still acts.
    const popup = this.messageMenu;
    if (popup) {
      if (this.pointIn(mouse, popup)) {
        const row = popup.rows?.indexOf(mouse.y) ?? -1;
        const item = row >= 0 ? popup.items[row] : null;
        if (item) this.activateMessageMenu(item);
        return;
      }
      this.closeMessageMenu({ draw: false });
    }

    // Split panes come next: a click anywhere in a column focuses it, and the
    // composer / message log inside it act on that column only.
    const pane = this.paneAt(mouse);
    if (pane) {
      if (pane.index !== this.activePaneIndex()) this.focusPane(pane.index);
      if (this.pointIn(mouse, pane.rect.composer)) {
        if (pane.channel) {
          this.focus = 'composer';
          this.draw();
        }
        return;
      }
      if (this.pointIn(mouse, pane.rect.messages)) {
        if (mouse.button === 0) {
          // Images and `[img]` labels keep their click-to-open behaviour; any
          // other row selects the message for the action keys.
          const link = messageLinkAt(this.messagesViews[pane.index] || null, mouse.y);
          if (link) {
            this.openUrl(link);
            return;
          }
          const message = this.messageAt(mouse.y, pane.index);
          if (message) {
            this.openMessageMenu(message, { x: mouse.x, y: mouse.y, paneIndex: pane.index });
          }
        }
        return;
      }
      // Header, typing line or the column padding: focusing is the whole click.
      return;
    }

    if (this.pointIn(mouse, this.geo.rail)) {
      if (mouse.button !== 0) return;
      this.focus = 'rail';
      const rows = railRows(this);
      const index = railHitIndex(mouse.y, this.geo.rail, this.railOffset, Math.max(0, rows.length - 1));
      if (index === null) return;
      const row = rows[index];
      // A click should open what it points at; folder headers toggle instead.
      if (!row || row.kind === 'dm') this.selectDmHome();
      else if (row.kind === 'folder') this.toggleFolder(row.key);
      else this.selectGuild(row.guild.id, { focus: true });
      return;
    }

    if (this.pointIn(mouse, this.geo.sidebar)) {
      if (mouse.button !== 0) return;
      const index = sidebarHitIndex(mouse.y, this.geo.sidebar, this.sideOffset);
      if (index === null) return;
      const item = this.sideItems[index];
      if (item?.kind === 'category') {
        this.toggleCategory(item.channel.id);
        return;
      }
      if (item?.kind === 'channel') {
        this.focus = 'sidebar';
        this.openChannel(item.channel.id, { focus: false });
      }
    }
  }

  /** Ctrl+C with a selection: copy it, clear the highlight and toast. */
  /** Pane rect containing the drag anchor; keeps line selection pane-local. */
  selectionBounds() {
    const sel = this.selection;
    if (!sel) return null;
    const geo = this.geo;
    const regions = [];
    // Inner regions first, so a drag that starts in the message log is bounded
    // by that log rather than by the whole column.
    for (const pane of geo.panes || []) {
      regions.push(pane.messages, pane.composer, pane.header, pane.typing);
    }
    for (const pane of geo.panes || []) regions.push(pane.chat);
    regions.push(geo.sidebar, geo.rail, geo.topbar, geo.status, geo.chat);
    for (const rect of regions) {
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const inside =
        sel.ax >= rect.x &&
        sel.ax < rect.x + rect.width &&
        sel.ay >= rect.y &&
        sel.ay < rect.y + rect.height;
      if (inside) {
        return {
          left: rect.x,
          right: rect.x + rect.width - 1,
          top: rect.y,
          bottom: rect.y + rect.height - 1,
        };
      }
    }
    return { left: 0, right: this.screen.cols - 1, top: 0, bottom: this.screen.rows - 1 };
  }

  async copySelection() {
    const text = selectionText(this.screen, this.selection, this.selectionBounds());
    this.selection = null;
    this.draw();
    if (!text) return;
    let method = '';
    try {
      method = await this.copy(text, { out: this.out });
    } catch (error) {
      this.toast(`copy failed: ${error.message}`, 'error');
      return;
    }
    const how = method === 'osc52' ? 'OSC52' : method === 'gtk' ? 'GTK' : 'clipboard';
    this.toast(`copied ${text.length} chars (${how})`);
  }


  /** Open the attachment URL under `y` in pane `index`'s message log. */
  openMessageLink(y, index = this.activePaneIndex()) {
    const link = messageLinkAt(this.messagesViews[index] || null, y);
    if (link) this.openUrl(link);
  }

  // ---------------------------------------------------------- message cursor
  /** Message under a screen row in a pane, if any. */
  messageAt(y, index = this.activePaneIndex()) {
    const view = this.messagesViews[index];
    const cache = this.chats.get(String(this.paneIds()[index] || ''));
    if (!view?.spans || !cache) return null;
    const row = view.start + (y - view.y0);
    if (row < view.start || row >= view.start + view.height) return null;
    const span = view.spans.find((entry) => row >= entry.start && row < entry.end);
    return span ? cache.byId.get(String(span.id)) || null : null;
  }

  /** Enter message mode; `id` defaults to the previous cursor or the newest. */
  enterMessageMode(id = null) {
    const cache = this.currentChat();
    if (!cache) return;
    if (!cache.items.length) {
      this.toast('no messages');
      return;
    }
    const wanted = String(id || cache.cursorId || cache.items[cache.items.length - 1].id);
    cache.cursorId = cache.byId.has(wanted) ? wanted : cache.items[cache.items.length - 1].id;
    this.focus = 'messages';
    this.reactMode = null;
    this.selection = null;
    this.ensureCursorVisible();
    this.draw();
  }

  selectedMessage() {
    const cache = this.currentChat();
    if (!cache || !cache.cursorId) return null;
    return cache.byId.get(String(cache.cursorId)) || null;
  }

  /** Items shown by the click popup; edit/delete only for our own messages. */
  messageMenuItems(message) {
    const mine = String(message?.author?.id) === this.myId;
    const items = [
      { key: 'react', label: 'react', hint: 'r' },
      { key: 'reply', label: 'reply', hint: 'R' },
    ];
    if (mine) {
      items.push({ key: 'edit', label: 'edit', hint: 'e' });
      items.push({ key: 'delete', label: 'delete', hint: 'd' });
    }
    items.push({ key: 'copy', label: 'copy link', hint: 'y' });
    return items;
  }

  /** Open the click popup for `message`, anchored at the clicked cell. */
  openMessageMenu(message, { x = 0, y = 0, paneIndex = this.activePaneIndex() } = {}) {
    const cache = this.currentChat();
    if (!cache || !message) return;
    cache.cursorId = String(message.id);
    this.focus = 'messages';
    this.reactMode = null;
    this.selection = null;
    this.messageMenu = {
      messageId: String(message.id),
      paneIndex,
      px: x,
      py: y,
      confirmDelete: false,
      items: this.messageMenuItems(message),
    };
    this.ensureCursorVisible();
    this.draw();
  }

  closeMessageMenu({ draw = true } = {}) {
    if (!this.messageMenu) return;
    this.messageMenu = null;
    if (draw) this.draw();
  }

  /** Run the popup item that was clicked. */
  activateMessageMenu(item) {
    const menu = this.messageMenu;
    const cache = this.currentChat();
    const message = cache?.byId.get(String(menu?.messageId || ''));
    if (!menu || !message) {
      this.closeMessageMenu();
      return;
    }

    if (item.key === 'react') {
      this.closeMessageMenu({ draw: false });
      this.openReactMode();
      return;
    }
    if (item.key === 'reply') {
      this.closeMessageMenu({ draw: false });
      this.replyToSelected();
      return;
    }
    if (item.key === 'edit') {
      this.closeMessageMenu({ draw: false });
      this.editSelected();
      return;
    }
    if (item.key === 'copy') {
      this.closeMessageMenu({ draw: false });
      this.copySelectedLink();
      return;
    }
    if (item.key === 'delete') {
      if (String(message.author?.id) !== this.myId) {
        this.toast('you can only delete your own messages', 'error');
        return;
      }
      const now = Date.now();
      const armed = this.deleteArmed;
      if (armed?.id === message.id && now - armed.at < 3_000) {
        this.deleteArmed = null;
        this.closeMessageMenu({ draw: false });
        this.deleteMessage(message);
        return;
      }
      this.deleteArmed = { id: message.id, at: now };
      menu.confirmDelete = true;
      const target = menu.items.find((entry) => entry.key === 'delete');
      if (target) target.label = 'confirm delete';
      this.toast('click again to delete', 'error');
    }
  }

  /** Move the message cursor by `delta`, clamped to the loaded history. */
  moveMessageCursor(delta) {
    const cache = this.currentChat();
    if (!cache || !cache.items.length) return;
    if (!cache.cursorId) {
      this.enterMessageMode();
      return;
    }
    const index = cache.items.findIndex((message) => message.id === String(cache.cursorId));
    const next = clamp(
      index < 0 ? cache.items.length - 1 : index + delta,
      0,
      cache.items.length - 1,
    );
    cache.cursorId = cache.items[next].id;
    this.ensureCursorVisible();
    this.draw();
  }

  jumpMessageCursor(toEnd) {
    const cache = this.currentChat();
    if (!cache || !cache.items.length) return;
    cache.cursorId = (toEnd ? cache.items[cache.items.length - 1] : cache.items[0]).id;
    this.ensureCursorVisible();
    this.draw();
  }

  /** Scroll the pane just enough to show the cursor's rows. */
  ensureCursorVisible() {
    const cache = this.currentChat();
    const view = this.messagesViews[this.activePaneIndex()];
    if (!cache || !view?.spans || !cache.cursorId) return;
    const span = view.spans.find((entry) => entry.id === String(cache.cursorId));
    if (!span) return;
    const top = view.start;
    const bottom = view.start + view.height - 1;
    if (span.start < top) {
      cache.scroll = Math.min(view.maxScroll, (cache.scroll || 0) + (top - span.start));
    } else if (span.end - 1 > bottom) {
      cache.scroll = Math.max(0, (cache.scroll || 0) - (span.end - 1 - bottom));
    }
  }

  handleMessageKey(key) {
    const plain = (name) => key.key === name || key.key === name.toUpperCase();
    switch (key.key) {
      case 'j':
      case 'down':
        this.moveMessageCursor(1);
        break;
      case 'k':
      case 'up':
        this.moveMessageCursor(-1);
        break;
      case 'g':
        this.jumpMessageCursor(false);
        break;
      case 'G':
        this.jumpMessageCursor(true);
        break;
      case 'enter':
        this.openReactMode();
        break;
      case 'r':
        if (key.ctrl) this.reloadMessages();
        else if (key.shift) this.replyToSelected();
        else this.openReactMode();
        break;
      case 'tab':
        this.focus = 'composer';
        this.draw();
        break;
      case 'escape':
        this.focus = 'composer';
        this.draw();
        break;
      default:
        if (plain('e') && !key.ctrl) this.editSelected();
        else if (plain('d') && !key.ctrl) this.deleteSelected();
        else if (plain('y') && !key.ctrl) this.copySelectedLink();
        break;
    }
  }

  handleMessageText(text) {
    switch (text) {
      case 'j':
        this.moveMessageCursor(1);
        break;
      case 'k':
        this.moveMessageCursor(-1);
        break;
      case 'g':
        this.jumpMessageCursor(false);
        break;
      case 'G':
        this.jumpMessageCursor(true);
        break;
      case 'r':
        this.openReactMode();
        break;
      case 'R':
        this.replyToSelected();
        break;
      case 'e':
        this.editSelected();
        break;
      case 'd':
        this.deleteSelected();
        break;
      case 'y':
        this.copySelectedLink();
        break;
      default:
        // i / s / z / ? and friends stay global while the cursor is on a message.
        this.applyText(text);
        break;
    }
  }

  // ---------------------------------------------------------------- reactions
  openReactMode() {
    const message = this.selectedMessage();
    if (!message) return;
    this.reactMode = { messageId: message.id, buffer: '' };
    this.draw();
  }

  handleReactText(text) {
    const mode = this.reactMode;
    if (!mode) return;
    // A digit is the quick bar; anything else starts a shortcode/emoji.
    if (/^[1-8]$/.test(text) && !mode.buffer) {
      this.reactMode = null;
      this.reactWith(mode.messageId, reactionChoice(Number(text) - 1));
      return;
    }
    if (mode.buffer.length < 24) mode.buffer += text;
    this.draw();
  }

  handleReactKey(key) {
    const mode = this.reactMode;
    if (!mode) return;
    if (key.key === 'escape') {
      this.reactMode = null;
      this.draw();
      return;
    }
    if (key.key === 'backspace') {
      mode.buffer = mode.buffer.slice(0, -1);
      this.draw();
      return;
    }
    if (key.key === 'enter') {
      const emoji = mode.buffer ? resolveReaction(mode.buffer) : REACTION_CHOICES[0].emoji;
      if (!emoji) {
        this.toast('unknown emoji');
        return;
      }
      this.reactMode = null;
      this.reactWith(mode.messageId, emoji);
      return;
    }
    if (key.key === 'space') {
      this.handleReactText(' ');
      return;
    }
    if (/^[1-8]$/.test(key.key)) {
      this.reactMode = null;
      this.reactWith(mode.messageId, reactionChoice(Number(key.key) - 1));
    }
  }

  /** Toggle our reaction on a message, with an optimistic local update. */
  async reactWith(messageId, emoji) {
    const channel = this.currentChannel();
    if (!channel || !emoji) return;
    const cache = this.chat(channel.id);
    const message = cache.byId.get(String(messageId));
    if (!message) return;
    const key = reactionKey({ name: emoji });
    const existing = (message.reactions || []).find((entry) => reactionKey(entry.emoji) === key);
    const adding = !existing?.me;
    const emojiObject = { name: emoji };
    this.applyReactionLocal(cache, message, {
      type: adding ? 'add' : 'remove',
      userId: this.myId,
      emoji: emojiObject,
    });
    this.draw();
    try {
      if (adding) await this.client.addReaction(channel.id, message.id, emoji);
      else await this.client.removeReaction(channel.id, message.id, emoji);
      this.toast(adding ? `reacted ${emoji}` : `removed reaction ${emoji}`, 'ok');
    } catch (error) {
      this.applyReactionLocal(cache, message, {
        type: adding ? 'remove' : 'add',
        userId: this.myId,
        emoji: emojiObject,
      });
      this.toast(`reaction failed: ${error.message}`, 'error');
    }
  }

  /**
   * Apply a reaction add/remove locally. Shared by the gateway events and our
   * own optimistic updates so both paths keep identical `count`/`me` shape.
   */
  applyReactionLocal(cache, message, { type, userId, emoji }) {
    if (!cache || !message) return;
    const key = reactionKey(emoji);
    const mine = String(userId) === this.myId;
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    if (type === 'remove_all') {
      message.reactions = [];
    } else if (type === 'remove_emoji') {
      if (!key) return;
      message.reactions = reactions.filter((entry) => reactionKey(entry.emoji) !== key);
    } else {
      if (!key) return;
      const index = reactions.findIndex((entry) => reactionKey(entry.emoji) === key);
      if (type === 'add') {
        if (index < 0) {
          reactions.push({ emoji: { name: emoji.name, id: emoji.id || null }, count: 1, me: mine });
        } else {
          const reaction = reactions[index];
          // A replay after RESUME can repeat an add for the same user.
          if (mine && reaction.me) return;
          reaction.count = (Number(reaction.count) || 0) + 1;
          if (mine) reaction.me = true;
        }
      } else {
        if (index < 0) return;
        const reaction = reactions[index];
        reaction.count = Math.max(0, (Number(reaction.count) || 0) - 1);
        if (mine) reaction.me = false;
        if (!reaction.count) reactions.splice(index, 1);
      }
      message.reactions = reactions;
    }
    cache.version += 1;
    cache.layout = null;
  }

  // ------------------------------------------------------- reply / edit / delete
  replyToSelected() {
    const message = this.selectedMessage();
    if (!message) return;
    const cache = this.currentChat();
    cache.replyTo = message;
    cache.editingId = null;
    cache.editBackup = null;
    this.focus = 'composer';
    this.toast('replying (esc to cancel)');
  }

  editSelected() {
    const message = this.selectedMessage();
    if (!message) return;
    if (String(message.author?.id) !== this.myId) {
      this.toast('you can only edit your own messages', 'error');
      return;
    }
    const cache = this.currentChat();
    cache.editBackup = { draft: cache.draft, cursor: cache.cursor, replyTo: cache.replyTo };
    cache.editingId = message.id;
    cache.replyTo = null;
    cache.draft = message.content || '';
    cache.cursor = graphemes(cache.draft).length;
    this.resetMention();
    this.focus = 'composer';
    this.toast('editing message (esc to cancel)');
  }

  /** Cancel a pending reply or edit. Returns true when something was cleared. */
  cancelComposerMode() {
    const cache = this.currentChat();
    if (!cache) return false;
    if (cache.editingId) {
      const backup = cache.editBackup || { draft: '', cursor: 0, replyTo: null };
      cache.editingId = null;
      cache.editBackup = null;
      cache.draft = backup.draft || '';
      cache.cursor = clamp(backup.cursor || 0, 0, graphemes(cache.draft).length);
      cache.replyTo = backup.replyTo || null;
      this.resetMention();
      this.draw();
      return true;
    }
    if (cache.replyTo) {
      cache.replyTo = null;
      this.draw();
      return true;
    }
    return false;
  }

  deleteSelected() {
    const message = this.selectedMessage();
    if (!message) return;
    if (String(message.author?.id) !== this.myId) {
      this.toast('you can only delete your own messages', 'error');
      return;
    }
    const now = Date.now();
    if (this.deleteArmed?.id === message.id && now - this.deleteArmed.at < 3_000) {
      this.deleteArmed = null;
      this.deleteMessage(message);
      return;
    }
    this.deleteArmed = { id: message.id, at: now };
    this.toast('press d again to delete', 'error');
  }

  async deleteMessage(message) {
    const channel = this.currentChannel();
    if (!channel) return;
    const cache = this.chat(channel.id);
    cache.byId.delete(message.id);
    cache.items = cache.items.filter((item) => item.id !== message.id);
    if (cache.cursorId === message.id) cache.cursorId = null;
    cache.version += 1;
    cache.layout = null;
    this.draw();
    try {
      await this.client.deleteMessage(channel.id, message.id);
      this.toast('message deleted', 'ok');
    } catch (error) {
      this.toast(`delete failed: ${error.message}`, 'error');
      this.mergeMessages(cache, [message]);
    }
  }

  async copySelectedLink() {
    const message = this.selectedMessage();
    if (!message) return;
    const guildId = this.channelGuildId(this.currentChannel(), message.channel_id) || '@me';
    const url = `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;
    const method = await this.copy(url);
    this.toast(method ? `link copied (${method})` : 'could not copy the link', method ? 'ok' : 'error');
  }

  /**
   * Hand a URL to the desktop opener. Discord's CDN URLs are plain http(s);
   * anything else (javascript:, file:) is refused rather than passed on.
   */
  openUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      this.toast('cannot open that link', 'error');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.toast('cannot open that link', 'error');
      return;
    }
    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
    const args = process.platform === 'win32'
      ? ['/c', 'start', '', parsed.href]
      : [parsed.href];
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', (error) => this.toast(`could not open the link: ${error.message}`, 'error'));
      child.unref();
      this.toast('opening in the browser', 'ok');
    } catch (error) {
      this.toast(`could not open the link: ${error.message}`, 'error');
    }
  }

  pointIn(point, rect) {
    return (
      rect &&
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
    );
  }

  // ---------------------------------------------------------------- focusing
  focusOrder() {
    return this.geo.rail.width > 0 ? FOCUS_ORDER : FOCUS_ORDER.filter((name) => name !== 'rail');
  }

  moveFocus(delta) {
    const order = this.focusOrder();
    let index = order.indexOf(this.focus);
    if (index < 0) index = 0;
    index = (index + delta + order.length) % order.length;
    const next = order[index];
    if (next === 'composer' && !this.currentChannel()) {
      index = (index + (delta >= 0 ? 1 : -1) + order.length) % order.length;
    }
    this.focus = order[index];
    this.draw();
  }

  moveSelection(delta) {
    if (this.focus === 'rail') {
      const last = Math.max(0, railRows(this).length - 1);
      this.railIndex = clamp(this.railIndex + delta, 0, last);
      this.draw();
      return;
    }
    if (this.focus === 'sidebar') {
      const channels = selectableChannels(this);
      if (!channels.length) return;
      let index = channels.findIndex((channel) => channel.id === this.selectedChannelId);
      if (index < 0) index = 0;
      index = clamp(index + delta, 0, channels.length - 1);
      this.openChannel(channels[index].id, { focus: false });
    }
  }

  jumpSelection(which) {
    if (this.focus === 'rail') {
      this.railIndex = which === 0 ? 0 : Math.max(0, railRows(this).length - 1);
      this.draw();
      return;
    }
    const channels = selectableChannels(this);
    if (!channels.length) return;
    const channel = which === 0 ? channels[0] : channels[channels.length - 1];
    this.openChannel(channel.id, { focus: false });
  }

  activateSelection() {
    if (this.focus === 'rail') {
      const row = railRows(this)[this.railIndex];
      if (!row || row.kind === 'dm') {
        this.selectDmHome();
      } else if (row.kind === 'folder') {
        this.toggleFolder(row.key);
      } else {
        this.selectGuild(row.guild.id, { focus: true });
      }
      return;
    }
    if (this.focus === 'sidebar') {
      if (this.currentChannel()) {
        this.focus = 'composer';
        this.draw();
      }
      return;
    }
  }

  // -------------------------------------------------------------- bootstrap
  async bootstrap() {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    try {
      const [guilds, dms, order] = await Promise.allSettled([
        this.client.loadGuilds(),
        this.client.loadDms(),
        this.client.loadGuildFolders?.() ?? Promise.resolve({ folders: [], ids: [] }),
      ]);
      if (!this.running) return;
      if (guilds.status === 'fulfilled') this.applyGuilds(guilds.value);
      if (order.status === 'fulfilled') {
        this.folders = order.value?.folders || [];
        this.guildOrder = order.value?.ids || [];
        this.applyGuildOrder(this.guildOrder);
      }
      if (dms.status === 'fulfilled') this.applyDms(dms.value);
      if (guilds.status === 'rejected' && dms.status === 'rejected') {
        throw guilds.reason;
      }
      await this.bootstrapSelection();
    } catch (error) {
      this.toast(`could not load initial data: ${error.message}`, 'error');
    }
  }

  async bootstrapSelection() {
    if (!this.running || this.selecting) return;
    this.selecting = true;
    try {
      if (await this.restoreLastView()) return;
      if (this.guilds.length) {
        const guild = this.guilds[0];
        await this.selectGuild(guild.id, { focus: false });
        return;
      }
      if (this.dms.length) {
        this.selectedGuildId = null;
        this.railIndex = 0;
        await this.openChannel(this.dms[0].id, { focus: false });
        return;
      }
      this.selectedChannelId = null;
      this.draw();
    } finally {
      this.selecting = false;
    }
  }

  /**
   * Reopen the guild/channel or DM from the previous run. Returns false when
   * the saved target no longer exists, letting the normal fallback run.
   *
   * Split restore is deliberately lazy: the saved pane ids come back and the
   * focused pane is opened normally, but the other panes are not resolved or
   * fetched here. They load when the user focuses them, so reopening the app
   * costs the same handful of requests as a single-pane launch.
   */
  async restoreLastView() {
    const view = this.lastView;
    if (!view) return false;
    if (view.dm) {
      const channel = this.dms.find((entry) => String(entry.id) === view.channelId);
      if (!channel) return false;
      this.selection = null;
      this.selectedGuildId = null;
      this.railIndex = 0;
      this.sideOffset = 0;
      this.restoreSplitLayout(view, channel.id);
      await this.openChannel(channel.id, { focus: false });
      return true;
    }
    if (!view.guildId) return false;
    const index = this.guilds.findIndex((guild) => guild.id === view.guildId);
    if (index < 0) return false;
    const guild = this.guilds[index];
    this.selection = null;
    this.selectedGuildId = guild.id;
    this.railIndex = this.railIndexForGuild(guild.id, index + 1);
    this.sideOffset = 0;
    if (!guild.channels?.length) await this.loadGuildChannels(guild.id);
    if (!this.running) return true;
    const channels = this.guildTextChannels(guild);
    if (!channels.length) {
      this.splitMode = false;
      this.panes = [];
      this.paneIndex = 0;
      this.selectedChannelId = null;
      this.draw();
      return true;
    }
    const saved = view.channelId
      ? channels.find((channel) => String(channel.id) === view.channelId)
      : null;
    const target = saved || this.guildVisibleChannels(guild)[0] || channels[0];
    // Only a saved, still-visible focused channel can anchor a split. Falling
    // back to another channel restores a normal single view instead of leaving
    // stale pane ids around.
    if (saved) this.restoreSplitLayout(view, saved.id);
    else {
      this.splitMode = false;
      this.panes = [];
      this.paneIndex = 0;
    }
    this.revealChannel(target);
    await this.openChannel(target.id, { focus: false });
    return true;
  }

  /**
   * Rebuild the split layout from `lastView.split` without touching the API.
   * The focused channel must still be one of the saved panes; otherwise the
   * split is dropped and the normal single-pane fallback wins.
   */
  restoreSplitLayout(view, focusedId) {
    const split = view?.split;
    if (!split?.enabled) return false;
    const ids = (split.panes || []).map(String).filter(Boolean).slice(0, MAX_PANES);
    const focused = String(focusedId || '');
    if (ids.length < 2 || !focused) return false;
    let focus = clamp(Math.trunc(Number(split.focus) || 0), 0, ids.length - 1);
    if (ids[focus] !== focused) {
      const at = ids.indexOf(focused);
      if (at < 0) return false;
      focus = at;
    }
    this.splitMode = true;
    this.panes = ids;
    this.paneIndex = focus;
    this.invalidateLayouts();
    return true;
  }

  applyGuilds(list) {
    const previous = new Map(this.guilds.map((guild) => [guild.id, guild]));
    const incoming = [];
    const seen = new Set();

    for (const raw of list || []) {
      const guild = normalizeGuild(raw);
      if (seen.has(guild.id)) continue;
      seen.add(guild.id);

      const old = previous.get(guild.id);
      // READY may send thin guild objects (id + unavailable) after the richer
      // REST payload. Never let that erase a name, icon or loaded channels.
      if (old) {
        if (!raw.name && old.name) guild.name = old.name;
        if (!guild.icon && old.icon) guild.icon = old.icon;
      }
      guild.channels = old?.channels?.length
        ? old.channels
        : (raw.channels || []).map((channel) => this.client.rememberChannel(channel));
      incoming.push(guild);
    }

    if (!this.guilds.length) {
      this.guilds = incoming;
    } else {
      // Keep the established order; update in place and append new guilds.
      const byId = new Map(incoming.map((guild) => [guild.id, guild]));
      const merged = [];
      for (const guild of this.guilds) {
        const next = byId.get(guild.id);
        if (next) {
          merged.push(next);
          byId.delete(guild.id);
        } else {
          merged.push(guild);
        }
      }
      for (const guild of incoming) {
        if (byId.has(guild.id)) merged.push(guild);
      }
      this.guilds = merged;
    }
    this.recomputeUnread();
    this.clampRailIndex();
  }

  /** Reorder guilds to the user's folder order from `guild_folders`. */
  applyGuildOrder(ids) {
    if (!Array.isArray(ids) || !ids.length || !this.guilds.length) return;
    this.guilds = orderGuilds(this.guilds, ids);
    this.clampRailIndex();
  }

  /** Keep the rail cursor inside the visible row list after a data change. */
  clampRailIndex() {
    const count = railRows(this).length;
    this.railIndex = clamp(this.railIndex, 0, Math.max(0, count - 1));
  }

  /** The folder that contains `guildId`, if it is a collapsible folder. */
  folderOf(guildId) {
    const id = String(guildId);
    for (const folder of this.folders || []) {
      if (!(folder.guildIds || []).some((entry) => String(entry) === id)) continue;
      const key = folderKey(folder);
      if (!key) continue;
      return { ...folder, key };
    }
    return null;
  }

  /** Rail index for a guild, expanding its folder so the row exists. */
  railIndexForGuild(guildId, fallback = 0) {
    const folder = this.folderOf(guildId);
    // Opening a guild that lives in a collapsed folder expands it, and that
    // expansion is persisted just like an explicit toggle.
    if (folder && this.collapsedFolders.delete(folder.key)) this.savePrefs();
    const rows = railRows(this);
    const index = rows.findIndex(
      (row) => row.kind === 'guild' && String(row.guild.id) === String(guildId),
    );
    return index >= 0 ? index : fallback;
  }

  // --------------------------------------------------------------- collapsing
  toggleFolder(key) {
    const id = String(key || '');
    if (!id) return;
    if (this.collapsedFolders.has(id)) this.collapsedFolders.delete(id);
    else this.collapsedFolders.add(id);
    const rows = railRows(this);
    const index = rows.findIndex((row) => row.kind === 'folder' && row.key === id);
    if (index >= 0) this.railIndex = index;
    else this.clampRailIndex();
    this.focus = 'rail';
    this.savePrefs();
    this.draw();
  }

  toggleCategory(categoryId) {
    const id = String(categoryId || '');
    if (!id) return;
    if (this.collapsedCategories.has(id)) this.collapsedCategories.delete(id);
    else this.collapsedCategories.add(id);
    this.savePrefs();
    this.draw();
  }

  /** Expand a collapsed category so a restored channel is visible in the sidebar. */
  revealChannel(channel) {
    const parent = channel?.parent_id ? String(channel.parent_id) : '';
    if (parent && this.collapsedCategories.delete(parent)) this.savePrefs();
  }

  /** Space on the focused pane: collapse its folder or channel category. */
  toggleFocusedGroup() {
    if (this.focus === 'rail') {
      const row = railRows(this)[this.railIndex];
      if (row?.kind === 'folder') this.toggleFolder(row.key);
      else if (row?.kind === 'guild' && row.folderId) this.toggleFolder(row.folderId);
      return;
    }
    if (this.focus === 'sidebar') {
      const channel = this.currentChannel();
      const parent = channel?.parent_id ? String(channel.parent_id) : '';
      if (parent) this.toggleCategory(parent);
    }
  }

  savePrefs() {
    this.persistPrefs?.({
      collapsedFolders: [...this.collapsedFolders],
      collapsedCategories: [...this.collapsedCategories],
    });
  }

  /** Remember the current view so the next launch can restore it. */
  saveView() {
    if (!this.persistPrefs) return;
    // Nothing selected (e.g. quit during startup) must not clobber the view
    // saved by the previous run.
    if (!this.selectedGuildId && !this.selectedChannelId) return;
    try {
      const lastView = {
        guildId: this.selectedGuildId || '',
        channelId: this.selectedChannelId || '',
        dm: !this.selectedGuildId,
        wide: Boolean(this.wide),
      };
      // Persist the split only when it really is a split. Restoring four panes
      // is pointless if the user had collapsed back to a single view.
      if (this.splitMode && this.panes.length > 1) {
        lastView.split = {
          enabled: true,
          panes: this.panes.slice(0, MAX_PANES).map(String),
          focus: this.activePaneIndex(),
        };
      }
      this.persistPrefs({
        lastView,
        lastChannels: Object.fromEntries(this.lastChannelByGuild),
      });
    } catch {
      /* persisting the view is best effort */
    }
  }

  applyDms(list) {
    const byId = new Map(this.dms.map((channel) => [String(channel.id), channel]));
    for (const raw of list || []) {
      if (!raw?.id) continue;
      const id = String(raw.id);
      const old = byId.get(id);
      const channel = this.client.rememberChannel(raw);
      // Same race as guilds: READY's DM list can be thinner than REST's.
      if (old && old !== channel) {
        if (!channel.recipients?.length && old.recipients?.length) channel.recipients = old.recipients;
        if (!channel.last_message_id && old.last_message_id) channel.last_message_id = old.last_message_id;
        if (!channel.name && old.name) channel.name = old.name;
      }
      for (const recipient of channel.recipients || []) this.client.rememberUser(recipient);
      byId.set(id, channel);
    }
    this.dms = [...byId.values()];
    this.recomputeUnread();
  }

  recomputeUnread() {
    const channels = [];
    for (const guild of this.guilds) channels.push(...(guild.channels || []));
    channels.push(...this.dms);
    for (const channel of channels) {
      if (!channel?.id || !channel.last_message_id) continue;
      const state = this.readStates.get(String(channel.id));
      if (!state) continue;
      const last = asBig(channel.last_message_id);
      const read = state.lastMessageId ? asBig(state.lastMessageId) : 0n;
      if (last <= read) continue;
      const entry = this.unread.get(String(channel.id)) || { count: 0, mentions: 0 };
      entry.count = Math.max(entry.count, 1);
      entry.mentions = Math.max(entry.mentions, state.mentionCount || 0);
      this.unread.set(String(channel.id), entry);
    }
  }

  // ----------------------------------------------------------------- images
  imageThumb(attachment) {
    if (!this.images.enabled) return null;
    return this.thumbs.get(imageKey(attachment)) || null;
  }

  /** Queue decoding for the newest image attachments in a channel. */
  ensureThumbs(cache = this.currentChat()) {
    if (!this.images.enabled || !cache) return;
    let queued = 0;
    for (let index = cache.items.length - 1; index >= 0 && queued < IMAGE_AUTOLOAD; index -= 1) {
      for (const attachment of cache.items[index].attachments || []) {
        if (!isPreviewable(attachment)) continue;
        const key = imageKey(attachment);
        if (this.thumbs.has(key)) continue;
        this.thumbs.set(key, { status: 'queued' });
        this.thumbQueue.push(attachment);
        queued += 1;
        if (queued >= IMAGE_AUTOLOAD) break;
      }
    }
    this.pumpThumbs();
  }

  pumpThumbs() {
    while (this.thumbActive < IMAGE_CONCURRENCY && this.thumbQueue.length) {
      const attachment = this.thumbQueue.shift();
      this.thumbActive += 1;
      this.loadThumb(attachment).finally(() => {
        this.thumbActive -= 1;
        this.pumpThumbs();
      });
    }
  }

  async loadThumb(attachment) {
    const key = imageKey(attachment);
    try {
      const file = await downloadImage(attachment, { token: this.client.token || '', debug: this.debug });
      const master = await masterImage(file, attachment);
      if (!master) throw new Error('no decoder');
      this.thumbs.set(key, { status: 'ready', master });
      // Keep decoded masters bounded; Map preserves insertion order.
      while (this.thumbs.size > 60) {
        const oldest = this.thumbs.keys().next().value;
        if (oldest === key) break;
        this.thumbs.delete(oldest);
      }
    } catch (error) {
      this.thumbs.set(key, { status: 'error', error: error.message });
    }
    this.invalidateLayouts();
    if (this.running) this.draw();
  }

  /** Image rows change message height, so every cached layout is stale. */
  invalidateLayouts() {
    for (const cache of this.chats.values()) cache.layout = null;
  }

  toggleImages() {
    if (!this.images.supported) {
      this.toast(`inline images unavailable: ${this.images.reason || 'disabled'}`, 'error');
      return;
    }
    this.images.enabled = !this.images.enabled;
    this.invalidateLayouts();
    this.toast(this.images.enabled ? 'inline images on' : 'inline images off', 'info');
    if (this.images.enabled) {
      // Every visible column may hold previewable attachments.
      const ids = this.paneIds();
      if (!ids.length) this.ensureThumbs();
      for (const id of ids) this.ensureThumbs(this.chat(id));
    } else this.draw();
  }

  // ------------------------------------------------------------------ data
  currentGuild() {
    return this.guilds.find((guild) => guild.id === this.selectedGuildId) || null;
  }

  currentChannel() {
    return this.selectedChannelId ? this.channelById(this.selectedChannelId) : null;
  }

  /** Channel/DM lookup that works even before `client.channels` is warmed. */
  channelById(channelId) {
    const id = String(channelId);
    if (!id) return null;
    return (
      this.client.channel?.(id) ||
      this.dms.find((channel) => String(channel.id) === id) ||
      null
    );
  }

  currentChat() {
    const channel = this.currentChannel();
    return channel ? this.chat(channel.id) : null;
  }

  chat(channelId) {
    const id = String(channelId);
    let cache = this.chats.get(id);
    if (!cache) {
      cache = newChat(id);
      this.chats.set(id, cache);
    }
    return cache;
  }

  /** Text channels in the order the sidebar shows them (collapsed categories skipped). */
  guildVisibleChannels(guild) {
    const items = [];
    for (const group of groupChannels(guild?.channels || [])) {
      if (group.category && this.collapsedCategories.has(String(group.category.id))) continue;
      items.push(...group.channels);
    }
    return items;
  }

  /** All text channels sorted by position, including collapsed categories. */
  guildTextChannels(guild) {
    return sortChannels((guild?.channels || []).filter((channel) => isTextChannel(channel.type)));
  }

  async selectGuild(guildId, { focus = false } = {}) {
    const id = String(guildId);
    const index = this.guilds.findIndex((guild) => guild.id === id);
    if (index < 0) return;
    const seq = (this.guildSeq += 1);
    const channelSeq = this.channelSeq;
    this.selection = null;
    this.selectedGuildId = id;
    this.railIndex = this.railIndexForGuild(id, index + 1);
    this.sideOffset = 0;

    const guild = this.guilds[index];
    if (!guild.channels?.length) await this.loadGuildChannels(id);
    // A faster guild switch (or a channel opened while channels were loading)
    // must win over this older selection.
    if (!this.running || seq !== this.guildSeq || channelSeq !== this.channelSeq) return;

    const channels = this.guildTextChannels(guild);
    if (channels.length) {
      // Returning to a server should land on the channel that was open last,
      // not on whatever happens to be first in the API payload.
      const remembered = this.lastChannelByGuild.get(id);
      const target =
        channels.find((channel) => String(channel.id) === remembered) ||
        this.guildVisibleChannels(guild)[0] ||
        channels[0];
      this.revealChannel(target);
      await this.openChannel(target.id, { focus });
    } else {
      this.selectedChannelId = null;
      if (focus) this.focus = 'sidebar';
      this.draw();
    }
  }

  async selectDmHome() {
    this.selection = null;
    this.selectedGuildId = null;
    this.railIndex = 0;
    this.sideOffset = 0;
    if (!this.dms.length) {
      this.selectedChannelId = null;
      this.draw();
      return;
    }
    await this.openChannel(this.dms[0].id, { focus: false });
  }

  async loadGuildChannels(guildId) {
    const guild = this.guilds.find((entry) => entry.id === String(guildId));
    if (!guild) return;
    // If this guild is already loading, return the in-flight promise. Without
    // this, rapidly switching away and back would return immediately with an
    // empty channel list and leave the user on no channel at all.
    const existing = this.guildLoads.get(guild.id);
    if (existing) return existing;
    const task = (async () => {
      try {
        const list = await this.client.loadChannels(guild.id);
        guild.channels = list;
        this.recomputeUnread();
      } catch (error) {
        this.toast(`could not load channels: ${error.message}`, 'error');
      } finally {
        this.guildLoads.delete(guild.id);
        this.draw();
      }
    })();
    this.guildLoads.set(guild.id, task);
    return task;
  }

  async openChannel(channelId, { focus = false, force = false, resetScroll = true, resolve = false } = {}) {
    const id = String(channelId);
    if (!id) return;
    this.selection = null;
    this.messageMenu = null;
    this.resetMention();
    // A restored split can contain panes whose channel metadata was never
    // loaded. Resolve only when the user actually focuses that pane, so
    // startup does not fan out one request per saved pane.
    let channel = this.channelById(id);
    if (!channel && resolve) {
      const resolveSeq = (this.channelSeq += 1);
      try {
        channel = (await this.client.fetchChannel?.(id)) || null;
      } catch {
        channel = null;
      }
      if (!this.running || resolveSeq !== this.channelSeq) return;
    }
    // Opening a DM always leaves guild context, so `saveView()` records it as
    // a DM rather than as a channel of whatever guild was open before. Opening
    // a channel in another guild (possible from a split pane) follows that
    // guild instead of leaving the sidebar on the previous one.
    if (channel) {
      this.syncGuildContext(channel);
    } else if (this.dms.some((entry) => String(entry.id) === id)) {
      this.selectedGuildId = null;
      this.railIndex = 0;
      this.sideOffset = 0;
    }
    // Remember this channel for its guild, so switching away and back
    // restores what was being read.
    const guildId = this.channelGuildId(channel, id);
    if (guildId) this.lastChannelByGuild.set(guildId, id);
    const seq = (this.channelSeq += 1);
    this.selectedChannelId = id;
    // In split mode this either focuses the column that already shows the
    // channel or claims the next free column (replacing the focused one when
    // all four are taken).
    this.selectPaneFor(id);
    const cache = this.chat(id);
    if (resetScroll) cache.scroll = 0;
    // Opening a channel always returns to typing; the previous channel's
    // message cursor is not meaningful here.
    if (this.focus === 'messages') {
      this.focus = 'composer';
      this.reactMode = null;
    }
    if (focus) this.focus = 'composer';
    const hadUnread = this.unread.has(id);
    this.clearUnread(id);
    this.draw();

    if (force || !cache.loaded) {
      // Settle first. Holding ↓ over a long channel list used to start one
      // `GET messages` per channel it passed through; now only the channel the
      // user actually stops on is fetched.
      await sleep(CHANNEL_SETTLE_MS);
      if (!this.running || seq !== this.channelSeq) return;
      await this.loadMessages(id);
      if (!this.running || seq !== this.channelSeq) return;
    }

    // Images for an already-loaded channel still need their thumbnails.
    this.ensureThumbs(cache);
    this.ackVisibleChannel(id, hadUnread);
    this.draw();
  }

  /**
   * Ack a channel that is on screen. Kept separate from `openChannel` so
   * focusing an existing split pane does not refetch its messages.
   */
  ackVisibleChannel(channelId, hadUnread = false) {
    const id = String(channelId);
    const cache = this.chat(id);
    // Focusing an already-open pane must not ack messages the user has
    // deliberately scrolled away from.
    if ((cache.scroll || 0) > 0) return;
    const last = cache.items[cache.items.length - 1]?.id;
    const previousRead = this.readStates.get(id)?.lastMessageId || '';
    if (last && (hadUnread || !previousRead || asBig(last) > asBig(previousRead))) {
      // Keep the "new messages" divider visible for this visit even though the
      // read state is updated immediately.
      const marker = hadUnread && previousRead ? previousRead : null;
      this.markRead(id, last, { silent: true });
      cache.unreadMarker = marker;
      cache.layout = null;
    } else {
      cache.unreadMarker = null;
    }
  }

  async loadMessages(channelId, { force = false, quiet = false } = {}) {
    const id = String(channelId);
    const cache = this.chat(id);
    if (cache.loading) return;
    if (cache.loaded && !force) return;
    cache.loading = true;
    cache.error = null;
    this.draw();
    try {
      const list = await this.client.fetchMessages(id, { limit: 50 });
      if (!this.running) return;
      // Clear only after the request succeeded, so a network blip does not
      // wipe the messages the user is looking at (notably right after wake).
      if (force) {
        cache.items = [];
        cache.byId.clear();
        cache.version += 1;
        cache.layout = null;
      }
      this.mergeMessages(cache, list);
      cache.loaded = true;
      cache.oldestId = cache.items[0]?.id || null;
      cache.hasMore = list.length >= 50;
      return true;
    } catch (error) {
      // A quiet wake retry must leave the old messages on screen instead of
      // replacing them with a transient 502 banner.
      if (!quiet) cache.error = error.message;
      if (!quiet) this.toast(`could not load messages: ${error.message}`, 'error');
      return false;
    } finally {
      cache.loading = false;
      this.draw();
    }
  }

  mergeMessages(cache, list) {
    let changed = false;
    for (const raw of list || []) {
      const message = normalizeMessage(raw);
      if (!message) continue;
      if (message.author) this.client.rememberUser(message.author);
      for (const mention of message.mentions || []) this.client.rememberUser(mention);
      const existing = cache.byId.get(message.id);
      if (existing) {
        // MESSAGE_UPDATE payloads are partial: an edit or an embed unfurl can
        // omit `reactions`. Keep what we already know unless it is included.
        if (!Array.isArray(message.reactions) && Array.isArray(existing.reactions)) {
          message.reactions = existing.reactions;
        }
        if (existing.content === message.content && existing.edited_timestamp === message.edited_timestamp) {
          continue;
        }
      }
      cache.byId.set(message.id, message);
      changed = true;
    }
    if (!changed) return;
    cache.items = [...cache.byId.values()].sort((a, b) => {
      const left = messageOrder(a);
      const right = messageOrder(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    cache.version += 1;
    cache.layout = null;
    if (this.paneIds().includes(String(cache.id))) this.ensureThumbs(cache);
  }

  async loadOlder(channelId = this.selectedChannelId) {
    const id = channelId ? String(channelId) : '';
    const channel = id ? this.channelById(id) : null;
    if (!channel) return;
    const cache = this.chat(channel.id);
    if (!cache.hasMore || cache.loading || !cache.oldestId) return;
    cache.loading = true;
    try {
      const list = await this.client.fetchMessages(channel.id, { limit: 50, before: cache.oldestId });
      if (!this.running) return;
      this.mergeMessages(cache, list);
      cache.oldestId = cache.items[0]?.id || null;
      cache.hasMore = list.length >= 50;
    } catch (error) {
      this.toast(`could not load older messages: ${error.message}`, 'error');
    } finally {
      cache.loading = false;
      this.draw();
    }
  }

  async reloadMessages() {
    const channel = this.currentChannel();
    if (!channel) return;
    // `Ctrl+R` is a manual, repeatable action with no natural rate. Discord
    // allows 5 message fetches per 5s per channel, so hold the key down here
    // rather than eating a 429.
    const now = Date.now();
    if (now - this.lastReloadAt < RELOAD_COOLDOWN) return;
    this.lastReloadAt = now;
    await this.loadMessages(channel.id, { force: true });
    this.toast('messages reloaded', 'ok');
  }

  // --------------------------------------------------------------- messages
  async sendDraft() {
    const channel = this.currentChannel();
    if (!channel) return;
    const cache = this.chat(channel.id);
    let text = cache.draft.trim();
    // Attachments can be sent on their own, without any text.
    let staged = cache.attachments.slice();
    if (!staged.length && text) {
      // Some terminals deliver a file drop as raw characters instead of a
      // bracketed paste, leaving the path in the draft. Adopt it on send so
      // the drop still becomes an upload rather than a message full of paths.
      const parsed = parseAttachmentText(cache.draft);
      if (parsed.files.length && !parsed.rejected.length) {
        this.stageAttachments(parsed, { silent: true });
        if (cache.attachments.length) {
          cache.draft = '';
          cache.cursor = 0;
          cache.historyIndex = null;
          staged = cache.attachments.slice();
          text = '';
        }
      }
    }
    // Editing replaces the body of an existing message instead of sending a
    // new one. Attachments are not part of an edit, so they stay staged.
    if (cache.editingId) {
      if (!text) return;
      const messageId = String(cache.editingId);
      cache.editingId = null;
      cache.editBackup = null;
      cache.draft = '';
      cache.cursor = 0;
      cache.version += 1;
      cache.layout = null;
      this.resetMention();
      this.draw();
      try {
        const updated = await this.client.editMessage(channel.id, messageId, text);
        const message = normalizeMessage(updated);
        if (message) this.mergeMessages(cache, [message]);
        this.toast('message edited', 'ok');
      } catch (error) {
        // Put the text back so the edit can be retried.
        cache.draft = text;
        cache.cursor = graphemes(text).length;
        this.toast(`edit failed: ${error.message}`, 'error');
      }
      this.draw();
      return;
    }

    if (!text && !staged.length) return;

    // Sliding window rather than a fixed gap: Discord's documented limit is
    // 5 sends per 5s per channel. Block at 4 for margin and keep the draft, so
    // a held Enter key cannot burn the bucket or lose the message.
    const channelKey = String(channel.id);
    const now = Date.now();
    const recent = (this.sendTimes.get(channelKey) || []).filter((at) => now - at < SEND_WINDOW_MS);
    if (recent.length >= SEND_WINDOW_MAX) {
      this.sendTimes.set(channelKey, recent);
      if (now - this.lastSendToastAt > 1_500) {
        this.lastSendToastAt = now;
        this.toast('sending too fast. try again shortly', 'error');
      }
      return;
    }
    recent.push(now);
    this.sendTimes.set(channelKey, recent);

    const replyTo = cache.replyTo?.id ? String(cache.replyTo.id) : null;
    const nonce = `local-${Date.now()}-${(this.tmpSeq += 1)}`;
    const pending = {
      id: nonce,
      channel_id: channel.id,
      content: text,
      author: this.client.me,
      timestamp: new Date().toISOString(),
      nonce,
      __pending: true,
      attachments: staged.map((file) => ({
        id: file.path,
        filename: file.name,
        size: file.size,
        content_type: file.contentType,
      })),
    };
    cache.draft = '';
    cache.cursor = 0;
    cache.attachments = [];
    cache.replyTo = null;
    this.resetMention();
    if (text) {
      cache.history.push(text);
      if (cache.history.length > HISTORY_LIMIT) cache.history.shift();
    }
    cache.historyIndex = null;
    cache.scroll = 0;
    this.mergeMessages(cache, [pending]);
    this.draw();

    try {
      let sent;
      if (staged.length) {
        if (typeof this.client.sendMessageWithFiles !== 'function') {
          throw new Error('this client does not support attachments');
        }
        // Read lazily so a cancelled draft never touches the disk.
        const upload = await Promise.all(
          staged.map(async (file) => ({
            filename: file.name,
            contentType: file.contentType,
            data: await readFile(file.path),
          })),
        );
        sent = await this.client.sendMessageWithFiles(channel.id, text, upload, {
          nonce,
          replyTo,
        });
      } else {
        sent = await this.client.sendMessage(channel.id, text, { nonce, replyTo });
      }
      cache.byId.delete(nonce);
      const message = normalizeMessage(sent);
      if (message) this.mergeMessages(cache, [message]);
      // The upload is done; clipboard temp images have no further use.
      this.releaseClipboardFiles(staged);
      cache.version += 1;
      cache.layout = null;
      this.draw();
    } catch (error) {
      const local = cache.byId.get(nonce);
      if (local) local.__failed = true;
      // Give the files back unless the user staged something new meanwhile.
      if (staged.length && !cache.attachments.length) cache.attachments = staged;
      cache.version += 1;
      cache.layout = null;
      this.toast(`send failed: ${error.message}`, 'error');
    }
  }

  markRead(channelId = this.selectedChannelId, messageId = null, { silent = false } = {}) {
    if (!channelId) return;
    const id = String(channelId);
    const cache = this.chat(id);
    const last =
      messageId ||
      cache.items[cache.items.length - 1]?.id ||
      this.client.channel(id)?.last_message_id ||
      '';
    if (!last) return;
    this.readStates.set(id, { lastMessageId: String(last), mentionCount: 0 });
    this.clearUnread(id);
    cache.version += 1;
    cache.layout = null;
    this.live?.ack?.(id, String(last));
    if (!silent) this.toast('marked read', 'ok');
    else this.draw();
  }

  clearUnread(channelId) {
    this.unread.delete(String(channelId));
  }

  scrollMessages(delta, maybeLoadOlder) {
    const index = this.activePaneIndex();
    const id = this.paneIds()[index];
    const cache = id ? this.chats.get(String(id)) : null;
    if (!cache) return;
    this.selection = null;
    const max = this.messagesViews[index]?.maxScroll ?? 0;
    cache.scroll = clamp((cache.scroll || 0) + delta, 0, max);
    this.draw();
    if (maybeLoadOlder && cache.scroll >= max - 1) this.loadOlder(id);
  }

  resetMention() {
    this.mentionIndex = 0;
    this.mentionMuted = false;
  }

  /** Users worth offering first for `@`: recent authors/mentions and DM peers. */
  channelUserIds(channel) {
    const ids = [];
    const seen = new Set();
    const add = (value) => {
      const id = String(value || '');
      if (!id || id === this.myId || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const recipient of channel?.recipients || []) add(recipient?.id ?? recipient);
    const items = this.chats.get(String(channel?.id || ''))?.items || [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const message = items[index];
      add(message.author?.id);
      for (const mention of message.mentions || []) add(mention?.id);
    }
    return ids;
  }

  /**
   * Current mention token and its candidates, or null when the composer has no
   * `@`/`#` token under the cursor. Called by both input handling and drawing,
   * so the visible menu and what Enter/Tab accepts cannot diverge.
   */
  mentionState() {
    if (this.focus !== 'composer' || this.help || this.mentionMuted) return null;
    const channel = this.currentChannel();
    if (!channel) return null;
    const cache = this.chat(channel.id);
    const token = mentionToken(cache.draft, cache.cursor);
    if (!token) return null;

    let items;
    if (token.kind === 'user') {
      const preferred = this.channelUserIds(channel);
      const specials = channel.guild_id ? specialMentionItems(token) : [];
      items = [
        ...userMentionItems(this.client.users, token, { selfId: this.myId, preferred }),
        ...specials,
      ];
    } else {
      const guild = this.guilds.find((entry) => entry.id === String(channel.guild_id || ''));
      const channels = (guild?.channels || []).filter((entry) => isTextChannel(entry.type));
      items = channelMentionItems(channels, token);
    }
    if (!items.length) return null;
    items = items.slice(0, MENTION_LIMIT);
    if (!Number.isInteger(this.mentionIndex) || this.mentionIndex < 0 || this.mentionIndex >= items.length) {
      this.mentionIndex = 0;
    }
    return { token, items };
  }

  moveMention(delta) {
    const state = this.mentionState();
    if (!state) return false;
    const count = state.items.length;
    this.mentionIndex = ((this.mentionIndex + delta) % count + count) % count;
    this.draw();
    return true;
  }

  /** Replace the token under the cursor with real mention syntax. */
  acceptMention() {
    const state = this.mentionState();
    if (!state) return false;
    const item = state.items[this.mentionIndex] || state.items[0];
    const cache = this.currentChat();
    if (!item || !cache) return false;
    const parts = graphemes(cache.draft);
    const before = parts.slice(0, state.token.start).join('');
    const after = parts.slice(state.token.end).join('');
    const insert = item.insert.endsWith(' ') ? item.insert : `${item.insert} `;
    cache.draft = `${before}${insert}${after}`;
    cache.cursor = graphemes(`${before}${insert}`).length;
    cache.historyIndex = null;
    this.resetMention();
    const channel = this.currentChannel();
    if (channel) this.live?.sendTyping?.(channel.id);
    this.draw();
    return true;
  }

  insertText(text) {
    const cache = this.currentChat();
    if (!cache) return;
    const parts = graphemes(cache.draft);
    const insert = graphemes(String(text));
    parts.splice(cache.cursor, 0, ...insert);
    cache.draft = parts.join('');
    cache.cursor += insert.length;
    cache.historyIndex = null;
    this.resetMention();
    const channel = this.currentChannel();
    if (channel) this.live?.sendTyping?.(channel.id);
    this.draw();
  }

  deleteBeforeCursor() {
    const cache = this.currentChat();
    if (!cache) return;
    const parts = graphemes(cache.draft);
    if (cache.cursor <= 0) return;
    parts.splice(cache.cursor - 1, 1);
    cache.draft = parts.join('');
    cache.cursor -= 1;
    this.resetMention();
    this.draw();
  }

  deleteAtCursor() {
    const cache = this.currentChat();
    if (!cache) return;
    const parts = graphemes(cache.draft);
    if (cache.cursor >= parts.length) return;
    parts.splice(cache.cursor, 1);
    cache.draft = parts.join('');
    this.resetMention();
    this.draw();
  }

  /** Move the caret between visual composer rows; false at the edges. */
  moveComposerVertical(delta) {
    const cache = this.currentChat();
    if (!cache) return false;
    const width = composerTextWidth(this.geo.composer.width);
    const next = composerMoveVertical(cache.draft, cache.cursor, width, delta);
    if (next === null) return false;
    cache.cursor = next;
    this.resetMention();
    this.draw();
    return true;
  }

  browseHistory(delta) {
    const cache = this.currentChat();
    if (!cache || !cache.history.length) return;
    let index = cache.historyIndex;
    if (index === null) index = cache.history.length;
    index = clamp(index + delta, 0, cache.history.length);
    cache.historyIndex = index >= cache.history.length ? null : index;
    const value = cache.historyIndex === null ? '' : cache.history[cache.historyIndex];
    cache.draft = value;
    cache.cursor = graphemes(value).length;
    this.draw();
  }

  // ------------------------------------------------------------------- live
  attachLive() {
    if (!this.live) return;
    this.live.on('state', (event) => this.onState(event));
    this.live.on('ready', (data) => this.onReady(data));
    this.live.on('resumed', () => this.toast('gateway session resumed', 'ok'));
    this.live.on('message', (event) => this.onLiveMessage(event));
    this.live.on('message_update', (event) => this.onLiveMessageUpdate(event));
    this.live.on('message_delete', (event) => this.onLiveMessageDelete(event));
    this.live.on('reaction', (event) => this.onReaction(event));
    this.live.on('typing', () => this.draw());
    this.live.on('typing_expire', () => this.draw());
    this.live.on('read_state', (event) => this.onReadState(event));
    this.live.on('guild_settings', (event) => this.onGuildSettings(event));
    this.live.on('channel', () => this.onChannelChange());
    this.live.on('guild', () => this.onGuildChange());
    this.live.on('fatal', (error) => this.toast(error.message || 'fatal gateway error', 'error'));
  }

  onState({ state }) {
    const wasOnline = this.state === 'online';
    this.state = state;
    if (state === 'online') {
      const offlineFor = this.offlineAt ? Date.now() - this.offlineAt : 0;
      this.offlineAt = 0;
      if (this.needWakeRefresh) this.tryWakeRefresh();
      else if (offlineFor >= OFFLINE_REFRESH_MS) {
        // A resumed session replays missed events, but an expired one gets a
        // fresh READY. Refetch the visible panes to close either gap.
        this.scheduleRefresh(500);
      }
    } else if (wasOnline || !this.offlineAt) {
      this.offlineAt = Date.now();
    }
    this.draw();
  }

  onReady({ user, guilds, privateChannels, readStates, guildSettings }) {
    if (user) {
      this.myId = String(user.id);
      this.myName = displayName(user, this.myName);
    }
    if (guilds?.length) {
      this.applyGuilds(guilds);
      if (this.guildOrder.length) this.applyGuildOrder(this.guildOrder);
    }
    if (privateChannels?.length) this.applyDms(privateChannels);
    if (readStates) {
      this.readStates = new Map(readStates);
      this.recomputeUnread();
    }
    if (guildSettings) this.guildSettings = new Map(guildSettings);
    if (!this.selectedChannelId) this.bootstrapSelection();
    this.draw();
  }

  /** Gateway pushed a new per-guild notification setting entry. */
  onGuildSettings({ guildId, settings, guildSettings } = {}) {
    if (guildSettings) {
      this.guildSettings = new Map(guildSettings);
      return;
    }
    if (!settings) return;
    this.guildSettings.set(String(guildId || ''), settings);
  }

  onLiveMessage({ message, channelId }) {
    const normalized = normalizeMessage(message);
    if (!normalized) return;
    const cache = this.chat(channelId);

    if (normalized.nonce) {
      const pending = [...cache.byId.values()].find((entry) => entry.nonce === normalized.nonce);
      if (pending) cache.byId.delete(pending.id);
    }
    this.mergeMessages(cache, [normalized]);

    const channel = this.client.channel(channelId);
    if (channel) channel.last_message_id = normalized.id;

    const mine = normalized.author?.id === this.myId;
    const visible = this.paneIds().includes(String(channelId));
    const atBottom = (cache.scroll || 0) === 0;
    // Only count a message as read when the terminal is actually focused.
    const reading = this.focused && visible && atBottom;

    if (!mine && !reading) {
      const mention = mentionsUser(normalized.content, this.myId);
      const entry = this.unread.get(channelId) || { count: 0, mentions: 0 };
      entry.count += 1;
      if (mention) entry.mentions += 1;
      entry.lastMessageId = normalized.id;
      this.unread.set(channelId, entry);
      this.maybeBell({ mention, channelId });
    } else if (!mine && reading) {
      this.markRead(channelId, normalized.id, { silent: true });
    }

    if (visible && atBottom) cache.scroll = 0;
    this.draw();
  }

  onLiveMessageUpdate({ message, channelId }) {
    const normalized = normalizeMessage(message);
    if (!normalized) return;
    const cache = this.chat(channelId);
    if (!cache.byId.has(normalized.id)) return;
    this.mergeMessages(cache, [normalized]);
    this.draw();
  }

  onReaction({ type, channelId, messageId, userId, emoji }) {
    const cache = this.chats.get(String(channelId));
    const message = cache?.byId.get(String(messageId));
    if (!message) return;
    this.applyReactionLocal(cache, message, { type, userId, emoji });
    this.draw();
  }

  onLiveMessageDelete({ channelId, messageId }) {
    const cache = this.chat(channelId);
    if (!cache.byId.has(String(messageId))) return;
    cache.byId.delete(String(messageId));
    cache.items = cache.items.filter((message) => message.id !== String(messageId));
    cache.version += 1;
    cache.layout = null;
    this.draw();
  }

  onReadState({ channelId, messageId, mentionCount }) {
    const id = String(channelId);
    this.readStates.set(id, {
      lastMessageId: messageId ? String(messageId) : '',
      mentionCount: Number(mentionCount) || 0,
    });
    this.clearUnread(id);
    const cache = this.chats.get(id);
    if (cache) {
      cache.version += 1;
      cache.layout = null;
    }
    this.draw();
  }

  onChannelChange() {
    const guild = this.currentGuild();
    if (guild) {
      guild.channels = [...this.client.channels.values()].filter(
        (channel) => String(channel.guild_id) === guild.id,
      );
      this.recomputeUnread();
    }
    this.draw();
  }

  onGuildChange() {
    const list = [...this.client.guilds.values()];
    this.applyGuilds(list);
    this.draw();
  }
}
