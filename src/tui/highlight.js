/**
 * Fenced-code parsing and a small, dependency-free tokenizer.
 *
 * The renderer only needs to know which spans of a line are keywords,
 * strings, numbers, comments or punctuation; a full grammar is unnecessary.
 * Tokenizing is line based, with block-comment state carried between lines so
 * a multi-line comment stays coloured across a wrap.
 */

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'true', 'false',
  'null', 'undefined', 'type', 'interface', 'enum', 'implements', 'declare',
  'readonly', 'as', 'satisfies', 'namespace',
];

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'True', 'False', 'None',
  'match', 'case', 'self',
];

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var', 'true', 'false', 'nil', 'iota',
];

const RUST_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
  'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while', 'None', 'Some', 'Ok', 'Err',
];

const SH_KEYWORDS = [
  'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if',
  'in', 'select', 'then', 'until', 'while', 'export', 'local', 'readonly',
  'return', 'set', 'unset', 'shift', 'source', 'alias',
];

const C_KEYWORDS = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static',
  'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile',
  'while', 'class', 'namespace', 'public', 'private', 'protected', 'template',
  'typename', 'using', 'new', 'delete', 'nullptr', 'true', 'false', 'auto',
];

const SQL_KEYWORDS = [
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set',
  'delete', 'create', 'table', 'alter', 'drop', 'index', 'join', 'left',
  'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit',
  'offset', 'as', 'and', 'or', 'not', 'null', 'primary', 'key', 'foreign',
  'references', 'distinct', 'union', 'all', 'case', 'when', 'then', 'else',
  'end', 'default', 'returning', 'with', 'asc', 'desc',
];

const JS_BUILTINS = [
  'console', 'process', 'require', 'module', 'exports', 'globalThis',
  'window', 'document', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Promise', 'Map', 'Set', 'Date', 'RegExp', 'Error', 'Buffer',
  'Symbol', 'BigInt', 'Intl', 'URL', 'fetch',
];

const PY_BUILTINS = [
  'print', 'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict',
  'set', 'tuple', 'open', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min',
  'max', 'any', 'all', 'isinstance', 'type', 'super', 'object', 'Exception',
];

const GO_BUILTINS = [
  'append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
  'make', 'new', 'panic', 'print', 'println', 'real', 'recover', 'string',
  'int', 'int64', 'uint', 'byte', 'rune', 'error', 'bool', 'float64',
];

const RUST_BUILTINS = [
  'println', 'print', 'format', 'vec', 'panic', 'assert', 'assert_eq',
  'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap',
  'HashSet', 'usize', 'isize', 'u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32',
  'i64', 'f32', 'f64', 'str', 'bool', 'char',
];

const LANGS = {
  js: {
    keywords: JS_KEYWORDS,
    builtins: JS_BUILTINS,
    line: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'", '`'],
  },
  python: {
    keywords: PY_KEYWORDS,
    builtins: PY_BUILTINS,
    line: ['#'],
    block: null,
    quotes: ['"""', "'''", '"', "'"],
  },
  go: {
    keywords: GO_KEYWORDS,
    builtins: GO_BUILTINS,
    line: ['//'],
    block: ['/*', '*/'],
    quotes: ['`', '"', "'"],
  },
  rust: {
    keywords: RUST_KEYWORDS,
    builtins: RUST_BUILTINS,
    line: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  shell: {
    keywords: SH_KEYWORDS,
    builtins: ['echo', 'cd', 'pwd', 'ls', 'grep', 'sed', 'awk', 'cat', 'curl'],
    line: ['#'],
    block: null,
    quotes: ['"', "'"],
  },
  c: {
    keywords: C_KEYWORDS,
    builtins: [],
    line: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  sql: {
    keywords: SQL_KEYWORDS,
    builtins: [],
    line: ['--'],
    block: ['/*', '*/'],
    quotes: ["'", '"'],
    caseInsensitive: true,
  },
  json: {
    keywords: ['true', 'false', 'null'],
    builtins: [],
    line: [],
    block: null,
    quotes: ['"'],
  },
  css: {
    keywords: ['important', 'media', 'import', 'from', 'to', 'keyframes'],
    builtins: [],
    line: [],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  html: {
    keywords: [],
    builtins: [],
    line: [],
    block: ['<!--', '-->'],
    quotes: ['"', "'"],
  },
};

const ALIASES = {
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  typescript: 'js',
  ts: 'js',
  tsx: 'js',
  node: 'js',
  py: 'python',
  python3: 'python',
  golang: 'go',
  rs: 'rust',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  console: 'shell',
  shellsession: 'shell',
  cpp: 'c',
  'c++': 'c',
  h: 'c',
  hpp: 'c',
  csharp: 'c',
  java: 'c',
  kotlin: 'c',
  swift: 'c',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  html5: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
};

const DIFF_LANGS = new Set(['diff', 'patch', 'udiff']);

export function languageOf(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (DIFF_LANGS.has(name)) return 'diff';
  return LANGS[ALIASES[name] || name] ? ALIASES[name] || name : '';
}

/**
 * Split a message body into prose and fenced-code parts.
 *
 * ``` and ~~~ fences are both accepted. An unclosed fence runs to the end of
 * the message, matching how Discord renders it.
 */
export function parseFences(text) {
  const lines = String(text ?? '').split('\n');
  const parts = [];
  let prose = [];
  let code = null;
  let lang = '';
  let fence = '';
  const flushProse = () => {
    if (!prose.length) return;
    const body = prose.join('\n');
    if (body.trim()) parts.push({ type: 'text', text: body });
    prose = [];
  };
  const flushCode = () => {
    if (!code) return;
    parts.push({ type: 'code', lang, lines: code });
    code = null;
    lang = '';
    fence = '';
  };

  for (const line of lines) {
    // A fence may carry extra meta after the language (` ```js title=x `).
    const open = /^\s*(```|~~~)\s*([^\s`~]*)(?:\s+.*)?$/.exec(line);
    if (!code && open) {
      flushProse();
      code = [];
      fence = open[1];
      // Keep an unknown tag for the `[lang]` label; highlighting falls back to
      // plain text when there is no tokenizer for it.
      lang = languageOf(open[2]) || String(open[2] || '').trim().toLowerCase();
      continue;
    }
    if (code && new RegExp(`^\\s*${fence}\\s*$`).test(line)) {
      flushCode();
      continue;
    }
    if (code) code.push(line);
    else prose.push(line);
  }
  if (code) flushCode();
  flushProse();
  return parts;
}

function configFor(lang) {
  return LANGS[lang] || null;
}

function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}

function isIdent(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

function pushToken(tokens, text, kind) {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

/** Tokenize one line, carrying block-comment state across lines. */
function tokenizeLine(line, lang, state) {
  const cfg = configFor(lang);
  const tokens = [];
  const lower = (value) => (cfg?.caseInsensitive ? value.toLowerCase() : value);
  const keywords = new Set((cfg?.keywords || []).map(lower));
  const builtins = new Set((cfg?.builtins || []).map(lower));
  let i = 0;

  while (i < line.length) {
    const rest = line.slice(i);

    if (state.block) {
      const end = line.indexOf(state.block, i);
      if (end < 0) {
        pushToken(tokens, rest, 'comment');
        return tokens;
      }
      pushToken(tokens, line.slice(i, end + state.block.length), 'comment');
      i = end + state.block.length;
      state.block = null;
      continue;
    }

    if (cfg?.line?.some((prefix) => rest.startsWith(prefix))) {
      pushToken(tokens, rest, 'comment');
      return tokens;
    }

    if (cfg?.block && rest.startsWith(cfg.block[0])) {
      const end = line.indexOf(cfg.block[1], i + cfg.block[0].length);
      if (end < 0) {
        pushToken(tokens, rest, 'comment');
        state.block = cfg.block[1];
        return tokens;
      }
      pushToken(tokens, line.slice(i, end + cfg.block[1].length), 'comment');
      i = end + cfg.block[1].length;
      continue;
    }

    const quote = cfg?.quotes?.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + quote.length;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line.startsWith(quote, j)) {
          j += quote.length;
          closed = true;
          break;
        }
        j += 1;
      }
      pushToken(tokens, line.slice(i, closed ? j : line.length), 'string');
      i = closed ? j : line.length;
      continue;
    }

    const number = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/.exec(
      rest,
    );
    if (number) {
      pushToken(tokens, number[0], 'number');
      i += number[0].length;
      continue;
    }

    if (isIdentStart(rest[0])) {
      let j = 1;
      while (j < rest.length && isIdent(rest[j])) j += 1;
      const word = rest.slice(0, j);
      const key = lower(word);
      const next = rest.slice(j).match(/^\s*\(/);
      let kind = 'plain';
      if (keywords.has(key)) kind = 'keyword';
      else if (builtins.has(key)) kind = 'builtin';
      else if (next) kind = 'func';
      pushToken(tokens, word, kind);
      i += j;
      continue;
    }

    if (/^\s+/.test(rest)) {
      const space = /^\s+/.exec(rest)[0];
      pushToken(tokens, space, 'plain');
      i += space.length;
      continue;
    }

    const punct = /^[{}()[\];,.:=+\-*/%<>!&|^~?@#\\]+/.exec(rest);
    if (punct) {
      pushToken(tokens, punct[0], 'punct');
      i += punct[0].length;
      continue;
    }

    pushToken(tokens, rest[0], 'plain');
    i += 1;
  }
  return tokens;
}

function diffLine(line) {
  if (/^\+\+\+|^---/.test(line)) return [{ text: line, kind: 'hunk' }];
  if (/^@@/.test(line)) return [{ text: line, kind: 'hunk' }];
  if (/^\+/.test(line)) return [{ text: line, kind: 'add' }];
  if (/^-/.test(line)) return [{ text: line, kind: 'del' }];
  return [{ text: line, kind: 'plain' }];
}

/** Highlight a whole fenced block: one token array per source line. */
export function highlightCode(lines, lang) {
  if (lang === 'diff') return lines.map(diffLine);
  if (!configFor(lang)) return lines.map((line) => [{ text: line, kind: 'plain' }]);
  const state = { block: null };
  return lines.map((line) => tokenizeLine(line, lang, state));
}
