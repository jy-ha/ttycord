import test from 'node:test';
import assert from 'node:assert/strict';

import { highlightCode, languageOf, parseFences } from '../src/tui/highlight.js';

test('parseFences splits prose and fenced code', () => {
  const parts = parseFences('before\n```js\nconst x = 1;\n```\nafter');
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { type: 'text', text: 'before' });
  assert.equal(parts[1].type, 'code');
  assert.equal(parts[1].lang, 'js');
  assert.deepEqual(parts[1].lines, ['const x = 1;']);
  assert.deepEqual(parts[2], { type: 'text', text: 'after' });
});

test('parseFences accepts tildes, aliases and an unclosed fence', () => {
  const parts = parseFences('~~~python\nprint(1)\n~~~');
  assert.equal(parts[0].lang, 'python');
  assert.deepEqual(parts[0].lines, ['print(1)']);

  const unclosed = parseFences('```ts\nlet a = 1');
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].lang, 'js');
  assert.deepEqual(unclosed[0].lines, ['let a = 1']);
});

test('parseFences leaves ordinary text untouched', () => {
  const parts = parseFences('just **prose**\nand a line');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'text');
});

test('languageOf normalises common aliases', () => {
  assert.equal(languageOf('JavaScript'), 'js');
  assert.equal(languageOf('bash'), 'shell');
  assert.equal(languageOf('rs'), 'rust');
  assert.equal(languageOf('patch'), 'diff');
  assert.equal(languageOf('brainfuck'), '');
});

test('the tokenizer separates keywords, strings, numbers and comments', () => {
  const [tokens] = highlightCode(['const n = 42; // note "x"'], 'js');
  const find = (text) => tokens.find((token) => token.text === text);

  assert.equal(find('const').kind, 'keyword');
  assert.equal(find('42').kind, 'number');
  assert.equal(find('// note "x"').kind, 'comment');
  assert.equal(find('=').kind, 'punct');
  assert.equal(tokens.find((token) => token.text.trim() === 'n').kind, 'plain');
});

test('strings and function calls get their own kinds', () => {
  const [tokens] = highlightCode(['const greeting = greet("hi")'], 'js');
  assert.equal(tokens.find((token) => token.text === '"hi"').kind, 'string');
  assert.equal(tokens.find((token) => token.text === 'greet').kind, 'func');
  assert.equal(tokens.find((token) => token.text === 'const').kind, 'keyword');
});

test('python comments and builtins are recognised', () => {
  const [tokens] = highlightCode(['print("hi")  # note'], 'python');
  assert.equal(tokens.find((token) => token.text === 'print').kind, 'builtin');
  assert.equal(tokens.find((token) => token.text === '# note').kind, 'comment');
  assert.equal(tokens.find((token) => token.text === '"hi"').kind, 'string');
});

test('block comments carry state across lines', () => {
  const tokens = highlightCode(['/* start', 'middle', 'end */ const a = 1'], 'js');
  assert.equal(tokens[0][0].kind, 'comment');
  assert.equal(tokens[1][0].kind, 'comment');
  assert.equal(tokens[2][0].kind, 'comment');
  assert.equal(tokens[2].find((token) => token.text === 'const').kind, 'keyword');
});

test('diff lines are classified as add, delete or hunk', () => {
  const tokens = highlightCode(['@@ -1 +1 @@', '-old', '+new', ' context'], 'diff');
  assert.equal(tokens[0][0].kind, 'hunk');
  assert.equal(tokens[1][0].kind, 'del');
  assert.equal(tokens[2][0].kind, 'add');
  assert.equal(tokens[3][0].kind, 'plain');
});

test('sql keywords are case-insensitive', () => {
  const [tokens] = highlightCode(['SELECT id FROM users'], 'sql');
  assert.equal(tokens.find((token) => token.text === 'SELECT').kind, 'keyword');
  assert.equal(tokens.find((token) => token.text === 'FROM').kind, 'keyword');
});

test('a fence may carry meta after the language tag', () => {
  const parts = parseFences('```js title=demo\nconst a = 1\n```');
  assert.equal(parts[0].lang, 'js');
  assert.deepEqual(parts[0].lines, ['const a = 1']);
});

test('unknown languages keep their label but stay plain', () => {
  const parts = parseFences('```brainfuck\n++[>+<-]\n```');
  assert.equal(parts[0].lang, 'brainfuck');
  const [tokens] = highlightCode(parts[0].lines, parts[0].lang);
  assert.deepEqual(tokens, [{ text: '++[>+<-]', kind: 'plain' }]);
});
