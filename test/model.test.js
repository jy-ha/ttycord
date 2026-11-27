import test from 'node:test';
import assert from 'node:assert/strict';

import { inlineSegments } from '../src/tui/pane.js';
import {
  channelName,
  dayLabel,
  groupChannels,
  normalizeGuild,
  shouldGroup,
  systemText,
  unreadLabel,
} from '../src/tui/model.js';

const authorA = { id: '1', username: 'a', global_name: 'A' };
const authorB = { id: '2', username: 'b', global_name: 'B' };

function message(id, author, content, minutesAgo = 0, extra = {}) {
  return {
    id: String(id),
    channel_id: '10',
    type: 0,
    author,
    content,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...extra,
  };
}

test('groupChannels nests text channels under categories', () => {
  const groups = groupChannels([
    { id: '1', type: 4, name: 'INFO', position: 0 },
    { id: '2', type: 0, name: 'rules', position: 1, parent_id: '1' },
    { id: '3', type: 0, name: 'general', position: 2 },
    { id: '4', type: 0, name: 'chat', position: 3, parent_id: '1' },
    { id: '5', type: 2, name: 'voice', position: 4 },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].category, null);
  assert.deepEqual(groups[0].channels.map((channel) => channel.name), ['general']);
  assert.equal(groups[1].category.name, 'INFO');
  assert.deepEqual(groups[1].channels.map((channel) => channel.name), ['rules', 'chat']);
});

test('normalizeGuild builds initials', () => {
  const guild = normalizeGuild({ id: '10', name: 'Rust Korea' });
  assert.equal(guild.id, '10');
  assert.equal(guild.initials, 'RK');
});

test('shouldGroup groups consecutive messages from one author', () => {
  const first = message(1, authorA, 'one', 3);
  const second = message(2, authorA, 'two', 2);
  const other = message(3, authorB, 'three', 1);
  const late = message(4, authorA, 'four', -10);
  assert.equal(shouldGroup(first, second), true);
  assert.equal(shouldGroup(first, other), false);
  assert.equal(shouldGroup(first, late), false);
});

test('shouldGroup breaks on replies', () => {
  const first = message(1, authorA, 'one', 2);
  const reply = message(2, authorA, 'two', 1, {
    referenced_message: { id: '1', author: authorB, content: 'hi' },
  });
  assert.equal(shouldGroup(first, reply), false);
});

test('dayLabel uses today/yesterday', () => {
  assert.equal(dayLabel(new Date()), 'Today');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  assert.equal(dayLabel(yesterday), 'Yesterday');
});

test('unreadLabel caps at 99+', () => {
  assert.equal(unreadLabel(0), '');
  assert.equal(unreadLabel(3), '3');
  assert.equal(unreadLabel(150), '99+');
});

test('channelName resolves DM recipients', () => {
  const channel = {
    id: '20',
    type: 1,
    recipients: [
      { id: '2', username: 'mira', global_name: '미라' },
      { id: '1', username: 'me' },
    ],
  };
  assert.equal(channelName(channel, null, '1'), '미라');
});

test('systemText labels common message types', () => {
  assert.match(systemText({ type: 7, author: authorA }), /joined the server/);
  assert.match(systemText({ type: 4, author: authorA }), /channel name/);
});

test('inlineSegments marks bold, code and spoilers', () => {
  const segments = inlineSegments('**bold** `code` ||secret|| plain');
  const bold = segments.find((segment) => segment.text === 'bold');
  const code = segments.find((segment) => segment.text === 'code');
  const spoiler = segments.find((segment) => segment.spoiler);
  assert.equal(bold.bold, true);
  assert.equal(code.code, true);
  assert.ok(spoiler.text.startsWith('█'));
  assert.equal(segments[segments.length - 1].text, ' plain');
});

test('channelName resolves bare recipient ids and skips self', () => {
  const users = new Map([
    ['1', { id: '1', username: 'me', global_name: 'Me' }],
    ['2', { id: '2', username: 'mira', global_name: '미라' }],
  ]);
  assert.equal(channelName({ type: 1, recipients: ['2', '1'] }, users, '1'), '미라');
});

test('channelName falls back to a stable label for unknown recipients', () => {
  const name = channelName({ type: 1, recipients: ['987654321'] }, new Map(), '1');
  assert.match(name, /4321$/);
});
