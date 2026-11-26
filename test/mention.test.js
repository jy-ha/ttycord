import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelMentionItems,
  mentionToken,
  specialMentionItems,
  userMentionItems,
} from '../src/tui/mention.js';

test('mentionToken finds the @ and # token around the cursor', () => {
  assert.deepEqual(mentionToken('hello @al', 9), {
    kind: 'user',
    start: 6,
    end: 9,
    query: 'al',
  });
  assert.deepEqual(mentionToken('#gen', 4), {
    kind: 'channel',
    start: 0,
    end: 4,
    query: 'gen',
  });
  // The whole token is replaced even when the cursor is in the middle.
  assert.deepEqual(mentionToken('@alice', 3), {
    kind: 'user',
    start: 0,
    end: 6,
    query: 'al',
  });
  assert.deepEqual(mentionToken('hello @al rest', 9), {
    kind: 'user',
    start: 6,
    end: 9,
    query: 'al',
  });
});

test('mentionToken ignores emails, URLs and completed syntax', () => {
  assert.equal(mentionToken('mail a@b.com', 12), null);
  assert.equal(mentionToken('https://x.test/@foo', 19), null);
  assert.equal(mentionToken('<@123>', 7), null);
  assert.equal(mentionToken('no token here', 13), null);
});

test('userMentionItems excludes self and ranks prefix matches', () => {
  const users = new Map([
    ['1', { id: '1', username: 'me' }],
    ['2', { id: '2', username: 'alice', global_name: 'Alice' }],
    ['3', { id: '3', username: 'malice' }],
    ['4', { id: '4', username: 'bob' }],
  ]);
  const items = userMentionItems(users, { query: 'ali' }, { selfId: '1' });
  assert.deepEqual(
    items.map((item) => item.id),
    ['2', '3'],
  );
  assert.equal(items[0].label, 'Alice');
  assert.equal(items[0].insert, '<@2>');
  assert.ok(!items.some((item) => item.id === '1'));
});

test('an empty @ shows users active in the channel first', () => {
  const users = new Map([
    ['2', { id: '2', username: 'alice' }],
    ['3', { id: '3', username: 'bob' }],
    ['4', { id: '4', username: 'carol' }],
  ]);
  const items = userMentionItems(users, { query: '' }, { preferred: ['4', '3'] });
  assert.deepEqual(
    items.map((item) => item.id),
    ['4', '3'],
  );
});

test('channelMentionItems filters guild channels and inserts channel syntax', () => {
  const items = channelMentionItems(
    [
      { id: '10', name: 'general', position: 0 },
      { id: '11', name: 'dev', position: 1 },
      { id: '12', name: 'design', position: 2 },
    ],
    { query: 'de' },
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ['11', '12'],
  );
  assert.equal(items[0].insert, '<#11>');
});

test('everyone/here only appear once the user starts typing', () => {
  assert.deepEqual(specialMentionItems({ query: '' }), []);
  assert.deepEqual(
    specialMentionItems({ query: 'eve' }).map((item) => item.insert),
    ['@everyone'],
  );
  assert.deepEqual(
    specialMentionItems({ query: 'her' }).map((item) => item.insert),
    ['@here'],
  );
});
