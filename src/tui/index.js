/** TUI entry point: terminal lifecycle, live session and the render loop. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { DiscordClient } from '../client.js';
import { LiveSession } from '../live.js';
import { Screen, enterScreen, leaveScreen } from './term.js';
import { TermInput } from './input.js';
import { App } from './app.js';
import { clockLabel } from './model.js';

const require = createRequire(import.meta.url);
const VERSION = require('../../package.json').version;

export function debugLogger(enabled) {
  if (!enabled) return undefined;
  const file = path.join(os.tmpdir(), 'ttycord-debug.log');
  return (message) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* debugging must never break the UI */
    }
  };
}

function fakeClient() {
  const me = { id: '1', username: 'demo_user', global_name: 'Demo' };
  const mira = { id: '2', username: 'mira', global_name: 'Mira' };
  const jun = { id: '3', username: 'jun', global_name: 'Jun' };
  const users = new Map([
    [me.id, me],
    [mira.id, mira],
    [jun.id, jun],
  ]);
  const channels = new Map();
  const guilds = new Map();
  const client = {
    me,
    users,
    channels,
    guilds,
    channel(id) {
      return channels.get(String(id)) || null;
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
  };
  return client;
}

/** Render a representative screen without touching the network. */
export function dumpRender({ width = 110, height = 34 } = {}) {
  const out = { isTTY: false, columns: width, rows: height, write() {} };
  const screen = new Screen(out);
  screen.resize(width, height);
  const client = fakeClient();
  const app = new App({ client, live: null, screen, out, version: VERSION });
  app.running = true;
  app.state = 'online';
  app.clock = clockLabel();
  app.myId = '1';
  app.myName = 'Demo';

  const general = client.rememberChannel({
    id: '101',
    guild_id: '10',
    type: 0,
    name: 'general',
    topic: 'Linux · TUI · off-topic',
    position: 0,
    last_message_id: '900',
  });
  const dev = client.rememberChannel({
    id: '102',
    guild_id: '10',
    type: 0,
    name: 'dev',
    topic: 'development talk',
    parent_id: '100',
    position: 1,
    last_message_id: '899',
  });
  const random = client.rememberChannel({
    id: '103',
    guild_id: '10',
    type: 0,
    name: 'random',
    parent_id: '100',
    position: 2,
    last_message_id: '898',
  });
  const category = client.rememberChannel({
    id: '100',
    guild_id: '10',
    type: 4,
    name: 'DEV',
    position: 1,
  });
  const guild = {
    id: '10',
    name: 'Demo Guild',
    initials: 'DG',
    channels: [general, category, dev, random],
  };
  const gaming = {
    id: '20',
    name: 'Gaming',
    initials: 'GM',
    channels: [],
  };
  const temp = {
    id: '30',
    name: 'Test Server',
    initials: 'TS',
    channels: [],
  };
  app.guilds = [guild, gaming, temp];
  // Real accounts keep their folders unnamed; the id is the only handle.
  app.folders = [
    { id: '1929507120', name: '', color: null, guildIds: ['10', '20', '30'] },
  ];
  app.dms = [
    client.rememberChannel({
      id: '201',
      type: 1,
      recipients: [{ id: '2', username: 'mira', global_name: 'Mira' }],
      last_message_id: '897',
    }),
  ];
  app.selectedGuildId = '10';
  app.selectedChannelId = '101';
  app.railIndex = 1;
  app.focus = 'composer';
  app.readStates.set('101', { lastMessageId: '895', mentionCount: 0 });
  app.unread.set('102', { count: 3, mentions: 1 });
  app.unread.set('103', { count: 1, mentions: 0 });

  const messages = [
    {
      id: '890',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
      author: { id: '2', username: 'mira', global_name: 'Mira' },
      content: 'Anyone here built a Discord TUI before?',
    },
    {
      id: '891',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 3_500_000).toISOString(),
      author: { id: '3', username: 'jun', global_name: 'Jun' },
      content: 'Writing offline tests with `node --test`.',
    },
    {
      id: '892',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 3_400_000).toISOString(),
      author: { id: '2', username: 'mira', global_name: 'Mira' },
      content: 'Nice. How do you handle **gateway reconnects**?',
    },
    {
      id: '893',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 3_300_000).toISOString(),
      author: { id: '3', username: 'jun', global_name: 'Jun' },
      content: 'Exponential backoff plus RESUME. op 7/9 as well.',
      referenced_message: {
        id: '892',
        author: { id: '2', username: 'mira', global_name: 'Mira' },
        content: 'How do you handle gateway reconnects?',
      },
    },
    {
      id: '894',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 3_200_000).toISOString(),
      author: { id: '2', username: 'mira', global_name: 'Mira' },
      content: 'Share a screenshot too',
      attachments: [{ filename: 'tui.png', size: 128_000, content_type: 'image/png' }],
    },
    {
      id: '895',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 1_800_000).toISOString(),
      author: { id: '1', username: 'demo_user', global_name: 'Demo' },
      content: 'Almost done. Just need to verify live messages.',
    },
    {
      id: '896',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 600_000).toISOString(),
      author: { id: '3', username: 'jun', global_name: 'Jun' },
      content: 'Looks good! Notifications work too.',
    },
    {
      id: '897',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 500_000).toISOString(),
      author: { id: '2', username: 'mira', global_name: 'Mira' },
      content: 'Does opening a channel mark it read automatically?',
    },
    {
      id: '898',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 400_000).toISOString(),
      author: { id: '1', username: 'demo_user', global_name: 'Demo' },
      content: 'Yes. It happens on open.',
    },
    {
      id: '899',
      channel_id: '101',
      type: 0,
      timestamp: new Date(Date.now() - 300_000).toISOString(),
      author: { id: '3', username: 'jun', global_name: 'Jun' },
      content: 'Nice 👍',
    },
  ];
  const cache = app.chat('101');
  cache.items = messages;
  cache.byId = new Map(messages.map((message) => [message.id, message]));
  cache.loaded = true;
  cache.version = 1;
  cache.draft = 'Looks good, let me verify against a real server.';

  app.draw();
  return screen.renderToString();
}

export async function runTui({
  client,
  live = null,
  debug = null,
  version = VERSION,
  typingIndicator = true,
  images = true,
  preferences = null,
} = {}) {
  if (!client) throw new Error('Discord client is required');
  const session = live || new LiveSession(client, { debug, typingIndicator });
  const out = process.stdout;
  const screen = new Screen(out);
  const input = new TermInput(process.stdin);

  enterScreen(out);
  const app = new App({ client, live: session, screen, input, out, version, debug, images, preferences });

  const onResize = () => app.resize(out.columns || 100, out.rows || 30);
  process.stdout.on('resize', onResize);

  const onSignal = () => app.quit();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Closing the terminal window sends SIGHUP; treat it like a normal quit so
  // the last view still gets saved.
  process.once('SIGHUP', onSignal);
  // Ctrl+Z + fg (and some suspend/resume paths) deliver SIGCONT. The tick
  // clock jump also catches this, but SIGCONT reacts immediately. Windows has
  // no SIGCONT, so skip the listener there.
  const onContinue = process.platform === 'win32' ? null : () => app.wake();
  if (onContinue) process.on('SIGCONT', onContinue);

  // Attach the app's input listeners before the first byte is parsed, so an
  // immediate focus report (DECSET 1004) is not dropped.
  const done = app.start();
  input.start();
  await done;

  input.stop();
  process.stdout.off('resize', onResize);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
  if (onContinue) process.off('SIGCONT', onContinue);
  leaveScreen(out);
}
