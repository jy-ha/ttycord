import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelPrefix,
  colorForId,
  displayWidth,
  graphemeWidth,
  guildInitial,
  isTextChannel,
  mentionsUser,
  msToSnowflake,
  redactToken,
  renderMentions,
  snowflakeToMs,
  truncateMiddle,
} from '../src/util.js';

test('snowflake conversion round-trips', () => {
  const ms = Date.UTC(2026, 0, 1, 12, 34, 56);
  const id = msToSnowflake(ms);
  assert.equal(snowflakeToMs(id), ms);
});

test('display width handles Korean, ASCII and emoji', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('한글'), 4);
  assert.equal(graphemeWidth('😀'), 2);
  assert.equal(graphemeWidth('❤'), 1);
  assert.equal(graphemeWidth('❤️'), 2);
  assert.equal(displayWidth('a한😀'), 5);
});

test('renderMentions resolves users, channels, roles and emoji', () => {
  const users = new Map([['2', '미라']]);
  const channels = new Map([['3', 'general']]);
  const text = renderMentions('안녕 <@2> <#3> <@&4> <:wave:5>', { users, channels });
  assert.equal(text, '안녕 @미라 #general @role :wave:');
});

test('renderMentions handles raw Discord objects, not just names', () => {
  // This is the shape the CLI and TUI actually pass (id -> user object).
  const users = new Map([
    ['1', { id: '1', username: 'rune', global_name: 'Rune' }],
    ['2', { id: '2', username: 'zeta' }],
  ]);
  const channels = new Map([['3', { id: '3', name: 'general' }]]);
  const roles = new Map([['4', { id: '4', name: 'mods' }]]);
  const text = renderMentions('<@1> <@!2> <#3> <@&4>', { users, channels, roles });
  assert.equal(text, '@Rune @zeta #general @mods');
  assert.doesNotMatch(text, /object Object/);
});

test('renderMentions formats Discord timestamps', () => {
  const text = renderMentions('<t:1700000000:t> <t:1700000000:d>');
  assert.doesNotMatch(text, /<t:/);
  assert.match(text, /\d{2}:\d{2}/);
});

test('mentionsUser only matches the requested id', () => {
  assert.equal(mentionsUser('hey <@2>', '2'), true);
  assert.equal(mentionsUser('hey <@!2>', '2'), true);
  assert.equal(mentionsUser('hey <@3>', '2'), false);
  assert.equal(mentionsUser('', '2'), false);
});

test('guildInitial uses the first two words', () => {
  assert.equal(guildInitial('Rust Korea'), 'RK');
  assert.equal(guildInitial('디스코드'), '디스');
  assert.equal(guildInitial(''), '?');
});

test('redactToken keeps only a short prefix and suffix', () => {
  const token = ['MTAwMDAwMDAwMDAwMDAwMDAw', 'GA0000', 'dGVzdC1zaWduYXR1cmUtZm9yLXR0eWNvcmQtdGVzdHM'].join('.');
  const redacted = redactToken(token);
  assert.match(redacted, /^MTAwMD…/);
  assert.ok(!redacted.includes('GGGY5i'));
});

test('truncateMiddle preserves both ends', () => {
  assert.equal(truncateMiddle('abcdefghij', 5), 'ab…ij');
  assert.equal(truncateMiddle('abc', 5), 'abc');
});

test('channel helpers classify common types', () => {
  assert.equal(channelPrefix(0), '#');
  assert.equal(channelPrefix(2), '~');
  assert.equal(channelPrefix(1), '@');
  assert.equal(isTextChannel(0), true);
  assert.equal(isTextChannel(2), false);
  assert.equal(isTextChannel(15), false);
});

test('colorForId is deterministic', () => {
  assert.equal(colorForId('123'), colorForId('123'));
  assert.match(colorForId('123'), /^#[0-9a-f]{6}$/);
});
