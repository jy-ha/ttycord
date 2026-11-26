import test from 'node:test';
import assert from 'node:assert/strict';

import { REACTION_CHOICES, reactionChoice, resolveReaction } from '../src/tui/reactions.js';

test('digits map to the quick reaction bar', () => {
  assert.equal(reactionChoice(0), '👍');
  assert.equal(reactionChoice(4), '✅');
  assert.equal(reactionChoice(REACTION_CHOICES.length), '');
});

test('resolveReaction accepts shortcodes with or without colons', () => {
  assert.equal(resolveReaction('+1'), '👍');
  assert.equal(resolveReaction(':fire:'), '🔥');
  assert.equal(resolveReaction('CHECK'), '✅');
  assert.equal(resolveReaction('thumbsdown'), '👎');
  assert.equal(resolveReaction('sob'), '😢');
});

test('resolveReaction passes raw unicode through and rejects unknown names', () => {
  assert.equal(resolveReaction('🎯'), '🎯');
  assert.equal(resolveReaction('❤️'), '❤️');
  assert.equal(resolveReaction('definitely_not_an_emoji'), '');
  assert.equal(resolveReaction(''), '');
});
