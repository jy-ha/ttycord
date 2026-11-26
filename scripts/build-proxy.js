#!/usr/bin/env node
/**
 * Build the optional TLS-spoofing helper.
 *
 * Requires a Go toolchain. Nothing else in this project needs Go; the helper is
 * only used when `--spoof` is passed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'spoof-proxy');
const OUTPUT = path.join(
  SOURCE,
  'bin',
  process.platform === 'win32' ? 'spoof-proxy.exe' : 'spoof-proxy',
);

function findGo() {
  const candidates = [
    process.env.TTYCORD_GO,
    path.join(os.homedir(), '.local', 'go', 'bin', 'go'),
    '/usr/local/go/bin/go',
    '/usr/lib/go/bin/go',
    '/opt/homebrew/bin/go',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to PATH; spawnSync reports ENOENT if it is not there either.
  return 'go';
}

const go = findGo();
mkdirSync(path.dirname(OUTPUT), { recursive: true });

const result = spawnSync(
  go,
  ['build', '-trimpath', '-ldflags=-s -w', '-o', OUTPUT, '.'],
  { cwd: SOURCE, stdio: 'inherit' },
);

if (result.error) {
  console.error(
    `Go 툴체인을 실행할 수 없습니다 (${go}): ${result.error.message}\n` +
      'https://go.dev/dl/ 에서 설치하거나 TTYCORD_GO로 go 실행 파일 경로를 지정하세요.',
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
