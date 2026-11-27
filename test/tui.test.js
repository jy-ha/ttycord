import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { App } from '../src/tui/app.js';
import { dumpRender } from '../src/tui/index.js';
import { MAX_ATTACHMENT_BYTES } from '../src/tui/attach.js';
import { imageKey } from '../src/tui/image.js';
import { selectionText } from '../src/tui/clipboard.js';
import { normalizeGuild } from '../src/tui/model.js';
import { buildMessageRows, messageLinkAt } from '../src/tui/pane.js';
import { Screen } from '../src/tui/term.js';
import { T } from '../src/tui/theme.js';
import {
  categoryCollapsed,
  folderKey,
  railHitIndex,
  railRows,
  selectableChannels,
  sidebarHitIndex,
  sidebarItems,
} from '../src/tui/views.js';

function makeClient() {
  const me = { id: '1', username: 'me', global_name: 'Me' };
  const users = new Map([[me.id, me]]);
  const channels = new Map();
  const guilds = new Map();
  const sent = [];
  const uploads = [];
  const acks = [];
  const fetched = [];
  const channelFetches = [];
  const channelLoads = [];
  const reactions = [];
  const edits = [];
  const deletions = [];
  const sendOptions = [];
  const client = {
    token: 'test-token',
    me,
    users,
    channels,
    guilds,
    sent,
    uploads,
    acks,
    fetched,
    channelFetches,
    channelLoads,
    reactions,
    edits,
    deletions,
    sendOptions,
    channel(id) {
      return channels.get(String(id)) || null;
    },
    user(id) {
      return users.get(String(id)) || null;
    },
    rememberUser(user) {
      if (user?.id) users.set(String(user.id), user);
      return user;
    },
    rememberChannel(channel) {
      if (channel?.id) channels.set(String(channel.id), channel);
      return channel;
    },
    async loadGuilds() {
      return [];
    },
    async loadDms() {
      return [];
    },
    async loadChannels(guildId) {
      channelLoads.push(String(guildId));
      return [];
    },
    async fetchMessages(channelId, options = {}) {
      fetched.push([String(channelId), options]);
      return [];
    },
    async fetchChannel(channelId) {
      channelFetches.push(String(channelId));
      return channels.get(String(channelId)) || null;
    },
    async sendMessage(channelId, content, options = {}) {
      sendOptions.push(options);
      const message = {
        id: '1000',
        channel_id: channelId,
        content,
        author: me,
        timestamp: new Date().toISOString(),
      };
      sent.push(message);
      return message;
    },
    async sendMessageWithFiles(channelId, content, files, options = {}) {
      sendOptions.push(options);
      const message = {
        id: '1001',
        channel_id: channelId,
        content,
        author: me,
        timestamp: new Date().toISOString(),
        attachments: files.map((file, index) => ({
          id: `upload-${index}`,
          filename: file.filename,
          size: file.data.length,
          content_type: file.contentType,
          url: `https://cdn.discordapp.com/${file.filename}`,
        })),
      };
      uploads.push({ channelId: String(channelId), content, files });
      return message;
    },
    async addReaction(channelId, messageId, emoji) {
      reactions.push({ op: 'add', channelId: String(channelId), messageId: String(messageId), emoji });
      return true;
    },
    async removeReaction(channelId, messageId, emoji) {
      reactions.push({ op: 'remove', channelId: String(channelId), messageId: String(messageId), emoji });
      return true;
    },
    async editMessage(channelId, messageId, content) {
      edits.push({ channelId: String(channelId), messageId: String(messageId), content });
      return {
        id: String(messageId),
        channel_id: String(channelId),
        content,
        author: me,
        timestamp: new Date().toISOString(),
        edited_timestamp: new Date().toISOString(),
      };
    },
    async deleteMessage(channelId, messageId) {
      deletions.push({ channelId: String(channelId), messageId: String(messageId) });
      return true;
    },
    async ack(channelId, messageId) {
      acks.push([channelId, messageId]);
      return true;
    },
    async typing() {},
  };
  return client;
}

function makeScreen(cols = 100, rows = 30) {
  const out = { isTTY: false, columns: cols, rows, write() {} };
  const screen = new Screen(out);
  screen.resize(cols, rows);
  return screen;
}

/** A press/release on the same cell: the app resolves it as a click. */
function click(app, x, y, button = 0) {
  app.handleMouse({ action: 'press', button, x, y, wheel: null, motion: false });
  app.handleMouse({ action: 'release', button, x, y, wheel: null, motion: false });
}

function makeApp({
  live = null,
  copy = null,
  paste = null,
  out = undefined,
  sound = () => 'bell',
  cols = 100,
  rows = 30,
} = {}) {
  const client = makeClient();
  const screen = makeScreen(cols, rows);
  const app = new App({
    client,
    live,
    screen,
    ...(copy ? { copy } : {}),
    ...(paste ? { paste } : {}),
    ...(out ? { out } : {}),
    sound,
  });
  app.running = true;
  const guild = normalizeGuild({ id: '10', name: 'Rust Korea' });
  guild.channels = [
    client.rememberChannel({
      id: '101',
      guild_id: '10',
      type: 0,
      name: 'general',
      topic: '일반 대화',
      position: 0,
    }),
    client.rememberChannel({
      id: '102',
      guild_id: '10',
      type: 0,
      name: 'dev',
      position: 1,
    }),
  ];
  app.guilds = [guild];
  app.dms = [];
  app.selectedGuildId = '10';
  app.selectedChannelId = '101';
  app.railIndex = 1;
  app.focus = 'sidebar';
  const cache = app.chat('101');
  cache.items = [
    {
      id: '900',
      channel_id: '101',
      type: 0,
      author: { id: '2', username: 'mira', global_name: '미라' },
      content: '안녕하세요',
      timestamp: new Date().toISOString(),
    },
  ];
  cache.byId = new Map(cache.items.map((message) => [message.id, message]));
  cache.loaded = true;
  cache.version = 1;
  return { app, client, screen };
}

test('dumpRender includes the main regions', () => {
  const text = dumpRender({ width: 100, height: 30 });
  assert.match(text, /ttycord/);
  assert.match(text, /Demo Guild/);
  assert.match(text, /general/);
  assert.match(text, /NEW/);
});

test('app renders guild, channel and message content', () => {
  const { app, screen } = makeApp();
  app.draw();
  const text = screen.renderToString();
  assert.match(text, /Rust Korea/);
  assert.match(text, /general/);
  assert.match(text, /미라/);
  assert.match(text, /안녕하세요/);
});

test('focus cycles between rail, sidebar and composer', () => {
  const { app } = makeApp();
  app.focus = 'rail';
  app.moveFocus(1);
  assert.equal(app.focus, 'sidebar');
  app.moveFocus(1);
  assert.equal(app.focus, 'composer');
  app.moveFocus(1);
  assert.equal(app.focus, 'rail');
  app.moveFocus(-1);
  assert.equal(app.focus, 'composer');
});

test('composer inserts text and sends it', async () => {
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.insertText('hello');
  assert.equal(app.chat('101').draft, 'hello');
  await app.sendDraft();
  assert.equal(app.chat('101').draft, '');
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].content, 'hello');
  assert.ok(app.chat('101').byId.has('1000'));
  assert.ok(![...app.chat('101').byId.keys()].some((key) => key.startsWith('local-')));
});

test('Ctrl+Enter inserts a newline instead of sending', () => {
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.insertText('first');
  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  app.insertText('second');

  assert.equal(app.chat('101').draft, 'first\nsecond');
  assert.equal(client.sent.length, 0);
});

test('Alt+Enter and Shift+Enter also insert newlines', () => {
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.handleKey({ key: 'enter', ctrl: false, alt: true, shift: false });
  app.handleKey({ key: 'enter', ctrl: false, alt: false, shift: true });
  app.insertText('x');

  assert.equal(app.chat('101').draft, '\n\nx');
  assert.equal(client.sent.length, 0);
});

test('Ctrl+J works both as LF and as a modified j', () => {
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  app.handleKey({ key: 'j', ctrl: true, alt: false, shift: false });
  assert.equal(app.chat('101').draft, '\n\n');
  assert.equal(client.sent.length, 0);
});

test('a multiline draft grows the composer and shows every line', () => {
  const { app, screen } = makeApp();
  app.focus = 'composer';
  app.insertText('one');
  assert.equal(app.geo.composer.height, 3);

  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  app.insertText('two');
  assert.equal(app.geo.composer.height, 4);

  const rendered = screen.renderToString();
  assert.match(rendered, /one/);
  assert.match(rendered, /two/);
});

test('the composer stops growing after the line cap', () => {
  const { app } = makeApp();
  app.focus = 'composer';
  for (let index = 0; index < 10; index += 1) {
    if (index) app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
    app.insertText(`line ${index}`);
  }
  assert.equal(app.geo.composer.height, 8); // 2 borders + 6 visible lines
});

test('Up and Down move between visual rows before browsing history', () => {
  const { app } = makeApp();
  app.focus = 'composer';
  app.insertText('one');
  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  app.insertText('two');
  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  app.insertText('three');
  const cache = app.chat('101');
  assert.equal(cache.cursor, cache.draft.length);

  app.handleKey({ key: 'up', ctrl: false, alt: false, shift: false });
  assert.equal(cache.cursor, cache.draft.indexOf('two') + 3);
  app.handleKey({ key: 'up', ctrl: false, alt: false, shift: false });
  assert.equal(cache.cursor, 3);
  app.handleKey({ key: 'down', ctrl: false, alt: false, shift: false });
  assert.equal(cache.cursor, cache.draft.indexOf('two') + 3);
});

test('a multiline message is sent with its line breaks intact', async () => {
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.insertText('first');
  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  app.insertText('second');
  await app.sendDraft();
  assert.equal(client.sent.at(-1).content, 'first\nsecond');
});

test('Ctrl+Enter does not accept a mention menu', () => {
  const { app, client } = makeApp();
  client.rememberUser({ id: '2', username: 'alice' });
  app.focus = 'composer';
  app.handleText('@');
  assert.ok(app.mentionState());

  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  assert.equal(app.chat('101').draft, '@\n');
  assert.equal(client.sent.length, 0);
});

test('markRead acks and clears unread state', () => {
  const acks = [];
  const live = {
    ack: (channelId, messageId) => acks.push([channelId, messageId]),
    typingNames: () => [],
  };
  const { app } = makeApp({ live });
  app.unread.set('101', { count: 3, mentions: 1 });
  app.markRead('101', '900', { silent: true });
  assert.deepEqual(acks[0], ['101', '900']);
  assert.equal(app.unread.has('101'), false);
  assert.equal(app.readStates.get('101').lastMessageId, '900');
});

test('openChannel keeps the unread divider for the visit', async () => {
  const { app, screen } = makeApp();
  const cache = app.chat('101');
  const extra = {
    id: '901',
    channel_id: '101',
    type: 0,
    author: { id: '2', username: 'mira', global_name: '미라' },
    content: '새 소식',
    timestamp: new Date().toISOString(),
  };
  cache.items.push(extra);
  cache.byId.set(extra.id, extra);
  cache.version += 1;
  app.readStates.set('101', { lastMessageId: '900', mentionCount: 0 });
  app.unread.set('101', { count: 1, mentions: 0 });

  await app.openChannel('101', { focus: false });

  assert.equal(cache.unreadMarker, '900');
  assert.equal(app.readStates.get('101').lastMessageId, '901');
  assert.equal(app.unread.has('101'), false);
  app.draw();
  assert.match(screen.renderToString(), /NEW/);
});

test('live message updates cache and unread state', () => {
  const { app } = makeApp();
  app.focus = 'sidebar';
  app.selectedChannelId = '102';
  app.onLiveMessage({
    channelId: '101',
    message: {
      id: '901',
      channel_id: '101',
      type: 0,
      author: { id: '2', username: 'mira', global_name: '미라' },
      content: '새 메시지',
      timestamp: new Date().toISOString(),
    },
  });
  assert.ok(app.chat('101').byId.has('901'));
  assert.equal(app.unread.get('101').count, 1);
});

test('typing line is drawn for the selected channel', () => {
  const { app, screen } = makeApp();
  app.live = {
    typingNames: () => ['미라'],
  };
  app.draw();
  assert.match(screen.renderToString(), /typing:/);
});

test('Ctrl+R reload is debounced', async () => {
  const { app, client } = makeApp();
  await app.reloadMessages();
  await app.reloadMessages();
  await app.reloadMessages();
  assert.equal(client.fetched.length, 1);
});

test('rapid channel switching only fetches the channel you stop on', async () => {
  const { app, client } = makeApp();
  const first = app.openChannel('102');
  const second = app.openChannel('103');
  await Promise.all([first, second]);
  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['103'],
  );
});

test('rapid sends are throttled and keep the draft', async () => {
  const { app, client } = makeApp();
  for (let index = 0; index < 4; index += 1) {
    app.chat('101').draft = `m${index}`;
    await app.sendDraft();
  }
  assert.equal(client.sent.length, 4);

  app.chat('101').draft = 'm4';
  await app.sendDraft();
  assert.equal(client.sent.length, 4, 'fifth send must be blocked');
  assert.equal(app.chat('101').draft, 'm4', 'blocked send keeps the draft');
});

test('thin READY guilds do not erase names or order', () => {
  const { app } = makeApp();
  app.guilds = [
    normalizeGuild({ id: '10', name: 'Rust Korea' }),
    normalizeGuild({ id: '20', name: 'VRChat' }),
  ];
  app.applyGuilds([{ id: '10', unavailable: true }, { id: '20', unavailable: true }]);
  assert.deepEqual(app.guilds.map((guild) => guild.name), ['Rust Korea', 'VRChat']);
});

test('applyGuildOrder follows the folder order', () => {
  const { app } = makeApp();
  app.guilds = [
    normalizeGuild({ id: '10', name: 'A' }),
    normalizeGuild({ id: '20', name: 'B' }),
    normalizeGuild({ id: '30', name: 'C' }),
  ];
  app.applyGuildOrder(['30', '10']);
  assert.deepEqual(app.guilds.map((guild) => guild.id), ['30', '10', '20']);
});

test('rail hit-testing is one row per guild', () => {
  const rail = { x: 0, y: 1, width: 20, height: 12 };
  assert.equal(railHitIndex(1, rail, 0, 3), null, 'body top row');
  assert.equal(railHitIndex(2, rail, 0, 3), 0, 'DM home');
  assert.equal(railHitIndex(3, rail, 0, 3), null, 'separator');
  assert.equal(railHitIndex(4, rail, 0, 3), 1);
  assert.equal(railHitIndex(5, rail, 0, 3), 2);
  assert.equal(railHitIndex(6, rail, 0, 3), 3);
  assert.equal(railHitIndex(7, rail, 0, 3), null, 'past the last guild');
  assert.equal(railHitIndex(4, rail, 5, 8), 6, 'scrolled list');
});

test('sidebar hit-testing skips the title and separator', () => {
  const sidebar = { x: 20, y: 1, width: 24, height: 12 };
  assert.equal(sidebarHitIndex(1, sidebar, 0), null);
  assert.equal(sidebarHitIndex(2, sidebar, 0), null);
  assert.equal(sidebarHitIndex(3, sidebar, 0), 0);
  assert.equal(sidebarHitIndex(5, sidebar, 2), 4);
});

test('rail draws the DM row and separator on different lines', () => {
  const { app, screen } = makeApp();
  app.guilds = [
    normalizeGuild({ id: '10', name: 'Rust Korea' }),
    normalizeGuild({ id: '20', name: 'VRChat' }),
  ];
  app.railIndex = 1;
  app.draw();
  const lines = screen.renderToString().split('\n');
  // y=2 is the DM row, y=3 the separator, y=4 the first guild.
  assert.match(lines[2], /DM/);
  assert.match(lines[3], /^─/);
  assert.match(lines[4], /01 Rust Korea/);
  assert.match(lines[5], /02 VRChat/);
});

test('inline image rows carry the attachment URL', () => {
  const { app } = makeApp();
  const attachment = {
    id: 'a1',
    filename: 'probe.png',
    size: 10,
    content_type: 'image/png',
    width: 2,
    height: 2,
    url: 'https://cdn.discordapp.com/attachments/1/2/probe.png',
  };
  const cache = app.chat('101');
  cache.items = [{ ...cache.items[0], content: 'shot', attachments: [attachment] }];
  cache.byId = new Map(cache.items.map((message) => [message.id, message]));
  cache.version += 1;
  cache.layout = null;

  // Without a decoded thumbnail only the `[img]` label exists, and it is
  // already clickable.
  const label = buildMessageRows(app, cache, 40);
  assert.equal(label.links.filter(Boolean).length, 1);
  assert.equal(label.links.find(Boolean), attachment.url);

  app.thumbs.set(imageKey(attachment), {
    status: 'ready',
    master: { width: 2, height: 2, pixels: Buffer.alloc(16, 255) },
  });
  cache.layout = null;
  const drawn = buildMessageRows(app, cache, 40);
  assert.ok(drawn.links.filter(Boolean).length > 1, 'every image row is a link');
  assert.ok(drawn.links.filter(Boolean).every((link) => link === attachment.url));

  app.draw();
  assert.ok(app.messagesView.links.includes(attachment.url));
});

test('messageLinkAt maps a terminal row to the row under it', () => {
  const view = {
    y0: 5,
    height: 3,
    start: 1,
    links: ['https://a', 'https://b', 'https://c'],
  };
  assert.equal(messageLinkAt(view, 4), null, 'above the pane');
  assert.equal(messageLinkAt(view, 5), 'https://b');
  assert.equal(messageLinkAt(view, 6), 'https://c');
  assert.equal(messageLinkAt(view, 7), null, 'past the visible rows');
  assert.equal(messageLinkAt(null, 5), null);
});

test('clicking an inline image row opens its attachment URL', () => {
  const { app } = makeApp();
  const attachment = {
    id: 'a2',
    filename: 'shot.png',
    size: 10,
    content_type: 'image/png',
    width: 2,
    height: 2,
    url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
  };
  const cache = app.chat('101');
  cache.items = [{ ...cache.items[0], content: 'shot', attachments: [attachment] }];
  cache.byId = new Map(cache.items.map((message) => [message.id, message]));
  cache.version += 1;
  cache.layout = null;
  app.thumbs.set(imageKey(attachment), {
    status: 'ready',
    master: { width: 2, height: 2, pixels: Buffer.alloc(16, 255) },
  });
  app.draw();

  const opened = [];
  app.openUrl = (url) => opened.push(url);
  const view = app.messagesView;
  const visible = view.links.slice(view.start, view.start + view.height);
  const linkOffset = visible.findIndex(Boolean);
  assert.ok(linkOffset >= 0, 'a link row is visible');
  const clickY = view.y0 + linkOffset;
  const plainOffset = visible.findIndex((link) => !link);
  assert.ok(plainOffset >= 0, 'a non-link row is visible');

  // A plain row (for example the trailing blank line) is not a link.
  app.handleMouse({
    action: 'press',
    button: 0,
    x: app.geo.messages.x + 4,
    y: view.y0 + plainOffset,
    wheel: null,
  });
  assert.deepEqual(opened, []);

  // Right-click is ignored.
  app.handleMouse({
    action: 'press',
    button: 2,
    x: app.geo.messages.x + 4,
    y: clickY,
    wheel: null,
  });
  assert.deepEqual(opened, []);

  click(app, app.geo.messages.x + 4, clickY);
  assert.deepEqual(opened, [attachment.url]);
});

// ------------------------------------------------------------ guild folders

/** App with four guilds: two in a named folder, one in an unnamed folder. */
function makeFolderApp() {
  const { app, client, screen } = makeApp();
  const guilds = [
    normalizeGuild({ id: '10', name: 'Rust Korea' }),
    normalizeGuild({ id: '20', name: 'VRChat' }),
    normalizeGuild({ id: '30', name: 'Solo' }),
    normalizeGuild({ id: '40', name: 'Loose' }),
  ];
  app.guilds = guilds;
  app.folders = [
    { id: '1929507120', name: '', color: null, guildIds: ['10', '20'] },
    { id: '', name: '', color: null, guildIds: ['30'] },
    { id: '', name: '', color: null, guildIds: ['40'] },
  ];
  app.selectedGuildId = '10';
  app.railIndex = 1;
  app.focus = 'rail';
  return { app, client, screen };
}

test('folderKey prefers id, then name, and skips anonymous singletons', () => {
  assert.equal(folderKey({ id: '7', name: 'work', guildIds: ['1'] }), '7');
  assert.equal(folderKey({ id: '', name: 'work', guildIds: ['1'] }), 'name:work');
  assert.equal(folderKey({ id: '', name: '', guildIds: ['1', '2'] }), 'ids:1,2');
  assert.equal(folderKey({ id: '', name: '', guildIds: ['1'] }), '');
  assert.equal(folderKey(null), '');
});

test('railRows draws folder headers, indented guilds and plain singletons', () => {
  const { app } = makeFolderApp();
  const rows = railRows(app);
  assert.deepEqual(
    rows.map((row) => (row.kind === 'folder' ? `folder:${row.label}` : row.kind === 'dm' ? 'dm' : `guild:${row.guild.name}`)),
    ['dm', 'folder:folder', 'guild:Rust Korea', 'guild:VRChat', 'guild:Solo', 'guild:Loose'],
  );
  // Guilds inside the unnamed folder carry the folder key so the rail can draw
  // the `│` indent; top-level guilds do not.
  assert.equal(rows[2].folderId, '1929507120');
  assert.equal(rows[4].folderId, null);
});

test('railRows hides guild rows when a folder is collapsed', () => {
  const { app } = makeFolderApp();
  app.collapsedFolders = new Set(['1929507120']);
  const rows = railRows(app);
  assert.deepEqual(
    rows.map((row) => (row.kind === 'folder' ? `folder:${row.label}:${row.count}` : row.kind === 'dm' ? 'dm' : `guild:${row.guild.name}`)),
    ['dm', 'folder:folder:2', 'guild:Solo', 'guild:Loose'],
  );
  assert.equal(rows[1].collapsed, true);
});

test('activating a folder row collapses and expands it', () => {
  const { app } = makeFolderApp();
  const saved = [];
  app.persistPrefs = (prefs) => saved.push(prefs);
  app.railIndex = 1;
  app.activateSelection();
  assert.deepEqual([...app.collapsedFolders], ['1929507120']);
  assert.equal(railRows(app)[1].collapsed, true);
  assert.equal(app.railIndex, 1, 'cursor stays on the folder header');
  assert.deepEqual(saved.at(-1), {
    collapsedFolders: ['1929507120'],
    collapsedCategories: [],
  });

  app.activateSelection();
  assert.deepEqual([...app.collapsedFolders], []);
  assert.equal(railRows(app)[1].collapsed, false);
});

test('space toggles the folder under the rail cursor', () => {
  const { app } = makeFolderApp();
  app.railIndex = 1;
  app.handleText(' ');
  assert.deepEqual([...app.collapsedFolders], ['1929507120']);
  app.handleText(' ');
  assert.deepEqual([...app.collapsedFolders], []);
});

test('clicking a folder header toggles it instead of opening a guild', () => {
  const { app } = makeFolderApp();
  app.draw();
  const folderY = app.geo.rail.y + 3; // list row 0 = folder header
  click(app, app.geo.rail.x + 3, folderY);
  assert.deepEqual([...app.collapsedFolders], ['1929507120']);
  click(app, app.geo.rail.x + 3, folderY);
  assert.deepEqual([...app.collapsedFolders], []);
});

test('selecting a guild inside a collapsed folder expands the folder', () => {
  const { app } = makeFolderApp();
  const saved = [];
  app.persistPrefs = (prefs) => saved.push(prefs);
  app.collapsedFolders = new Set(['1929507120']);
  app.railIndex = app.railIndexForGuild('20');
  assert.deepEqual([...app.collapsedFolders], []);
  assert.deepEqual(saved.at(-1), { collapsedFolders: [], collapsedCategories: [] });
  const row = railRows(app)[app.railIndex];
  assert.equal(row.guild.id, '20');
});

test('rail hit-testing accounts for folder rows', () => {
  const { app } = makeFolderApp();
  const rail = { x: 0, y: 1, width: 20, height: 12 };
  const rows = railRows(app);
  assert.equal(railHitIndex(4, rail, 0, rows.length - 1), 1, 'folder header');
  assert.equal(railHitIndex(5, rail, 0, rows.length - 1), 2, 'first guild in folder');
});

test('category headers collapse and hide their channels', () => {
  const { app, client } = makeApp();
  const guild = app.guilds[0];
  guild.channels = [
    client.rememberChannel({ id: '100', guild_id: '10', type: 4, name: 'TEXT', position: 0 }),
    client.rememberChannel({ id: '101', guild_id: '10', type: 0, name: 'general', parent_id: '100', position: 1 }),
    client.rememberChannel({ id: '102', guild_id: '10', type: 0, name: 'dev', parent_id: '100', position: 2 }),
    client.rememberChannel({ id: '103', guild_id: '10', type: 0, name: 'lobby', position: 3 }),
  ];
  app.collapsedCategories = new Set();
  assert.deepEqual(
    sidebarItems(app).map((item) => (item.kind === 'category' ? `[${item.label}]` : item.channel.name)),
    ['lobby', '[TEXT]', 'general', 'dev'],
  );
  assert.deepEqual(selectableChannels(app).map((channel) => channel.id), ['103', '101', '102']);

  app.toggleCategory('100');
  assert.equal(categoryCollapsed(app, '100'), true);
  const items = sidebarItems(app);
  assert.deepEqual(items.map((item) => (item.kind === 'category' ? `[${item.label}]` : item.channel.name)), ['lobby', '[TEXT]']);
  assert.equal(items[1].collapsed, true);
  assert.deepEqual(selectableChannels(app).map((channel) => channel.id), ['103']);
});

test('clicking a category header toggles it', () => {
  const { app, client } = makeApp();
  const guild = app.guilds[0];
  guild.channels = [
    client.rememberChannel({ id: '100', guild_id: '10', type: 4, name: 'TEXT', position: 0 }),
    client.rememberChannel({ id: '101', guild_id: '10', type: 0, name: 'general', parent_id: '100', position: 1 }),
  ];
  app.selectedChannelId = '101';
  app.collapsedCategories = new Set();
  app.draw();
  const categoryY = app.geo.sidebar.y + 2; // first sidebar row
  click(app, app.geo.sidebar.x + 2, categoryY);
  assert.equal(categoryCollapsed(app, '100'), true);
  click(app, app.geo.sidebar.x + 2, categoryY);
  assert.equal(categoryCollapsed(app, '100'), false);
});

test('collapsed folder and category state comes from preferences', () => {
  const client = makeClient();
  const screen = makeScreen();
  const saved = [];
  const app = new App({
    client,
    screen,
    preferences: {
      collapsedFolders: ['1929507120'],
      collapsedCategories: ['100'],
      persist: (prefs) => saved.push(prefs),
    },
  });
  assert.deepEqual([...app.collapsedFolders], ['1929507120']);
  assert.deepEqual([...app.collapsedCategories], ['100']);
  app.toggleCategory('100');
  assert.deepEqual(saved.at(-1), { collapsedFolders: ['1929507120'], collapsedCategories: [] });
});

test('rail renders folder headers, indented guilds and collapsed counts', () => {
  const { app, screen } = makeFolderApp();
  app.draw();
  let lines = screen.renderToString().split('\n');
  assert.ok(lines.some((line) => /\[-\]folder/.test(line)), 'expanded folder header');
  assert.ok(lines.some((line) => /│01 Rust Korea/.test(line)), 'guild indented inside folder');
  assert.ok(!lines.some((line) => /│03 Solo/.test(line)), 'top-level guild is not indented');

  app.collapsedFolders = new Set(['1929507120']);
  app.draw();
  lines = screen.renderToString().split('\n');
  assert.ok(lines.some((line) => /\[\+\]folder \(2\)/.test(line)), 'collapsed folder shows its guild count');
  assert.ok(!lines.some((line) => /Rust Korea/.test(line) && /│/.test(line)), 'guild rows are hidden');
});

// ------------------------------------------------------- drag selection/copy

test('mouse drag selects screen text and Ctrl+C copies it', async () => {
  const copied = [];
  const { app } = makeApp({
    copy: async (text) => {
      copied.push(text);
      return 'xclip';
    },
  });
  app.draw();
  const x = app.geo.messages.x + 3;
  const y = app.messagesView.y0;

  app.handleMouse({ action: 'press', button: 0, x, y, wheel: null, motion: false });
  app.handleMouse({ action: 'press', button: 0, x: x + 15, y: y + 2, wheel: null, motion: true });
  assert.equal(app.selection?.dragging, true);
  app.handleMouse({
    action: 'release',
    button: 0,
    x: x + 15,
    y: y + 2,
    wheel: null,
    motion: false,
  });
  assert.ok(app.selection, 'the highlight survives the release');
  assert.equal(
    app.screen.styles[y * app.screen.cols + x],
    T.selection,
    'selected cells use the highlight style',
  );

  const expected = selectionText(app.screen, app.selection, app.selectionBounds());
  assert.ok(expected.length > 0);

  app.handleKey({ key: 'c', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, [expected]);
  assert.equal(app.selection, null);
  assert.equal(app.running, true, 'the first Ctrl+C copies instead of quitting');

  // With the selection gone, the next Ctrl+C exits.
  app.handleKey({ key: 'c', ctrl: true, alt: false, shift: false });
  assert.equal(app.running, false);
});

test('a press/release without movement is still a click', () => {
  const { app } = makeApp();
  app.draw();
  const row = app.sideItems.findIndex(
    (item) => item.kind === 'channel' && item.channel.id === '102',
  );
  assert.ok(row >= 0);
  click(app, app.geo.sidebar.x + 2, app.geo.sidebar.y + 2 + row);
  assert.equal(app.selectedChannelId, '102');
  assert.equal(app.selection, null);
});

test('Escape clears a selection without quitting', () => {
  const { app } = makeApp();
  app.selection = { ax: 1, ay: 1, fx: 2, fy: 2, dragging: true };
  app.handleKey({ key: 'escape', ctrl: false, alt: false, shift: false });
  assert.equal(app.selection, null);
  assert.equal(app.running, true);
});

test('scrolling clears a stale selection', () => {
  const { app } = makeApp();
  app.draw();
  app.selection = { ax: 1, ay: 1, fx: 2, fy: 2, dragging: true };
  app.handleMouse({
    action: 'press',
    button: 0,
    x: app.geo.messages.x + 2,
    y: app.geo.messages.y + 2,
    wheel: 'up',
    motion: false,
  });
  assert.equal(app.selection, null);
});

test('Ctrl+C without a selection needs a second press to quit', () => {
  const { app } = makeApp();
  app.handleKey({ key: 'c', ctrl: true, alt: false, shift: false });
  assert.equal(app.running, true, 'the first press only arms quitting');
  assert.ok(app.toasts.some((toast) => /ctrl\+c/.test(toast.text)));
  app.handleKey({ key: 'c', ctrl: true, alt: false, shift: false });
  assert.equal(app.running, false);
});

// ------------------------------------------------------ drag-and-drop attach

async function attachFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ttycord-tui-attach-'));
  const text = join(root, 'note.txt');
  const image = join(root, 'shot.png');
  await writeFile(text, 'hello');
  await writeFile(image, Buffer.alloc(64, 2));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, text, image };
}

test('pasting a file path stages it instead of typing it', async (t) => {
  const { text } = await attachFixture(t);
  const { app, screen } = makeApp();
  app.focus = 'composer';
  app.handlePaste(text);

  const cache = app.chat('101');
  assert.equal(cache.draft, '');
  assert.equal(cache.attachments.length, 1);
  assert.equal(cache.attachments[0].path, text);
  assert.equal(cache.attachments[0].name, 'note.txt');
  assert.equal(cache.attachments[0].contentType, 'text/plain');
  assert.equal(app.focus, 'composer');
  assert.equal(app.geo.composer.height, 4, 'the composer grows by one row');

  const rendered = screen.renderToString();
  assert.match(rendered, /\[file\] note\.txt \(5B\)/);
  assert.match(rendered, /\^x detach/);
});

test('pasting a newline-separated list stages every file', async (t) => {
  const { text, image } = await attachFixture(t);
  const { app } = makeApp();
  app.focus = 'composer';
  app.handlePaste(`${text}\n${image}`);
  assert.deepEqual(
    app.chat('101').attachments.map((file) => file.name),
    ['note.txt', 'shot.png'],
  );
  assert.equal(app.geo.composer.height, 5);
});

test('ordinary pasted text still goes into the composer', async (t) => {
  const { text } = await attachFixture(t);
  const { app } = makeApp();
  app.focus = 'composer';
  app.handlePaste('그냥 텍스트입니다\n두 번째 줄');
  assert.equal(app.chat('101').attachments.length, 0);
  assert.equal(app.chat('101').draft, '그냥 텍스트입니다\n두 번째 줄');
  // A single dropped path that no longer exists is reported, not typed.
  app.handlePaste('/tmp/definitely-not-here-ttycord.png');
  assert.equal(app.chat('101').attachments.length, 0);
  app.handlePaste(text);
  assert.equal(app.chat('101').attachments.length, 1);
});

test('a multiline paste that mentions a path is still text', async (t) => {
  const { root, text } = await attachFixture(t);
  const { app } = makeApp();
  app.focus = 'composer';
  const trace = `TypeError: boom\n    at ${join(root, 'app.js')}:12:5\n    at ${text}:3:1`;
  app.handlePaste(trace);
  assert.equal(app.chat('101').attachments.length, 0);
  assert.equal(app.chat('101').draft, trace);
  assert.ok(!app.toasts.some((toast) => /not found/.test(toast.text)));

  // Plain paths with no prose are still a drop.
  app.handlePaste(`${text}\n${join(root, 'shot.png')}`);
  assert.deepEqual(
    app.chat('101').attachments.map((file) => file.name),
    ['note.txt', 'shot.png'],
  );
  assert.equal(app.chat('101').draft, trace, 'the existing draft is untouched');
});

test('Ctrl+X removes the last staged attachment', async (t) => {
  const { text, image } = await attachFixture(t);
  const { app } = makeApp();
  app.focus = 'composer';
  app.handlePaste(`${text}\n${image}`);
  assert.equal(app.chat('101').attachments.length, 2);

  app.handleKey({ key: 'x', ctrl: true, alt: false, shift: false });
  assert.deepEqual(
    app.chat('101').attachments.map((file) => file.name),
    ['note.txt'],
  );
  assert.equal(app.geo.composer.height, 4);

  app.handleKey({ key: 'x', ctrl: true, alt: false, shift: false });
  assert.equal(app.chat('101').attachments.length, 0);
  assert.equal(app.geo.composer.height, 3);
});

test('oversized and missing files are rejected with a toast', async (t) => {
  const { app } = makeApp();
  app.focus = 'composer';
  app.stageAttachments({
    files: [
      {
        path: '/tmp/big.bin',
        name: 'big.bin',
        size: MAX_ATTACHMENT_BYTES + 1,
        contentType: 'application/octet-stream',
      },
    ],
  });
  assert.equal(app.chat('101').attachments.length, 0);
  assert.ok(app.toasts.some((toast) => /too large/.test(toast.text)));

  app.handlePaste('/tmp/ttycord-missing-file.png');
  assert.equal(app.chat('101').attachments.length, 0);
  assert.ok(app.toasts.some((toast) => /not found/.test(toast.text)));
});

test('sending staged files uploads them and clears the composer', async (t) => {
  const { text } = await attachFixture(t);
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.handlePaste(text);
  app.chat('101').draft = 'hello there';
  app.chat('101').cursor = 11;

  await app.sendDraft();

  assert.equal(client.uploads.length, 1);
  const upload = client.uploads[0];
  assert.equal(upload.channelId, '101');
  assert.equal(upload.content, 'hello there');
  assert.equal(upload.files.length, 1);
  assert.equal(upload.files[0].filename, 'note.txt');
  assert.equal(upload.files[0].contentType, 'text/plain');
  assert.equal(String(upload.files[0].data), 'hello');

  const cache = app.chat('101');
  assert.equal(cache.attachments.length, 0);
  assert.equal(cache.draft, '');
  assert.equal(cache.items[cache.items.length - 1].id, '1001');
});

test('an attachment-only message is allowed', async (t) => {
  const { image } = await attachFixture(t);
  const { app, client } = makeApp();
  app.focus = 'composer';
  app.handlePaste(image);
  await app.sendDraft();

  assert.equal(client.uploads.length, 1);
  assert.equal(client.uploads[0].content, '');
  assert.equal(client.uploads[0].files[0].filename, 'shot.png');
});

test('a failed upload restores the staged files', async (t) => {
  const { text } = await attachFixture(t);
  const { app, client } = makeApp();
  client.sendMessageWithFiles = async () => {
    throw new Error('boom');
  };
  app.focus = 'composer';
  app.handlePaste(text);
  app.chat('101').draft = 'oops';
  await app.sendDraft();

  assert.deepEqual(
    app.chat('101').attachments.map((file) => file.name),
    ['note.txt'],
  );
  assert.ok(app.toasts.some((toast) => /send failed/.test(toast.text)));
});

test('a path left in the draft by a raw-character drop is uploaded on send', async (t) => {
  const { text } = await attachFixture(t);
  const { app, client } = makeApp();
  app.focus = 'composer';
  // Simulate a terminal that inserts the drop as normal characters (no
  // bracketed paste): the path just sits in the draft.
  app.chat('101').draft = text;
  app.chat('101').cursor = [...text].length;

  await app.sendDraft();

  assert.equal(client.uploads.length, 1);
  assert.equal(client.uploads[0].content, '');
  assert.equal(client.uploads[0].files[0].filename, 'note.txt');
  assert.equal(app.chat('101').draft, '');
});

test('a raw image drop outside the composer is staged immediately', async (t) => {
  const { image } = await attachFixture(t);
  const { app } = makeApp();
  app.focus = 'rail';
  // VTE and some other terminals feed a dropped path as ordinary characters.
  for (const ch of image) app.handleText(ch);
  app.flushRawDrop();

  const cache = app.chat('101');
  assert.equal(cache.draft, '');
  assert.equal(cache.attachments.length, 1);
  assert.equal(cache.attachments[0].name, 'shot.png');
  assert.equal(app.focus, 'composer');
});

test('a raw file:// drop with percent-encoded spaces still attaches', async (t) => {
  const { root } = await attachFixture(t);
  const spaced = join(root, 'my shot.png');
  await writeFile(
    spaced,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  );
  const { app } = makeApp();
  app.focus = 'composer';
  for (const ch of pathToFileURL(spaced).href) app.handleText(ch);
  app.flushRawDrop();

  assert.equal(app.chat('101').attachments.length, 1);
  assert.equal(app.chat('101').attachments[0].name, 'my shot.png');
  assert.equal(app.chat('101').attachments[0].contentType, 'image/png');
  assert.equal(app.chat('101').draft, '');
});

test('a typed slash command is not mistaken for a raw drop', async (t) => {
  const { root } = await attachFixture(t);
  const { app } = makeApp();
  app.focus = 'composer';
  for (const ch of '/help') app.handleText(ch);
  app.flushRawDrop();

  assert.equal(app.chat('101').attachments.length, 0);
  assert.equal(app.chat('101').draft, '/help');

  // A missing image path that arrived as a burst is still reported as a drop.
  const gone = join(root, 'gone.png');
  for (const ch of gone) app.handleText(ch);
  app.flushRawDrop();
  assert.equal(app.chat('101').draft, '/help');
  assert.ok(app.toasts.some((toast) => /not found/.test(toast.text)));

  // Short slash-heavy text typed quickly stays text.
  app.chat('101').draft = '';
  for (const ch of '1/2/3') app.handleText(ch);
  app.flushRawDrop();
  assert.equal(app.chat('101').draft, '1/2/3');
  assert.equal(app.chat('101').attachments.length, 0);
});

test('a raw multi-file drop does not send between paths', async (t) => {
  const { text, image } = await attachFixture(t);
  const { app, client } = makeApp();
  app.focus = 'composer';
  for (const ch of text) app.handleText(ch);
  // Newline between dropped paths arrives as a key, not text.
  app.handleKey({ key: 'enter', ctrl: true, alt: false, shift: false });
  for (const ch of image) app.handleText(ch);
  app.handleKey({ key: 'enter', ctrl: false, alt: false, shift: false });

  assert.deepEqual(
    app.chat('101').attachments.map((file) => file.name),
    ['note.txt', 'shot.png'],
  );
  assert.equal(client.uploads.length, 0, 'the drop newline must not send');
});

test('ctrl+v attaches a clipboard image and clears the temp file on send', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ttycord-clip-paste-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'clipboard-20261119-101010.png');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  await writeFile(file, png);

  const { app, client } = makeApp({
    paste: async () => ({
      kind: 'image',
      path: file,
      name: 'clipboard-20261119-101010.png',
      size: png.length,
      contentType: 'image/png',
    }),
  });
  app.focus = 'sidebar';
  app.handleKey({ key: 'v', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));

  const cache = app.chat('101');
  assert.equal(cache.attachments.length, 1);
  assert.equal(cache.attachments[0].contentType, 'image/png');
  assert.equal(app.focus, 'composer', 'a paste should focus the composer');
  assert.ok(app.clipboardFiles.has(file));

  await app.sendDraft();
  assert.equal(client.uploads.length, 1);
  assert.equal(client.uploads[0].files[0].filename, 'clipboard-20261119-101010.png');
  assert.equal(existsSync(file), false, 'the temp PNG is deleted after upload');
});

test('ctrl+v attaches files copied in a file manager', async (t) => {
  const { text } = await attachFixture(t);
  const { app } = makeApp({
    paste: async () => ({ kind: 'files', uris: [pathToFileURL(text).href] }),
  });
  app.handleKey({ key: 'v', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));

  const cache = app.chat('101');
  assert.equal(cache.attachments.length, 1);
  assert.equal(cache.attachments[0].name, 'note.txt');
});

test('ctrl+v pastes clipboard text into the composer', async () => {
  const { app } = makeApp({
    paste: async () => ({ kind: 'text', text: 'hello\r\nworld\ttab' }),
  });
  app.focus = 'rail';
  app.handleKey({ key: 'v', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.chat('101').draft, 'hello\nworld tab');
  assert.equal(app.focus, 'composer');
});

test('ctrl+v reports an empty clipboard instead of silently doing nothing', async () => {
  const { app } = makeApp({ paste: async () => ({ kind: 'none' }) });
  app.focus = 'composer';
  app.handleKey({ key: 'v', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.chat('101').attachments.length, 0);
  assert.ok(app.toasts.some((toast) => /no image or file/.test(toast.text)));
});

test('ctrl+v closes the help overlay instead of reading the clipboard', async () => {
  let reads = 0;
  const { app } = makeApp({
    paste: async () => {
      reads += 1;
      return { kind: 'none' };
    },
  });
  app.help = true;
  app.handleKey({ key: 'v', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.help, false);
  assert.equal(reads, 0);
});

test('removing a clipboard attachment deletes its temp file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ttycord-clip-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'clipboard-20261119-101010.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const { app } = makeApp({
    paste: async () => ({
      kind: 'image',
      path: file,
      name: 'clipboard-20261119-101010.png',
      size: 8,
      contentType: 'image/png',
    }),
  });
  app.handleKey({ key: 'v', ctrl: true, alt: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.chat('101').attachments.length, 1);

  app.handleKey({ key: 'x', ctrl: true, alt: false, shift: false });
  assert.equal(app.chat('101').attachments.length, 0);
  assert.equal(existsSync(file), false);
});

test('drag highlight follows lines instead of forming a rectangle', () => {
  const { app } = makeApp();
  app.draw();
  const cols = app.screen.cols;
  const x = app.geo.messages.x + 10;
  const y0 = app.messagesView.y0;
  const y1 = y0 + 2;

  app.handleMouse({ action: 'press', button: 0, x, y: y0, wheel: null, motion: false });
  app.handleMouse({ action: 'press', button: 0, x: x + 5, y: y1, wheel: null, motion: true });
  app.handleMouse({ action: 'release', button: 0, x: x + 5, y: y1, wheel: null, motion: false });

  const at = (xx, yy) => app.screen.styles[yy * cols + xx];
  const left = app.geo.messages.x;
  const right = left + app.geo.messages.width - 1;
  // First line: anchor -> right edge of the message pane.
  assert.notEqual(at(x - 1, y0), T.selection);
  assert.equal(at(x, y0), T.selection);
  assert.equal(at(right, y0), T.selection);
  // Middle line: the whole message pane, but not the rail/sidebar.
  assert.equal(at(left, y0 + 1), T.selection);
  assert.equal(at(right, y0 + 1), T.selection);
  assert.notEqual(at(left - 1, y0 + 1), T.selection);
  // Last line: pane left edge -> focus column, and no further.
  assert.equal(at(left, y1), T.selection);
  assert.equal(at(x + 5, y1), T.selection);
  assert.notEqual(at(x + 6, y1), T.selection);
});

// ------------------------------------------------------------- mentions
test('typing @ opens a menu and Enter inserts real mention syntax', () => {
  const { app, client } = makeApp();
  client.rememberUser({ id: '2', username: 'alice', global_name: 'Alice' });
  app.focus = 'composer';

  app.handleText('@');
  app.handleText('a');
  app.handleText('l');
  const state = app.mentionState();
  assert.ok(state, 'menu is open while the cursor is in @al');
  assert.equal(state.items[0].id, '2');
  app.draw();
  assert.ok(app.mentionMenu, 'menu is drawn');

  app.handleKey({ key: 'enter', ctrl: false, shift: false });
  const cache = app.chat('101');
  assert.equal(cache.draft, '<@2> ');
  assert.equal(cache.cursor, 5);
  assert.equal(client.sent.length, 0, 'accepting a mention must not send the message');
});

test('typing # inserts a channel mention', () => {
  const { app } = makeApp();
  app.focus = 'composer';
  app.handleText('#');
  app.handleText('d');
  app.handleText('e');

  app.handleKey({ key: 'enter', ctrl: false, shift: false });
  assert.equal(app.chat('101').draft, '<#102> ');
});

test('escape closes the mention menu but keeps composer focus', () => {
  const { app, client } = makeApp();
  client.rememberUser({ id: '2', username: 'alice' });
  app.focus = 'composer';
  app.handleText('@');
  assert.ok(app.mentionState());

  app.handleKey({ key: 'escape', ctrl: false, shift: false });
  assert.equal(app.mentionState(), null);
  assert.equal(app.focus, 'composer');

  app.handleText('a');
  assert.ok(app.mentionState(), 'typing again reopens the menu');
});

test('arrow keys move the mention selection', () => {
  const { app, client } = makeApp();
  client.rememberUser({ id: '2', username: 'alice' });
  client.rememberUser({ id: '3', username: 'bob' });
  // Drop the canned message so the empty-@ list is not restricted to its author.
  const cache = app.chat('101');
  cache.items = [];
  cache.byId = new Map();
  app.focus = 'composer';
  app.handleText('@');

  app.handleKey({ key: 'down', ctrl: false, shift: false });
  app.handleKey({ key: 'enter', ctrl: false, shift: false });
  assert.equal(app.chat('101').draft, '<@3> ');
});

test('clicking a mention candidate inserts it', () => {
  const { app, client } = makeApp();
  client.rememberUser({ id: '2', username: 'alice' });
  app.focus = 'composer';
  app.handleText('@');
  app.draw();

  const menu = app.mentionMenu;
  assert.ok(menu);
  click(app, menu.x + 4, menu.rows[0]);
  assert.equal(app.chat('101').draft, '<@2> ');
});

test('a message with an accepted mention is sent with real mention syntax', async () => {
  const { app, client } = makeApp();
  client.rememberUser({ id: '2', username: 'alice' });
  app.focus = 'composer';
  for (const ch of 'hi @a') app.handleText(ch);
  app.handleKey({ key: 'enter', ctrl: false, shift: false });
  assert.equal(app.chat('101').draft, 'hi <@2> ');

  await app.sendDraft();
  assert.equal(client.sent.at(-1).content, 'hi <@2>');
});

// ------------------------------------------------------- last view restore
function makeRestoreApp({ lastView = null, saved = [] } = {}) {
  const client = makeClient();
  const screen = makeScreen();
  const app = new App({
    client,
    screen,
    preferences: {
      lastView,
      persist: (patch) => saved.push(patch),
    },
  });
  app.running = true;
  const guild = normalizeGuild({ id: '10', name: 'Rust Korea' });
  guild.channels = [
    client.rememberChannel({ id: '101', guild_id: '10', type: 0, name: 'general', position: 0 }),
    client.rememberChannel({ id: '102', guild_id: '10', type: 0, name: 'dev', position: 1 }),
  ];
  app.guilds = [guild];
  const dm = client.rememberChannel({
    id: '900',
    type: 1,
    recipients: [{ id: '2', username: 'friend' }],
  });
  app.dms = [dm];
  return { app, client, screen, saved };
}

test('last view restores the saved guild and channel', async () => {
  const { app } = makeRestoreApp({
    lastView: { guildId: '10', channelId: '102', dm: false, wide: true },
  });
  await app.bootstrapSelection();
  assert.equal(app.selectedGuildId, '10');
  assert.equal(app.selectedChannelId, '102');
  assert.equal(app.wide, true);
});

test('last view restores a DM and leaves guild context', async () => {
  const { app } = makeRestoreApp({
    lastView: { guildId: '', channelId: '900', dm: true, wide: false },
  });
  app.selectedGuildId = '10';
  await app.bootstrapSelection();
  assert.equal(app.selectedGuildId, null);
  assert.equal(app.selectedChannelId, '900');
  assert.equal(app.railIndex, 0);
});

test('opening a DM clears the guild context so it is saved as a DM', async () => {
  const { app } = makeRestoreApp();
  app.selectedGuildId = '10';
  app.selectedChannelId = '101';
  await app.openChannel('900');
  assert.equal(app.selectedGuildId, null);
  assert.equal(app.railIndex, 0);
});

test('last view falls back to the first guild when the saved guild is gone', async () => {
  const { app } = makeRestoreApp({
    lastView: { guildId: '999', channelId: '998', dm: false, wide: false },
  });
  await app.bootstrapSelection();
  assert.equal(app.selectedGuildId, '10');
  assert.equal(app.selectedChannelId, '101');
});

test('last view falls back to the first channel when the saved channel is gone', async () => {
  const { app } = makeRestoreApp({
    lastView: { guildId: '10', channelId: '404', dm: false, wide: false },
  });
  await app.bootstrapSelection();
  assert.equal(app.selectedGuildId, '10');
  assert.equal(app.selectedChannelId, '101');
});

test('quitting saves the current guild channel and wide mode', () => {
  const { app, saved } = makeRestoreApp();
  app.selectedGuildId = '10';
  app.selectedChannelId = '102';
  app.wide = true;
  app.quit();
  assert.deepEqual(saved.at(-1), {
    lastView: { guildId: '10', channelId: '102', dm: false, wide: true },
    lastChannels: {},
  });
});

test('quitting on a DM saves it as a DM view', () => {
  const { app, saved } = makeRestoreApp();
  app.selectedGuildId = null;
  app.selectedChannelId = '900';
  app.quit();
  assert.deepEqual(saved.at(-1), {
    lastView: { guildId: '', channelId: '900', dm: true, wide: false },
    lastChannels: {},
  });
});

test('quitting before anything is selected keeps the previous view', () => {
  const { app, saved } = makeRestoreApp();
  app.selectedGuildId = null;
  app.selectedChannelId = null;
  app.quit();
  assert.deepEqual(saved, []);
});

test('quitting in split view saves the panes and focused pane', () => {
  const { app, saved } = makeRestoreApp();
  app.selectedGuildId = '10';
  app.selectedChannelId = '102';
  app.splitMode = true;
  app.panes = ['101', '102', '900'];
  app.paneIndex = 1;
  app.quit();
  assert.deepEqual(saved.at(-1).lastView, {
    guildId: '10',
    channelId: '102',
    dm: false,
    wide: false,
    split: { enabled: true, panes: ['101', '102', '900'], focus: 1 },
  });
});

test('restoring split view fetches only the focused pane at startup', async () => {
  const { app, client } = makeRestoreApp({
    lastView: {
      guildId: '10',
      channelId: '102',
      dm: false,
      wide: false,
      split: { enabled: true, panes: ['101', '102'], focus: 1 },
    },
  });
  await app.bootstrapSelection();
  assert.equal(app.splitMode, true);
  assert.deepEqual(app.panes, ['101', '102']);
  assert.equal(app.activePaneIndex(), 1);
  assert.equal(app.selectedChannelId, '102');
  // One channel-open fetch for the focused pane, none for the other pane.
  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['102'],
  );
  assert.equal(app.chat('102').loaded, true);
  assert.equal(app.chat('101').loaded, false);
});

test('focusing an unresolved restored pane resolves just that pane', async () => {
  const { app, client } = makeRestoreApp({
    lastView: {
      guildId: '10',
      channelId: '102',
      dm: false,
      wide: false,
      split: { enabled: true, panes: ['101', '102', '201'], focus: 1 },
    },
  });
  const other = normalizeGuild({ id: '20', name: 'Other' });
  other.channels = [];
  app.guilds.push(other);
  // Pretend the channel arrived only through the saved split, not the caches.
  client.channels.delete('201');
  client.fetchChannel = async (id) => {
    client.channelFetches.push(String(id));
    return client.rememberChannel({ id: String(id), guild_id: '20', type: 0, name: 'lounge' });
  };

  await app.bootstrapSelection();
  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['102'],
  );
  // The unfocused guild's channel list is not loaded at startup either.
  assert.deepEqual(client.channelLoads, []);
  assert.equal(app.channelById('201'), null);

  await app.focusPane(2);
  assert.deepEqual(client.channelFetches, ['201']);
  assert.deepEqual(client.channelLoads, ['20']);
  assert.equal(app.selectedGuildId, '20');
  assert.equal(app.selectedChannelId, '201');
  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['102', '201'],
  );
});

test('switching servers returns to the last channel read in each one', async () => {
  const client = makeClient();
  const screen = makeScreen();
  const app = new App({ client, screen });
  app.running = true;
  const guildA = normalizeGuild({ id: '10', name: 'A' });
  guildA.channels = [
    client.rememberChannel({ id: '101', guild_id: '10', type: 0, name: 'general', position: 0 }),
    client.rememberChannel({ id: '102', guild_id: '10', type: 0, name: 'dev', position: 1 }),
  ];
  const guildB = normalizeGuild({ id: '20', name: 'B' });
  guildB.channels = [
    client.rememberChannel({ id: '201', guild_id: '20', type: 0, name: 'lobby', position: 0 }),
    client.rememberChannel({ id: '202', guild_id: '20', type: 0, name: 'random', position: 1 }),
  ];
  app.guilds = [guildA, guildB];
  app.dms = [];
  // No network sleeps in this test: the message caches are already "loaded".
  for (const id of ['101', '102', '201', '202']) app.chat(id).loaded = true;

  await app.selectGuild('10');
  await app.openChannel('102');
  await app.selectGuild('20');
  await app.openChannel('202');

  await app.selectGuild('10');
  assert.equal(app.selectedGuildId, '10');
  assert.equal(app.selectedChannelId, '102');
  await app.selectGuild('20');
  assert.equal(app.selectedGuildId, '20');
  assert.equal(app.selectedChannelId, '202');
});

test('a remembered channel from preferences wins over the first channel', async () => {
  const client = makeClient();
  const screen = makeScreen();
  const app = new App({
    client,
    screen,
    preferences: { lastChannels: { 20: '202' } },
  });
  app.running = true;
  const guild = normalizeGuild({ id: '20', name: 'B' });
  guild.channels = [
    client.rememberChannel({ id: '201', guild_id: '20', type: 0, name: 'lobby', position: 0 }),
    client.rememberChannel({ id: '202', guild_id: '20', type: 0, name: 'random', position: 1 }),
  ];
  app.guilds = [guild];
  app.dms = [];
  app.chat('201').loaded = true;
  app.chat('202').loaded = true;

  await app.selectGuild('20');
  assert.equal(app.selectedChannelId, '202');
});

test('a deleted remembered channel falls back to the first visible channel', async () => {
  const client = makeClient();
  const screen = makeScreen();
  const app = new App({ client, screen, preferences: { lastChannels: { 20: '999' } } });
  app.running = true;
  const guild = normalizeGuild({ id: '20', name: 'B' });
  guild.channels = [
    client.rememberChannel({ id: '201', guild_id: '20', type: 0, name: 'lobby', position: 0 }),
  ];
  app.guilds = [guild];
  app.dms = [];
  app.chat('201').loaded = true;

  await app.selectGuild('20');
  assert.equal(app.selectedChannelId, '201');
});

test('rapid guild switching keeps the newest selection', async () => {
  const client = makeClient();
  const screen = makeScreen();
  const app = new App({ client, screen });
  app.running = true;
  const guildA = normalizeGuild({ id: '10', name: 'A' });
  const guildB = normalizeGuild({ id: '20', name: 'B' });
  guildB.channels = [
    client.rememberChannel({ id: '201', guild_id: '20', type: 0, name: 'lobby', position: 0 }),
  ];
  app.guilds = [guildA, guildB];
  app.dms = [];
  app.chat('201').loaded = true;

  let releaseA;
  client.loadChannels = (guildId) => {
    if (String(guildId) === '10') {
      return new Promise((resolve) => {
        releaseA = () =>
          resolve([
            client.rememberChannel({ id: '101', guild_id: '10', type: 0, name: 'general' }),
          ]);
      });
    }
    return Promise.resolve(guildB.channels);
  };

  const first = app.selectGuild('10');
  const second = app.selectGuild('20');
  await second;
  assert.equal(app.selectedGuildId, '20');
  assert.equal(app.selectedChannelId, '201');

  releaseA();
  await first;
  // The slow first selection must not steal the view back.
  assert.equal(app.selectedGuildId, '20');
  assert.equal(app.selectedChannelId, '201');
});

test('saving the view persists per-guild channel memory', () => {
  const { app, saved } = makeRestoreApp();
  app.lastChannelByGuild.set('10', '102');
  app.lastChannelByGuild.set('20', '202');
  app.selectedGuildId = '10';
  app.selectedChannelId = '102';
  app.quit();
  assert.deepEqual(saved.at(-1).lastChannels, { 10: '102', 20: '202' });
});

// ----------------------------------------------------------------- split view

/** Give `id` a cache that is already loaded so opening it never waits. */
function markLoaded(app, ids) {
  for (const id of ids) app.chat(id).loaded = true;
}

/** Enough rows that the message log can actually scroll. */
function seedMessages(app, channelId, count = 60) {
  const cache = app.chat(channelId);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push({
      id: String(5000 + index),
      channel_id: String(channelId),
      type: 0,
      author: { id: '2', username: 'mira', global_name: '미라' },
      content: `line ${index}`,
      timestamp: new Date(Date.now() + index * 1000).toISOString(),
    });
  }
  cache.items = items;
  cache.byId = new Map(items.map((message) => [message.id, message]));
  cache.version += 1;
  cache.layout = null;
  cache.loaded = true;
}

test('split view opens a second column and mirrors the focused channel', async () => {
  const { app, screen } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102']);
  app.draw();
  assert.equal(app.geo.panes.length, 1);

  app.handleText('s');
  assert.equal(app.splitMode, true);
  assert.deepEqual(app.panes, ['101']);

  await app.openChannel('102', { focus: false });
  assert.deepEqual(app.panes, ['101', '102']);
  assert.equal(app.selectedChannelId, '102');
  assert.equal(app.activePaneIndex(), 1);

  app.draw();
  assert.equal(app.geo.panes.length, 2);
  const rendered = screen.renderToString();
  assert.match(rendered, /general/);
  assert.match(rendered, /dev/);
  // Both columns are narrower than the full chat area but still readable.
  assert.ok(app.geo.panes[0].chat.width < app.geo.cols);

  // Turning split off keeps the focused column.
  app.handleText('s');
  assert.equal(app.splitMode, false);
  assert.deepEqual(app.panes, ['102']);
  assert.equal(app.selectedChannelId, '102');
});

test('opening a fifth channel replaces the focused pane', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102', '103', '104', '105']);
  app.handleText('s');
  await app.openChannel('102');
  await app.openChannel('103');
  await app.openChannel('104');
  assert.deepEqual(app.panes, ['101', '102', '103', '104']);

  app.focusPane(1);
  await app.openChannel('105');
  assert.deepEqual(app.panes, ['101', '105', '103', '104']);
  assert.equal(app.paneIndex, 1);
  assert.equal(app.selectedChannelId, '105');
});

test('closing a pane keeps the remaining columns and focuses a neighbour', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102', '103']);
  app.handleText('s');
  await app.openChannel('102');
  await app.openChannel('103');
  app.focusPane(1);
  assert.equal(app.selectedChannelId, '102');

  app.handleKey({ key: 'w', ctrl: true, alt: false, shift: false });
  assert.deepEqual(app.panes, ['101', '103']);
  assert.equal(app.selectedChannelId, '103');
  assert.equal(app.activePaneIndex(), 1);

  // The last column cannot be closed; split view is turned off with `s`.
  app.handleKey({ key: 'w', ctrl: true, alt: false, shift: false });
  assert.deepEqual(app.panes, ['101']);
  app.handleKey({ key: 'w', ctrl: true, alt: false, shift: false });
  assert.deepEqual(app.panes, ['101']);
});

test('Ctrl+Left/Right and 1-4 move focus between split panes', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102', '103']);
  app.handleText('s');
  await app.openChannel('102');
  await app.openChannel('103');
  assert.equal(app.activePaneIndex(), 2);

  app.handleKey({ key: 'left', ctrl: true, alt: false, shift: false });
  assert.equal(app.activePaneIndex(), 1);
  assert.equal(app.selectedChannelId, '102');
  app.handleKey({ key: 'right', ctrl: true, alt: false, shift: false });
  assert.equal(app.activePaneIndex(), 2);
  assert.equal(app.selectedChannelId, '103');

  app.handleText('1');
  assert.equal(app.activePaneIndex(), 0);
  assert.equal(app.selectedChannelId, '101');
});

test('clicking a split column focuses it and its composer', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102']);
  app.handleText('s');
  await app.openChannel('102');
  app.draw();

  const first = app.geo.panes[0];
  click(app, first.messages.x + 2, first.messages.y + 1);
  assert.equal(app.activePaneIndex(), 0);
  assert.equal(app.selectedChannelId, '101');

  const second = app.geo.panes[1];
  click(app, second.composer.x + 2, second.composer.y + 1);
  assert.equal(app.activePaneIndex(), 1);
  assert.equal(app.selectedChannelId, '102');
  assert.equal(app.focus, 'composer');
});

test('four-pane split renders a 2x2 grid and focuses the bottom row', async () => {
  const { app, screen } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102', '103', '104']);
  app.handleText('s');
  await app.openChannel('102');
  await app.openChannel('103');
  await app.openChannel('104');
  app.draw();

  assert.equal(app.geo.panes.length, 4);
  assert.equal(app.geo.panes[0].chat.y, app.geo.panes[1].chat.y);
  assert.equal(app.geo.panes[2].chat.y, app.geo.panes[3].chat.y);
  assert.ok(app.geo.panes[2].chat.y > app.geo.panes[0].chat.y);

  // The row rule crosses the column rule at a junction.
  const junction = app.geo.dividers.horizontal[0].junctions[0];
  const y = app.geo.dividers.horizontal[0].y;
  assert.equal(screen.chars[y * screen.cols + junction], '┼');

  const fourth = app.geo.panes[3];
  click(app, fourth.messages.x + 2, fourth.messages.y + 1);
  assert.equal(app.activePaneIndex(), 3);
  assert.equal(app.selectedChannelId, '104');
});

test('the wheel scrolls the column under the pointer', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102']);
  seedMessages(app, '101');
  app.handleText('s');
  await app.openChannel('102');
  app.draw();
  assert.equal(app.activePaneIndex(), 1);
  assert.equal(app.chat('101').scroll, 0);

  const first = app.geo.panes[0];
  app.handleMouse({
    action: 'press',
    button: 0,
    x: first.messages.x + 2,
    y: first.messages.y + 2,
    wheel: 'up',
    motion: false,
  });
  assert.equal(app.activePaneIndex(), 0);
  assert.equal(app.selectedChannelId, '101');
  assert.ok(app.chat('101').scroll > 0);
  assert.equal(app.chat('102').scroll, 0);
});

test('a drag selection stays inside the pane where it started', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102']);
  app.handleText('s');
  await app.openChannel('102');
  app.draw();

  const first = app.geo.panes[0];
  const second = app.geo.panes[1];
  app.handleMouse({
    action: 'press',
    button: 0,
    x: first.messages.x + 1,
    y: first.messages.y,
    wheel: null,
    motion: false,
  });
  app.handleMouse({
    action: 'press',
    button: 0,
    x: second.messages.x + 5,
    y: second.messages.y + 3,
    wheel: null,
    motion: true,
  });
  const bounds = app.selectionBounds();
  assert.equal(bounds.left, first.messages.x);
  assert.equal(bounds.right, first.messages.x + first.messages.width - 1);
  assert.equal(bounds.top, first.messages.y);
  assert.equal(bounds.bottom, first.messages.y + first.messages.height - 1);
});

test('a live message acks any visible pane that is at the bottom', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102']);
  app.handleText('s');
  await app.openChannel('102');
  app.chat('101').scroll = 0;

  app.onLiveMessage({
    channelId: '101',
    message: {
      id: '7000',
      channel_id: '101',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: 'while watching the other pane',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(app.readStates.get('101')?.lastMessageId, '7000');
  assert.equal(app.unread.has('101'), false);

  // A hidden channel still counts as unread.
  app.onLiveMessage({
    channelId: '999',
    message: {
      id: '7001',
      channel_id: '999',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: 'elsewhere',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(app.unread.get('999')?.count, 1);
});

test('split panes share the tallest composer so baselines line up', async () => {
  const { app } = makeApp({ cols: 160, rows: 40 });
  markLoaded(app, ['102']);
  app.handleText('s');
  await app.openChannel('102');

  const cache = app.chat('101');
  cache.draft = 'one\ntwo\nthree';
  cache.cursor = 0;
  app.draw();

  assert.deepEqual(app.geo.panes.map((pane) => pane.composer.height), [5, 5]);
  assert.equal(app.geo.panes[0].composer.y, app.geo.panes[1].composer.y);
  assert.equal(app.geo.composer.height, 5);
});

test('clicking a guild row in the rail opens that guild, not DM home', () => {
  const { app } = makeFolderApp();
  app.draw();
  // list row 0 = folder header, row 1 = Rust Korea, row 2 = VRChat.
  click(app, app.geo.rail.x + 3, app.geo.rail.y + 5);
  assert.equal(app.selectedGuildId, '20');
  assert.notEqual(app.selectedGuildId, null);
});

test('a guild channel without guild_id keeps the guild context', async () => {
  const { app } = makeApp();
  const guild = app.guilds[0];
  guild.channels.push(
    app.client.rememberChannel({ id: '103', type: 0, name: 'no-guild-id', position: 2 }),
  );
  app.selectedGuildId = '10';
  await app.openChannel('103');
  assert.equal(app.selectedGuildId, '10');
  assert.equal(app.railIndex, 1);
  assert.equal(app.channelGuildId(app.channelById('103')), '10');
});

// ------------------------------------------------------ message actions
function ownMessage(app) {
  const cache = app.chat('101');
  cache.items[0].author = { id: '1', username: 'me', global_name: 'Me' };
  return cache;
}

function secondMessage(app) {
  const cache = app.chat('101');
  const message = {
    id: '901',
    channel_id: '101',
    type: 0,
    author: { id: '2', username: 'mira', global_name: '미라' },
    content: '두 번째',
    timestamp: new Date().toISOString(),
  };
  cache.items.push(message);
  cache.byId.set(message.id, message);
  return cache;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('clicking a message selects it for the action keys', () => {
  const { app } = makeApp();
  app.draw();
  const view = app.messagesViews[0];
  const span = view.spans.find((entry) => entry.id === '900');
  const y = view.y0 + (span.start - view.start);
  click(app, app.geo.messages.x + 10, y);

  assert.equal(app.focus, 'messages');
  assert.equal(app.chat('101').cursorId, '900');
});

test('the message cursor is highlighted and marked in the gutter', () => {
  const { app, screen } = makeApp();
  app.draw();
  app.enterMessageMode('900');
  const view = app.messagesViews[0];
  const span = view.spans.find((entry) => entry.id === '900');
  const y = view.y0 + (span.start - view.start);
  const base = y * screen.cols + app.geo.messages.x;

  assert.equal(screen.chars[base], '▌');
  assert.equal(screen.styles[base + 2], T.msgCursor);
});

test('j / k move the message cursor and clamp at the ends', () => {
  const { app } = makeApp();
  const cache = secondMessage(app);
  app.draw();
  app.enterMessageMode('900');

  app.handleMessageText('j');
  assert.equal(cache.cursorId, '901');
  app.handleMessageText('j');
  assert.equal(cache.cursorId, '901', 'stays on the newest message');
  app.handleMessageText('k');
  assert.equal(cache.cursorId, '900');
  app.handleMessageText('g');
  assert.equal(cache.cursorId, '900');
  app.handleMessageText('G');
  assert.equal(cache.cursorId, '901');
});

test('quick reaction adds and removes our own reaction', async () => {
  const { app, client, screen } = makeApp();
  app.draw();
  app.enterMessageMode('900');
  app.handleMessageText('r');
  assert.ok(app.reactMode);
  app.handleReactText('1');
  await tick();

  const message = app.chat('101').byId.get('900');
  assert.deepEqual(
    message.reactions.map((entry) => [entry.emoji.name, entry.count, entry.me]),
    [['👍', 1, true]],
  );
  assert.equal(client.reactions[0].op, 'add');
  assert.equal(client.reactions[0].emoji, '👍');

  app.draw();
  assert.match(screen.renderToString(), /👍 1/);

  // Pressing the same key again toggles it off.
  app.handleMessageText('r');
  app.handleReactText('1');
  await tick();
  assert.equal(app.chat('101').byId.get('900').reactions.length, 0);
  assert.equal(client.reactions[1].op, 'remove');
});

test('a shortcode typed in the reaction bar resolves to an emoji', async () => {
  const { app, client } = makeApp();
  app.enterMessageMode('900');
  app.handleMessageText('r');
  for (const ch of 'fire') app.handleReactText(ch);
  app.handleReactKey({ key: 'enter', ctrl: false, alt: false, shift: false });
  await tick();

  assert.equal(client.reactions[0].emoji, '🔥');
  assert.equal(app.chat('101').byId.get('900').reactions[0].emoji.name, '🔥');
});

test('live reactions keep counts and the me flag in sync', () => {
  const { app } = makeApp();
  const message = app.chat('101').byId.get('900');
  message.reactions = [{ emoji: { name: '🔥' }, count: 1, me: true }];

  app.onReaction({ type: 'add', channelId: '101', messageId: '900', userId: '2', emoji: { name: '🔥' } });
  assert.equal(message.reactions[0].count, 2);
  assert.equal(message.reactions[0].me, true);

  app.onReaction({ type: 'remove', channelId: '101', messageId: '900', userId: '1', emoji: { name: '🔥' } });
  assert.equal(message.reactions[0].count, 1);
  assert.equal(message.reactions[0].me, false);

  app.onReaction({ type: 'remove_all', channelId: '101', messageId: '900', userId: '', emoji: null });
  assert.deepEqual(message.reactions, []);
});

test('reply sends message_reference and shows a banner', async () => {
  const { app, client, screen } = makeApp();
  app.draw();
  const before = app.geo.composer.height;
  app.enterMessageMode('900');
  app.handleMessageText('R');

  assert.equal(app.focus, 'composer');
  assert.equal(app.chat('101').replyTo.id, '900');
  app.draw();
  assert.equal(app.geo.composer.height, before + 1, 'banner row is reserved');
  assert.match(screen.renderToString(), />>/);

  app.insertText('답장입니다');
  await app.sendDraft();
  assert.equal(client.sendOptions[0].replyTo, '900');
  assert.equal(app.chat('101').replyTo, null);
});

test('escape cancels a pending reply', () => {
  const { app } = makeApp();
  app.chat('101').replyTo = app.chat('101').byId.get('900');
  app.focus = 'composer';
  app.draw();

  app.handleKey({ key: 'escape', ctrl: false, alt: false, shift: false });
  assert.equal(app.chat('101').replyTo, null);
  assert.equal(app.focus, 'composer', 'the first escape only cancels the reply');
});

test('editing preloads the composer and patches the message', async () => {
  const { app, client } = makeApp();
  const cache = ownMessage(app);
  app.draw();
  app.enterMessageMode('900');
  app.handleMessageText('e');

  assert.equal(cache.editingId, '900');
  assert.equal(cache.draft, '안녕하세요');
  assert.equal(app.focus, 'composer');

  cache.draft = '수정됨';
  cache.cursor = 3;
  await app.sendDraft();

  assert.equal(client.edits.length, 1);
  assert.equal(client.edits[0].content, '수정됨');
  assert.equal(cache.editingId, null);
  assert.equal(cache.draft, '');
});

test('escape cancels an edit and restores the previous draft', () => {
  const { app } = makeApp();
  const cache = ownMessage(app);
  cache.draft = '원래 초안';
  cache.cursor = 5;
  app.draw();
  app.enterMessageMode('900');
  app.handleMessageText('e');
  assert.equal(cache.draft, '안녕하세요');

  app.handleKey({ key: 'escape', ctrl: false, alt: false, shift: false });
  assert.equal(cache.editingId, null);
  assert.equal(cache.draft, '원래 초안');
});

test('editing someone else\'s message is refused', () => {
  const { app } = makeApp();
  app.draw();
  app.enterMessageMode('900');
  app.handleMessageText('e');

  assert.equal(app.chat('101').editingId, null);
  assert.ok(app.toasts.some((toast) => /only edit your own/.test(toast.text)));
});

test('deleting needs two presses and removes the message', async () => {
  const { app, client } = makeApp();
  const cache = ownMessage(app);
  app.draw();
  app.enterMessageMode('900');

  app.handleMessageText('d');
  assert.equal(cache.items.length, 1, 'the first press only arms');
  app.handleMessageText('d');
  await tick();

  assert.equal(client.deletions.length, 1);
  assert.equal(client.deletions[0].messageId, '900');
  assert.equal(cache.items.length, 0);
  assert.equal(cache.cursorId, null);
});

test('y copies a discord message link', async () => {
  const copied = [];
  const { app } = makeApp({
    copy: async (text) => {
      copied.push(text);
      return 'wl-copy';
    },
  });
  app.enterMessageMode('900');
  app.handleMessageText('y');
  await tick();

  assert.equal(copied[0], 'https://discord.com/channels/10/101/900');
});

// ------------------------------------------------------------ notifications
function fakeOut() {
  const writes = [];
  return {
    writes,
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk));
    },
  };
}

test('bell mode defaults to mention and honours TTYCORD_BELL', () => {
  const previous = process.env.TTYCORD_BELL;
  try {
    delete process.env.TTYCORD_BELL;
    assert.equal(makeApp().app.bellMode, 'mention');
    process.env.TTYCORD_BELL = 'off';
    assert.equal(makeApp().app.bellMode, 'off');
    process.env.TTYCORD_BELL = 'all';
    assert.equal(makeApp().app.bellMode, 'all');
    process.env.TTYCORD_BELL = 'nonsense';
    assert.equal(makeApp().app.bellMode, 'mention');
  } finally {
    if (previous === undefined) delete process.env.TTYCORD_BELL;
    else process.env.TTYCORD_BELL = previous;
  }
});

test('the terminal title shows mentions only', () => {
  const out = fakeOut();
  const { app } = makeApp({ out });
  app.draw();
  assert.equal(out.writes.at(-1), '\x1b]0;ttycord\x07');

  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '950',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '조용한 소식',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(app.title, 'ttycord', 'plain unread does not change the title');
  assert.equal(out.writes.at(-1), '\x1b]0;ttycord\x07');

  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '951',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '<@1> 확인해줘',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(app.title, 'ttycord !1');
  assert.equal(out.writes.at(-1), '\x1b]0;ttycord !1\x07');
});

test('the bell rings for mentions only by default', () => {
  const out = fakeOut();
  const { app } = makeApp({ out });
  app.bellMode = 'mention';
  app.draw();
  out.writes.length = 0;

  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '960',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '그냥 잡담',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 0);

  app.lastBellAt = 0;
  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '961',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '<@1> 봐줘',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);

  // The cooldown suppresses a second ring within the window.
  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '962',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '<@1> 또 봐줘',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);
});

test('bell mode all rings for any unseen message and off stays silent', () => {
  const out = fakeOut();
  const { app } = makeApp({ out });
  app.bellMode = 'all';
  app.draw();
  out.writes.length = 0;

  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '970',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '아무 말',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);

  app.bellMode = 'off';
  app.lastBellAt = 0;
  app.onLiveMessage({
    channelId: '102',
    message: {
      id: '971',
      channel_id: '102',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '<@1> 조용히',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);
});

function guildSettings(level, channelId, override) {
  return new Map([
    [
      '10',
      {
        level,
        muted: false,
        channels: override ? new Map([[channelId, override]]) : new Map(),
      },
    ],
  ]);
}

function unseen(app, id, content, channelId = '102') {
  app.lastBellAt = 0;
  app.onLiveMessage({
    channelId,
    message: {
      id,
      channel_id: channelId,
      type: 0,
      author: { id: '2', username: 'mira' },
      content,
      timestamp: new Date().toISOString(),
    },
  });
}

test('a channel set to all notifications plays the sound for any message', () => {
  const out = fakeOut();
  const sounds = [];
  const { app } = makeApp({
    out,
    sound: () => {
      sounds.push('play');
      return 'play';
    },
  });
  app.guildSettings = guildSettings(1, '102', { level: 0, muted: false });
  app.draw();
  out.writes.length = 0;

  unseen(app, '980', '그냥 잡담');
  assert.equal(sounds.length, 1);
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 0, 'no terminal bell when audio played');
});

test('a mentions-only channel stays quiet for ordinary messages', () => {
  const sounds = [];
  const { app } = makeApp({
    sound: () => {
      sounds.push('play');
      return 'play';
    },
  });
  app.guildSettings = guildSettings(1, '102', { level: 1, muted: false });

  unseen(app, '981', '그냥 잡담');
  assert.equal(sounds.length, 0);

  unseen(app, '982', '<@1> 확인해줘');
  assert.equal(sounds.length, 1);
});

test('muted or nothing channels stay silent even on a mention', () => {
  const sounds = [];
  const { app } = makeApp({
    sound: () => {
      sounds.push('play');
      return 'play';
    },
  });

  app.guildSettings = guildSettings(1, '102', { level: 2, muted: false });
  unseen(app, '983', '<@1> 조용히');
  assert.equal(sounds.length, 0);

  app.guildSettings = guildSettings(1, '102', { level: 3, muted: true });
  unseen(app, '984', '<@1> 또 조용히');
  assert.equal(sounds.length, 0);
});

test('a channel override inherits the guild mute when muted is null', () => {
  const sounds = [];
  const { app } = makeApp({
    sound: () => {
      sounds.push('play');
      return 'play';
    },
  });
  app.guildSettings = new Map([
    ['10', { level: 0, muted: true, channels: new Map([['102', { level: 3, muted: null }]]) }],
  ]);
  unseen(app, '985', '<@1> 뮤트');
  assert.equal(sounds.length, 0);
});

test('without Discord settings the TTYCORD_BELL policy still applies', () => {
  const out = fakeOut();
  const { app } = makeApp({ out });
  app.bellMode = 'mention';
  app.guildSettings = new Map();
  app.draw();
  out.writes.length = 0;

  unseen(app, '986', '그냥 잡담');
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 0);

  unseen(app, '987', '<@1> 봐줘');
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);
});

test('a player fallback writes the terminal bell', () => {
  const out = fakeOut();
  const { app } = makeApp({ out, sound: () => 'bell' });
  app.guildSettings = guildSettings(1, '102', { level: 0, muted: false });
  app.draw();
  out.writes.length = 0;

  unseen(app, '988', '띠롱');
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);
});

test('a DM uses the empty-guild notification settings', () => {
  const sounds = [];
  const { app, client } = makeApp({
    sound: () => {
      sounds.push('play');
      return 'play';
    },
  });
  client.rememberChannel({ id: '201', type: 1, recipients: [{ id: '2' }] });
  app.guildSettings = new Map([['', { level: 0, muted: false, channels: new Map() }]]);
  unseen(app, '989', 'DM 소식', '201');
  assert.equal(sounds.length, 1);
});

test('an unknown channel falls back to the TTYCORD_BELL policy', () => {
  const sounds = [];
  const { app } = makeApp({
    sound: () => {
      sounds.push('play');
      return 'play';
    },
  });
  app.bellMode = 'mention';
  app.guildSettings = new Map([['', { level: 0, muted: false, channels: new Map() }]]);
  unseen(app, '990', '<@1> 처음 보는 채널', '999');
  assert.equal(sounds.length, 1, 'mention fallback still rings');
});

test('mentions are marked in the message gutter', () => {
  const { app, screen } = makeApp();
  const cache = app.chat('101');
  cache.items[0].content = '<@1> 여기 좀 봐';
  cache.version += 1;
  cache.layout = null;
  app.draw();

  const view = app.messagesViews[0];
  const span = view.spans.find((entry) => entry.id === '900');
  const y = view.y0 + (span.start - view.start);
  assert.equal(screen.chars[y * screen.cols + app.geo.messages.x], '!');
});

// --------------------------------------------------------- code highlighting
test('fenced code blocks render with token colours', () => {
  const { app, screen } = makeApp();
  const cache = app.chat('101');
  cache.items[0].content = '예시\n```js\nconst n = 42; // hi\n```';
  cache.version += 1;
  cache.layout = null;
  app.draw();

  const text = screen.renderToString();
  assert.match(text, /\[js\]/);
  assert.match(text, /const n = 42/);

  const view = app.messagesViews[0];
  const find = (needle) => {
    for (let y = view.y0; y < view.y0 + view.height; y += 1) {
      for (let x = app.geo.messages.x; x < app.geo.messages.x + app.geo.messages.width; x += 1) {
        const index = y * screen.cols + x;
        if (screen.chars.slice(index, index + needle.length).join('') === needle) return index;
      }
    }
    return -1;
  };

  const keyword = find('const');
  const number = find('42');
  const comment = find('// hi');
  assert.ok(keyword >= 0 && number >= 0 && comment >= 0);
  assert.equal(screen.styles[keyword], T.codeKeyword);
  assert.equal(screen.styles[number], T.codeNumber);
  assert.equal(screen.styles[comment], T.codeComment);
});

test('m enters message mode from the channel list', () => {
  const { app } = makeApp();
  app.focus = 'sidebar';
  app.draw();
  app.handleText('m');

  assert.equal(app.focus, 'messages');
  assert.equal(app.chat('101').cursorId, '900');
});

// ------------------------------------------------------ message click menu
function rowOf(app, id, index = 0) {
  const view = app.messagesViews[index];
  const span = view.spans.find((entry) => entry.id === id);
  return view.y0 + (span.start - view.start);
}

function openMenu(app, id = '900') {
  const y = rowOf(app, id);
  click(app, app.geo.messages.x + 8, y);
  return app.messageMenu;
}

test('clicking a message opens a clickable action menu', () => {
  const { app, screen } = makeApp();
  app.draw();
  const menu = openMenu(app);

  assert.ok(menu);
  assert.equal(menu.messageId, '900');
  assert.deepEqual(
    menu.items.map((item) => item.key),
    ['react', 'reply', 'copy'],
    'edit/delete are only offered for our own messages',
  );
  assert.match(screen.renderToString(), /react/);
  assert.match(screen.renderToString(), /reply/);
  assert.match(screen.renderToString(), /copy link/);
});

test('our own message menu includes edit and delete', () => {
  const { app } = makeApp();
  app.chat('101').items[0].author = { id: '1', username: 'me', global_name: 'Me' };
  app.draw();
  const menu = openMenu(app);
  assert.deepEqual(
    menu.items.map((item) => item.key),
    ['react', 'reply', 'edit', 'delete', 'copy'],
  );
});

test('clicking the react item opens the reaction bar', () => {
  const { app } = makeApp();
  app.draw();
  const menu = openMenu(app);
  const index = menu.items.findIndex((item) => item.key === 'react');
  click(app, menu.x + 2, menu.rows[index]);

  assert.equal(app.messageMenu, null);
  assert.ok(app.reactMode);
  assert.equal(app.reactMode.messageId, '900');
});

test('clicking the reply item starts a reply', () => {
  const { app } = makeApp();
  app.draw();
  const menu = openMenu(app);
  const index = menu.items.findIndex((item) => item.key === 'reply');
  click(app, menu.x + 2, menu.rows[index]);

  assert.equal(app.messageMenu, null);
  assert.equal(app.focus, 'composer');
  assert.equal(app.chat('101').replyTo.id, '900');
});

test('clicking delete twice removes the message', async () => {
  const { app, client } = makeApp();
  app.chat('101').items[0].author = { id: '1', username: 'me', global_name: 'Me' };
  app.draw();
  const menu = openMenu(app);
  const index = menu.items.findIndex((item) => item.key === 'delete');

  click(app, menu.x + 2, menu.rows[index]);
  assert.ok(app.messageMenu, 'the first click only arms the delete');
  assert.equal(app.messageMenu.confirmDelete, true);
  assert.equal(client.deletions.length, 0);

  click(app, menu.x + 2, menu.rows[index]);
  await tick();
  assert.equal(app.messageMenu, null);
  assert.equal(client.deletions.length, 1);
  assert.equal(app.chat('101').items.length, 0);
});

test('escape or a click outside dismisses the action menu', () => {
  const { app } = makeApp();
  app.draw();
  openMenu(app);
  app.handleKey({ key: 'escape', ctrl: false, alt: false, shift: false });
  assert.equal(app.messageMenu, null);

  openMenu(app);
  assert.ok(app.messageMenu);
  click(app, app.geo.sidebar.x + 3, app.geo.sidebar.y + 3);
  assert.equal(app.messageMenu, null);
});

// ------------------------------------------------------------ wake/recovery
test('a long tick gap wakes the live connection once', () => {
  const calls = [];
  const { app } = makeApp({
    live: {
      typingNames: () => [],
      wake() {
        calls.push('wake');
      },
    },
  });
  app.lastTickAt = Date.now() - 60_000;
  app.tick();
  assert.equal(calls.length, 1);
  app.tick();
  assert.equal(calls.length, 1, 'the next tick sees a normal gap again');
});

test('a normal tick does not probe the gateway', () => {
  const calls = [];
  const { app } = makeApp({
    live: {
      typingNames: () => [],
      wake() {
        calls.push('wake');
      },
    },
  });
  app.lastTickAt = Date.now() - 1_000;
  app.tick();
  assert.equal(calls.length, 0);
});

test('wake probes the gateway and resets the bell cooldown', () => {
  const calls = [];
  const { app } = makeApp({
    live: {
      typingNames: () => [],
      wake() {
        calls.push('wake');
      },
    },
  });
  app.lastBellAt = Date.now();
  app.wake();
  assert.equal(calls.length, 1);
  assert.equal(app.lastBellAt, 0);
  clearTimeout(app.wakeTimer);
  app.wakeTimer = null;
});

test('wake refetches visible channels that are at the bottom', async () => {
  const { app, client } = makeApp();
  await app.refreshAfterWake();
  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['101'],
  );
});

test('wake leaves scrolled-up channels untouched', async () => {
  const { app, client } = makeApp();
  app.chat('101').scroll = 4;
  await app.refreshAfterWake();
  assert.equal(client.fetched.length, 0);
});

test('a failed forced reload keeps the cached messages', async () => {
  const { app, client } = makeApp();
  client.fetchMessages = async () => {
    throw new Error('network down');
  };
  await app.loadMessages('101', { force: true });
  assert.equal(app.chat('101').items.length, 1);
  assert.match(app.chat('101').error, /network down/);
});

test('wake refresh waits for the gateway to be online again', async () => {
  const { app, client } = makeApp();
  app.state = 'retrying';
  app.needWakeRefresh = true;

  app.tryWakeRefresh();
  await tick();
  assert.equal(client.fetched.length, 0, 'no REST call while the gateway is down');

  app.onState({ state: 'online' });
  await tick();
  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['101'],
  );
  assert.equal(app.needWakeRefresh, false);
});

test('wake refresh retries a 502 quietly instead of toasting it', async () => {
  const { app, client } = makeApp();
  client.fetchMessages = async () => {
    throw new Error('Discord API 502: upstream error');
  };

  await app.refreshAfterWake();
  assert.ok(app.wakeTimer, 'a retry is scheduled');
  assert.equal(app.needWakeRefresh, true);
  assert.equal(
    app.toasts.some((toast) => toast.kind === 'error'),
    false,
    'transient wake failures stay silent',
  );
  clearTimeout(app.wakeTimer);
  app.wakeTimer = null;
});

test('wake refresh reports a failure only after the last retry', async () => {
  const { app, client } = makeApp();
  client.fetchMessages = async () => {
    throw new Error('Discord API 502: upstream error');
  };

  await app.refreshAfterWake(4, ['101']);
  assert.equal(app.wakeTimer, null);
  assert.equal(app.needWakeRefresh, false);
  assert.match(app.toasts.at(-1).text, /ctrl\+r/);
});

test('a quiet message load keeps the cache without an error toast', async () => {
  const { app, client } = makeApp();
  client.fetchMessages = async () => {
    throw new Error('network down');
  };
  await app.loadMessages('101', { force: true, quiet: true });
  assert.equal(app.chat('101').items.length, 1);
  assert.equal(app.chat('101').error, null, 'no 502 banner for a background retry');
  assert.equal(app.toasts.length, 0);
});

// ---------------------------------------------------- focus / reconnect
test('a blurred terminal does not mark the visible channel read', () => {
  const out = fakeOut();
  const { app } = makeApp({ out });
  app.draw();
  app.focused = false;
  out.writes.length = 0;

  app.onLiveMessage({
    channelId: '101',
    message: {
      id: '980',
      channel_id: '101',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '<@1> 확인해줘',
      timestamp: new Date().toISOString(),
    },
  });

  assert.equal(app.unread.get('101')?.mentions, 1);
  assert.equal(app.readStates.get('101'), undefined);
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 1);
  assert.equal(app.title, 'ttycord !1');
});

test('a focused terminal still marks the visible channel read', () => {
  const out = fakeOut();
  const { app } = makeApp({ out });
  app.draw();
  app.focused = true;
  out.writes.length = 0;

  app.onLiveMessage({
    channelId: '101',
    message: {
      id: '981',
      channel_id: '101',
      type: 0,
      author: { id: '2', username: 'mira' },
      content: '<@1> 확인해줘',
      timestamp: new Date().toISOString(),
    },
  });

  assert.equal(app.unread.has('101'), false);
  assert.equal(app.readStates.get('101').lastMessageId, '981');
  assert.equal(out.writes.filter((chunk) => chunk === '\x07').length, 0);
});

test('focus after a short blur marks visible panes read without a probe', () => {
  const { app } = makeApp();
  app.unread.set('101', { count: 1, mentions: 1 });
  app.focused = false;
  app.blurredAt = Date.now() - 1_000;
  let probes = 0;
  app.wake = () => {
    probes += 1;
  };

  app.onFocus();

  assert.equal(probes, 0);
  assert.equal(app.focused, true);
  assert.equal(app.unread.has('101'), false);
  assert.equal(app.readStates.get('101').lastMessageId, '900');
});

test('focus after a long blur probes the gateway and refreshes', () => {
  const { app } = makeApp();
  app.focused = false;
  app.blurredAt = Date.now() - 60_000;
  let probes = 0;
  app.wake = () => {
    probes += 1;
  };

  app.onFocus();

  assert.equal(probes, 1);
  assert.equal(app.focused, true);
  assert.equal(app.blurredAt, 0);
});

test('wake refresh loads a visible pane that was never loaded', async () => {
  const { app, client } = makeApp();
  app.chat('101').loaded = false;

  await app.refreshAfterWake();

  assert.deepEqual(
    client.fetched.map(([id]) => id),
    ['101'],
  );
});

test('a long gateway outage schedules a quiet refresh when it reconnects', () => {
  const { app } = makeApp();
  app.state = 'retrying';
  app.offlineAt = Date.now() - 10_000;

  app.onState({ state: 'online' });

  assert.equal(app.needWakeRefresh, true);
  assert.ok(app.wakeTimer);
  clearTimeout(app.wakeTimer);
  app.wakeTimer = null;
});

test('a brief gateway reconnect does not refetch messages', () => {
  const { app } = makeApp();
  app.state = 'retrying';
  app.offlineAt = Date.now() - 1_000;

  app.onState({ state: 'online' });

  assert.equal(app.wakeTimer, null);
  assert.equal(app.needWakeRefresh, false);
});

test('wake refresh does not clear unread state while blurred', async () => {
  const { app } = makeApp();
  app.focused = false;
  app.unread.set('101', { count: 1, mentions: 1 });

  await app.refreshAfterWake();

  assert.equal(app.unread.has('101'), true);
});
