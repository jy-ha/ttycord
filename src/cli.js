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

const USAGE = `ttycord ${VERSION} — 비공식 디스코드 터미널 클라이언트

사용법:
  ttycord                     실시간 TUI 실행
  ttycord tui                 실시간 TUI 실행
  ttycord login [--token T]   토큰 저장 (기본: 로컬 디스코드에서 찾기)
  ttycord logout              저장된 토큰 삭제
  ttycord token               토큰 출처와 사용자 확인 (토큰은 가림)
  ttycord me                  내 계정 정보
  ttycord guilds              서버 목록
  ttycord channels <서버ID>    서버 채널 목록
  ttycord dms                 다이렉트 메시지 목록
  ttycord messages <채널ID>   최근 메시지 (--limit 20, --before ID)
  ttycord send <채널ID> <내용> 메시지 전송
  ttycord ack <채널ID> [메시지ID] 읽음 처리
  ttycord watch <채널ID>      실시간 메시지 출력 (--all: 모든 채널)
  ttycord doctor              토큰·REST·게이트웨이 점검

공통 옵션:
  --token <토큰>      토큰 직접 지정 (DISCORD_TOKEN 환경 변수도 사용)
  --no-validate      토큰 유효성 검사를 건너뜀
  --json             JSON으로 출력
  --no-spoof         Chrome TLS 지문 프록시를 명시적으로 끔 (직접 연결)
  --spoof            지문 프록시 사용 (기본값, 생략 가능)
  --no-typing        타이핑 표시를 보내지 않음 (tui)
  --no-images        이미지 미리보기(하프블록)를 끔 (tui)
  --debug            디버그 로그 (~/tmp/ttycord-debug.log)
  --dump             TUI 화면을 텍스트로 출력 (tui)
  -h, --help         도움말
  -v, --version      버전

토큰은 기본적으로 로컬 디스코드 데스크톱 클라이언트의 Local Storage에서
읽기 전용으로 찾습니다. 토큰을 화면에 전체 출력하지 않습니다.

주의: 사용자 토큰을 사용하는 클라이언트는 디스코드 이용약관에 위배될 수 있으며
계정 제재 위험은 사용자에게 있습니다.`;

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
  console.error(`오류: ${message}`);
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
      `TLS 지문 프록시를 시작하지 못했습니다: ${error.message}\n` +
        'Chrome 지문 없이 연결하지 않습니다. 프록시를 빌드하거나 ' +
        '--no-spoof / TTYCORD_SPOOF=0으로 명시적으로 끄세요.',
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
  console.log(`사용자: ${displayName(user)} (@${user.username})`);
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
  console.log(`토큰을 저장했습니다 (${resolved.source}).`);
  printUser(me);
  console.log(`설정 파일: ${configPath()}`);
}

function cmdLogout() {
  const removed = clearConfig();
  console.log(removed ? '저장된 토큰을 삭제했습니다.' : '저장된 토큰이 없습니다.');
}

async function cmdToken(values, debug) {
  if (values.token || process.env.DISCORD_TOKEN) {
    const resolved = await resolveToken({
      token: values.token,
      fromLocal: false,
      validate: !values['no-validate'],
      debug,
    });
    console.log(`출처: ${resolved.source}`);
    console.log(`토큰: ${redactToken(resolved.token)} (${resolved.token.length}자)`);
    if (resolved.user) printUser(resolved.user);
    return;
  }
  const config = loadConfig();
  if (config?.token) {
    console.log(`출처: 저장된 설정 (${configPath()})`);
    console.log(`토큰: ${redactToken(config.token)} (${config.token.length}자)`);
    if (config.username) console.log(`사용자: ${config.globalName || config.username} (${config.userId})`);
    return;
  }
  const resolved = await resolveToken({
    token: values.token,
    fromLocal: true,
    validate: !values['no-validate'],
    debug,
  });
  console.log(`출처: ${resolved.source}${resolved.dir ? ` (${resolved.dir})` : ''}`);
  console.log(`토큰: ${redactToken(resolved.token)} (${resolved.token.length}자)`);
  if (resolved.user) printUser(resolved.user);
}

async function cmdMe(values, debug) {
  const { client, resolved } = await connect(values, debug);
  if (values.json) {
    console.log(JSON.stringify({ source: resolved.source, user: client.me }, null, 2));
    return;
  }
  printUser(client.me);
  console.log(`토큰 출처: ${resolved.source}`);
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
  const rows = ordered.map((guild) => [guild.id, guild.name, guild.owner ? '소유자' : '']);
  console.log(table(['ID', '이름', '비고'], rows));
}

async function cmdChannels(values, debug) {
  const { client } = await connect(values, debug);
  const guildId = values._[0];
  if (!guildId) {
    const guilds = orderGuilds(await client.loadGuilds(), await client.loadGuildOrder());
    console.log('서버 ID를 지정하세요.\n');
    console.log(table(['ID', '이름'], guilds.map((guild) => [guild.id, guild.name])));
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
    console.log('표시할 텍스트 채널이 없습니다.');
    return;
  }
  console.log(table(['ID', '채널', '주제'], rows));
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
  console.log(table(['ID', '대화', '최근'], rows));
}

async function cmdMessages(values, debug) {
  const { client } = await connect(values, debug);
  const channelId = values._[0];
  if (!channelId) {
    fail('채널 ID가 필요합니다. `ttycord messages <채널ID>`');
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
  console.log(`${channelLabel(client, channel)} · ${list.length}개`);
  for (const message of [...list].reverse()) console.log(formatMessage(client, message));
}

async function cmdSend(values, debug) {
  const { client } = await connect(values, debug);
  const channelId = values._[0];
  if (!channelId) {
    fail('채널 ID가 필요합니다. `ttycord send <채널ID> <내용>`');
    return;
  }
  let content = values._.slice(1).join(' ').trim();
  if (!content) content = await readStdin();
  if (!content) {
    fail('보낼 내용이 없습니다.');
    return;
  }
  const message = await client.sendMessage(channelId, content);
  if (values.json) {
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  console.log(`전송됨: ${message.id} (${hhmm(messageDate(message))})`);
}

async function cmdAck(values, debug) {
  const { client } = await connect(values, debug);
  const channelId = values._[0];
  if (!channelId) {
    fail('채널 ID가 필요합니다. `ttycord ack <채널ID> [메시지ID]`');
    return;
  }
  let messageId = values._[1];
  if (!messageId) {
    const list = await client.fetchMessages(channelId, { limit: 1 });
    messageId = list[0]?.id;
  }
  if (!messageId) {
    fail('읽음 처리할 메시지가 없습니다.');
    return;
  }
  await client.ack(channelId, messageId);
  console.log(`읽음 처리: ${channelId} / ${messageId}`);
}

async function cmdWatch(values, debug) {
  const { client } = await connect(values, debug);
  const target = values._[0] ? String(values._[0]) : '';
  if (!target && !values.all) {
    fail('채널 ID가 필요합니다. 모든 채널을 보려면 --all을 사용하세요.');
    return;
  }
  const live = new LiveSession(client, { debug });
  live.on('state', (event) => {
    if (event.state === 'online') console.error('실시간 연결됨');
    if (event.state === 'retrying') console.error(`재연결 중… (${event.delay || 0}ms)`);
    if (event.state === 'offline') console.error('연결 끊김');
  });
  live.on('ready', (data) => {
    console.error(`READY: ${data.user?.username || ''} · 서버 ${data.guilds.length} · DM ${data.privateChannels.length}`);
  });
  live.on('fatal', (error) => {
    console.error(`치명적 오류: ${error.message}`);
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
  console.log(`토큰: ${redactToken(resolved.token)} (${resolved.source})`);
  printUser(client.me);

  const guilds = await client.loadGuilds();
  const dms = await client.loadDms();
  console.log(`서버: ${guilds.length}`);
  console.log(`다이렉트 메시지: ${dms.length}`);

  const live = new LiveSession(client, { debug });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.stop();
      resolve({ ok: false, reason: '게이트웨이 응답 시간 초과 (20초)' });
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
    console.log(`게이트웨이: 정상 (서버 ${result.data.guilds.length}, DM ${result.data.privateChannels.length})`);
    console.log('모든 점검을 통과했습니다.');
  } else {
    console.log(`게이트웨이: 실패 — ${result.reason}`);
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
    fail('TUI는 TTY에서만 실행됩니다. 화면만 확인하려면 `ttycord tui --dump`를 사용하세요.');
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
        fail(`알 수 없는 명령: ${command}\n\n${USAGE}`);
        break;
    }
  } catch (error) {
    if (values.debug && error.stack) console.error(error.stack);
    fail(error.message || String(error));
  }
}

export { USAGE };
