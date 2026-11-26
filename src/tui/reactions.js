/**
 * Reaction bar choices and shortcode resolution.
 *
 * The bar offers a fixed set of common reactions under digits 1-8 so a reply
 * can be reacted to without a picker UI. Anything else can be typed: either a
 * raw emoji or a `:shortcode:` from the table below.
 */

export const REACTION_CHOICES = [
  { emoji: '👍', names: ['+1', 'thumbsup', 'like', 'yes'] },
  { emoji: '❤️', names: ['heart', 'love'] },
  { emoji: '😂', names: ['joy', 'laugh', 'lol'] },
  { emoji: '🔥', names: ['fire', 'lit'] },
  { emoji: '✅', names: ['check', 'white_check_mark', 'ok', 'done'] },
  { emoji: '👀', names: ['eyes', 'look'] },
  { emoji: '🎉', names: ['tada', 'party', 'hooray'] },
  { emoji: '😮', names: ['open_mouth', 'wow', 'surprised'] },
];

const EXTRA = {
  '-1': '👎',
  thumbsdown: '👎',
  no: '👎',
  sob: '😢',
  cry: '😢',
  thinking: '🤔',
  thinking_face: '🤔',
  '100': '💯',
  hundred: '💯',
  clap: '👏',
  ok_hand: '👌',
  pray: '🙏',
  skull: '💀',
  rocket: '🚀',
  bug: '🐛',
  sparkles: '✨',
  wave: '👋',
  shrug: '🤷',
  facepalm: '🤦',
  salute: '🫡',
  warning: '⚠️',
  x: '❌',
  heavy_check_mark: '✔️',
  heart_eyes: '😍',
  rofl: '🤣',
  sweat_smile: '😅',
  dart: '🎯',
  lock: '🔒',
  key: '🔑',
  eyes_shut: '😑',
};

/**
 * Turn typed input into an emoji, or `''` when it is not understood.
 *
 * Raw unicode is accepted as-is (so a keyboard emoji picker works), and ASCII
 * goes through the shortcode table with or without colons.
 */
export function resolveReaction(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/[^\x00-\x7f]/.test(text)) return text;
  const name = text.replace(/^:+/, '').replace(/:+$/, '').toLowerCase();
  if (!name) return '';
  const choice = REACTION_CHOICES.find((entry) => entry.names.includes(name));
  if (choice) return choice.emoji;
  return EXTRA[name] || '';
}

/** Digits 1-8 map to the bar; anything else returns `''`. */
export function reactionChoice(index) {
  return REACTION_CHOICES[index]?.emoji || '';
}
