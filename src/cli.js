/** ttycord command line interface. */

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { DiscordClient, resolveToken } from './client.js';
import { LiveSession } from './live.js';
import { spoofEnabled, startSpoofProxy } from './spoof.js';
import { USER_AGENT, acceptLanguage } from './protocol/properties.js';
import { orderGuilds } from './protocol/guild-order.js';
import { clearConfig, configPath, loadConfig, saveConfig } from './store.js';
import { dumpRender, debugLogger, runTui } from './tui/index.js';
import {
  attachmentLines,
  channelName,
  displayName,
  groupChannels,
  hhmm,
  messageDate,
  messageText,
} from './tui/model.js';
import {
  asBig,
  oneLine,
  redactToken,
  relativeTime,
  snowflakeToMs,
  table,
} from './util.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;

const USAGE = `ttycord ${VERSION} — unofficial Discord terminal client

Usage:
  ttycord                          run the live TUI
  ttycord tui                      run the live TUI
  ttycord login [--token T]        save a token (default: find it locally)
  ttycord logout                   remove the saved token
  ttycord token                    show token source and account (masked)
  ttycord me                       show your account
  ttycord guilds                   list guilds
  ttycord channels <guild-id>      list a guild's channels
  ttycord dms                      list direct messages
  ttycord messages <channel-id>    recent messages (--limit 20, --before ID)
  ttycord send <channel-id> <text> send a message
  ttycord ack <channel-id> [id]    mark a channel read
  ttycord watch <channel-id>       stream messages (--all: every channel)
  ttycord doctor                   check token, REST and gateway

Common options:
  --token <token>   supply a token (DISCORD_TOKEN is also read)
  --no-validate     skip token validation
  --json            print JSON
  --no-spoof        explicitly disable the Chrome TLS fingerprint proxy
  --spoof           use the fingerprint proxy (default)
  --no-typing       do not send typing indicators (tui)
  --no-images       disable inline images (tui)
  --debug           write debug logs to the temp dir (ttycord-debug.log)
  --dump            print the TUI as text (tui)
  -h, --help        show help
  -v, --version     show version

The token is normally found read-only in the local Discord desktop client's
Local Storage. Tokens are never printed in full.

Warning: a client that uses a user token may violate Discord's Terms of Service.
Account action is possible, and you take that risk yourself.`;

const OPTIONS = {
  token: { type: 'string' },
  'no-validate': { type: 'boolean', default: false },
  limit: { type: 'string' },
  before: { type: 'string' },
  after: { type: 'string' },
  all: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  spoof: { type: 'boolean', default: true },
  'no-spoof': { type: 'boolean', default: false },
  'no-typing': { type: 'boolean', default: false },
  'no-images': { type: 'boolean', default: false },
  debug: { type: 'boolean', default: false },
  dump: { type: 'boolean', default: false },
  width: { type: 'string' },
  height: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exitCode = code;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

let spoofSession = null;

/**
 * Start the TLS-fingerprint proxy.
 *
 * It is on by default and there is deliberately no silent fallback: connecting
 * without the Chrome fingerprint defeats the point of the client and makes the
 * connection stand out more. A missing or broken helper is a startup error;
 * `--no-spoof` / `TTYCORD_SPOOF=0` is the only way to opt out.
 */
async function ensureSpoof(debug) {
  if (spoofSession) return spoofSession;
  try {
    spoofSession = await startSpoofProxy({
      debug,
      userAgent: USER_AGENT,
      acceptLanguage: acceptLanguage(),
    });
  } catch (error) {
    throw new Error(
      `could not start the TLS fingerprint proxy: ${error.message}\n` +
        'Refusing to connect without the Chrome fingerprint. Build the proxy, ' +
        'or disable it explicitly with --no-spoof / TTYCORD_SPOOF=0.',
    );
  }
  debug?.(
    `spoof proxy ${spoofSession.profile} rest=${spoofSession.restUrl} gateway=${spoofSession.gatewayUrl}`,
  );
  return spoofSession;
}

async function connect(values, debug) {
  const spoof = spoofEnabled({ spoof: values.spoof, noSpoof: values['no-spoof'] })
    ? await ensureSpoof(debug)
    : null;
  // The helper is a transparent egress proxy, so the API path still belongs to
  // the client: swap only the origin.
  const baseUrl = spoof ? `${spoof.restUrl}/api/v9` : undefined;
  const resolved = await resolveToken({
    token: values.token,
    fromLocal: true,
    validate: !values['no-validate'],
    debug,
    baseUrl,
  });
  const client = new DiscordClient({
    token: resolved.token,
    debug,
    baseUrl,
    gatewayUrl: spoof?.gatewayUrl || null,
  });
  await client.login();
  return { client, resolved };
}

function printUser(user) {
  console.log(`User: ${displayName(user)} (@${user.username})`);
  console.log(`ID: ${user.id}`);
}

function channelLabel(client, channel) {
  const name = channelName(channel, client.users, client.me?.id);
  return channel.guild_id ? `#${name}` : `@${name}`;
}

function formatMessage(client, message) {
  const author = displayName(message.author);
  const text = oneLine(messageText(message, { users: client.users }), 500);
  const extras = attachmentLines(message).join(' ');
  return `[${hhmm(messageDate(message))}] ${author}: ${text}${extras ? ` ${extras}` : ''}`;
}

// ---------------------------------------------------------------- commands
async function cmdLogin(values, debug) {
  const resolved = await resolveToken({
    token: values.token,
    fromLocal: true,
    validate: !values['no-validate'],
    debug,
  });
  const client = new DiscordClient({ token: resolved.token, debug });
  const me = await client.login();
  saveConfig({
    token: resolved.token,
    tokenType: 'user',
    userId: me.id,
    username: me.username,
    globalName: me.global_name || '',
  });
  console.log(`Token saved (${resolved.source}).`);
  printUser(me);
  console.log(`Config file: ${configPath()}`);
}

function cmdLogout() {
  const removed = clearConfig();
  console.log(removed ? 'Saved token removed.' : 'No saved token.');
}

async function cmdToken(values, debug) {
  if (values.token || process.env.DISCORD_TOKEN) {
    const resolved = await resolveToken({
      token: values.token,
      fromLocal: false,
      validate: !values['no-validate'],
      debug,
    });
    console.log(`Source: ${resolved.source}`);
    console.log(`Token: ${redactToken(resolved.token)} (${resolved.token.length} chars)`);
    if (resolved.user) printUser(resolved.user);
    return;
  }
  const config = loadConfig();
  if (config?.token) {
    console.log(`Source: saved config (${configPath()})`);
    console.log(`Token: ${redactToken(config.token)} (${config.token.length} chars)`);
    if (config.username) console.log(`User: ${config.globalName || config.username} (${config.userId})`);
    return;
  }
  const resolved = await resolveToken({
    token: values.token,
    fromLocal: true,
    validate: !values['no-validate'],
    debug,
  });
  console.log(`Source: ${resolved.source}${resolved.dir ? ` (${resolved.dir})` : ''}`);
  console.log(`Token: ${redactToken(resolved.token)} (${resolved.token.length} chars)`);
  if (resolved.user) printUser(resolved.user);
}

async function cmdMe(values, debug) {
  const { client, resolved } = await connect(values, debug);
  if (values.json) {
    console.log(JSON.stringify({ source: resolved.source, user: client.me }, null, 2));
    return;
  }
  printUser(client.me);
  console.log(`Token source: ${resolved.source}`);
}

async function cmdGuilds(values, debug) {
  const { client } = await connect(values, debug);
  const guilds = await client.loadGuilds();
  const ids = await client.loadGuildOrder();
  const ordered = orderGuilds(guilds, ids);
  if (values.json) {
    console.log(JSON.stringify(ordered, null, 2));
    return;
  }
  const rows = ordered.map((guild) => [guild.id, guild.name, guild.owner ? 'owner' : '']);
  console.log(table(['ID', 'NAME', 'NOTE'], rows));
}

async function cmdChannels(values, debug) {
  const { client } = await connect(values, debug);
  const guildId = values._[0];
  if (!guildId) {
    const guilds = orderGuilds(await client.loadGuilds(), await client.loadGuildOrder());
    console.log('Pass a guild ID.\n');
    console.log(table(['ID', 'NAME'], guilds.map((guild) => [guild.id, guild.name])));
    return;
  }
  const list = await client.loadChannels(guildId);
  if (values.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  const rows = [];
  for (const group of groupChannels(list)) {
    if (group.category) rows.push(['', `[${group.category.name}]`, '']);
    for (const channel of group.channels) {
      rows.push([channel.id, `#${channel.name}`, oneLine(channel.topic || '', 80)]);
    }
  }
  if (!rows.length) {
    console.log('No text channels to show.');
    return;
  }
  console.log(table(['ID', 'CHANNEL', 'TOPIC'], rows));
}

async function cmdDms(values, debug) {
  const { client } = await connect(values, debug);
  const list = await client.loadDms();
  const sorted = [...list].sort((a, b) => {
    const left = asBig(a.last_message_id || 0);
    const right = asBig(b.last_message_id || 0);
    return left < right ? 1 : left > right ? -1 : 0;
  });
  if (values.json) {
    console.log(JSON.stringify(sorted, null, 2));
    return;
  }
  const rows = sorted.map((channel) => [
    channel.id,
    channelName(channel, client.users, client.me.id),
    channel.last_message_id ? relativeTime(snowflakeToMs(channel.last_message_id)) : '',
  ]);
  console.log(table(['ID', 'DM', 'LAST'], rows));
}

async function cmdMessages(values, debug) {
  const { client } = await connect(values, debug);
  const channelId = values._[0];
  if (!channelId) {
    fail('a channel ID is required: `ttycord messages <channel-id>`');
    return;
  }
  const limit = Math.max(1, Math.min(100, Number(values.limit) || 20));
  const list = await client.fetchMessages(channelId, {
    limit,
    before: values.before,
    after: values.after,
  });
  if (values.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  const channel = client.channel(channelId) || (await client.fetchChannel(channelId).catch(() => null)) || { id: channelId };
  console.log(`${channelLabel(client, channel)} · ${list.length} messages`);
  for (const message of [...list].reverse()) console.log(formatMessage(client, message));
}

async function cmdSend(values, debug) {
  const { client } = await connect(values, debug);
  const channelId = values._[0];
  if (!channelId) {
    fail('a channel ID is required: `ttycord send <channel-id> <text>`');
    return;
  }
  let content = values._.slice(1).join(' ').trim();
  if (!content) content = await readStdin();
  if (!content) {
    fail('nothing to send.');
    return;
  }
  const message = await client.sendMessage(channelId, content);
  if (values.json) {
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  console.log(`Sent: ${message.id} (${hhmm(messageDate(message))})`);
}

async function cmdAck(values, debug) {
  const { client } = await connect(values, debug);
  const channelId = values._[0];
  if (!channelId) {
    fail('a channel ID is required: `ttycord ack <channel-id> [message-id]`');
    return;
  }
  let messageId = values._[1];
  if (!messageId) {
    const list = await client.fetchMessages(channelId, { limit: 1 });
    messageId = list[0]?.id;
  }
  if (!messageId) {
    fail('no message to mark read.');
    return;
  }
  await client.ack(channelId, messageId);
  console.log(`Marked read: ${channelId} / ${messageId}`);
}

async function cmdWatch(values, debug) {
  const { client } = await connect(values, debug);
  const target = values._[0] ? String(values._[0]) : '';
  if (!target && !values.all) {
    fail('a channel ID is required, or pass --all for every channel.');
    return;
  }
  const live = new LiveSession(client, { debug });
  live.on('state', (event) => {
    if (event.state === 'online') console.error('live connection established');
    if (event.state === 'retrying') console.error(`reconnecting… (${event.delay || 0}ms)`);
    if (event.state === 'offline') console.error('disconnected');
  });
  live.on('ready', (data) => {
    console.error(`READY: ${data.user?.username || ''} · guilds ${data.guilds.length} · DMs ${data.privateChannels.length}`);
  });
  live.on('fatal', (error) => {
    console.error(`fatal error: ${error.message}`);
    live.stop();
    process.exit(1);
  });
  live.on('message', ({ message, channelId }) => {
    if (target && channelId !== target) return;
    const channel = client.channel(channelId) || { id: channelId };
    const label = values.all ? `${channelId} ` : '';
    console.log(`${label}${channelLabel(client, channel)} ${formatMessage(client, message)}`);
  });

  const stop = () => {
    live.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  live.start();
  await new Promise(() => {});
}

async function cmdDoctor(values, debug) {
  const { client, resolved } = await connect(values, debug);
  console.log(`Token: ${redactToken(resolved.token)} (${resolved.source})`);
  printUser(client.me);

  const guilds = await client.loadGuilds();
  const dms = await client.loadDms();
  console.log(`Guilds: ${guilds.length}`);
  console.log(`Direct messages: ${dms.length}`);

  const live = new LiveSession(client, { debug });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.stop();
      resolve({ ok: false, reason: 'gateway timed out after 20s' });
    }, 20_000);
    live.once('ready', (data) => {
      clearTimeout(timer);
      live.stop();
      resolve({ ok: true, data });
    });
    live.on('fatal', (error) => {
      clearTimeout(timer);
      live.stop();
      resolve({ ok: false, reason: error.message });
    });
    live.start();
  });

  if (result.ok) {
    console.log(`Gateway: ok (guilds ${result.data.guilds.length}, DMs ${result.data.privateChannels.length})`);
    console.log('All checks passed.');
  } else {
    console.log(`Gateway: failed — ${result.reason}`);
    process.exitCode = 1;
  }
}

async function cmdTui(values, debug) {
  if (values.dump) {
    const width = Number(values.width) || 110;
    const height = Number(values.height) || 34;
    console.log(dumpRender({ width, height }));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('the TUI needs a TTY. Use `ttycord tui --dump` for a text preview.');
    return;
  }
  const { client } = await connect(values, debug);
  const config = loadConfig();
  // A one-off `--no-typing` beats the saved setting; the saved setting beats
  // the default (on).
  const typingIndicator = values['no-typing'] ? false : config?.typingIndicator !== false;
  const live = new LiveSession(client, { debug, typingIndicator });
  await runTui({
    client,
    live,
    debug,
    version: VERSION,
    typingIndicator,
    images: !values['no-images'],
    preferences: {
      collapsedFolders: config?.collapsedFolders || [],
      collapsedCategories: config?.collapsedCategories || [],
      lastView: config?.lastView || null,
      lastChannels: config?.lastChannels || {},
      persist: (patch) => saveConfig(patch),
    },
  });
}

// -------------------------------------------------------------------- main
export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (error) {
    fail(error.message);
    return;
  }
  const { values, positionals } = parsed;
  const command = positionals[0] || 'tui';
  values._ = positionals.slice(1);

  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const debug = debugLogger(values.debug);

  try {
    switch (command) {
      case 'tui':
        await cmdTui(values, debug);
        break;
      case 'login':
        await cmdLogin(values, debug);
        break;
      case 'logout':
        cmdLogout();
        break;
      case 'token':
        await cmdToken(values, debug);
        break;
      case 'me':
        await cmdMe(values, debug);
        break;
      case 'guilds':
        await cmdGuilds(values, debug);
        break;
      case 'channels':
        await cmdChannels(values, debug);
        break;
      case 'dms':
        await cmdDms(values, debug);
        break;
      case 'messages':
        await cmdMessages(values, debug);
        break;
      case 'send':
        await cmdSend(values, debug);
        break;
      case 'ack':
        await cmdAck(values, debug);
        break;
      case 'watch':
        await cmdWatch(values, debug);
        break;
      case 'doctor':
        await cmdDoctor(values, debug);
        break;
      case 'help':
        console.log(USAGE);
        break;
      default:
        fail(`unknown command: ${command}\n\n${USAGE}`);
        break;
    }
  } catch (error) {
    if (values.debug && error.stack) console.error(error.stack);
    fail(error.message || String(error));
  }
}

export { USAGE };
