/**
 * Optional Chrome-TLS egress proxy.
 *
 * Discord fingerprints the TLS ClientHello, and Node's OpenSSL stack cannot
 * reproduce Chrome's cipher/extension layout (notably GREASE). `spoof-proxy/`
 * is a small Go helper that terminates the upstream TLS connection with
 * bogdanfinn/tls-client and exposes it here as plain HTTP/1.1 on localhost.
 *
 * This module only manages that process. All Discord logic stays in Node; the
 * caller swaps two base URLs and nothing else changes.
 *
 * Enabled by default: without it the ClientHello is Node's OpenSSL stack, so
 * every header we match is wasted. The proxy is therefore on by default with no
 * silent fallback: `--no-spoof` or `TTYCORD_SPOOF=0` is the only way to run
 * without it, and a missing helper is an error the caller reports.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Absolute path to the compiled helper. */
export function proxyBinaryPath(env = process.env, platform = process.platform) {
  const override = String(env.TTYCORD_SPOOF_PROXY || '').trim();
  if (override) return override;
  const name = platform === 'win32' ? 'spoof-proxy.exe' : 'spoof-proxy';
  return path.join(ROOT, 'spoof-proxy', 'bin', name);
}

/**
 * Whether the proxy should be used for this run.
 *
 * Precedence: `--no-spoof` > `TTYCORD_SPOOF` > `--spoof` > default (on).
 */
export function spoofEnabled({ spoof = true, noSpoof = false } = {}, env = process.env) {
  if (noSpoof) return false;
  const value = String(env.TTYCORD_SPOOF ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  return Boolean(spoof);
}

/**
 * Start the helper and wait for its one-line ready message.
 *
 * Resolves to `{ restUrl, gatewayUrl, profile, binary, close }`. `close` is
 * idempotent and also runs automatically when this process exits.
 */
export async function startSpoofProxy({
  binary = proxyBinaryPath(),
  userAgent = '',
  acceptLanguage = '',
  debug = null,
  timeout = 15_000,
} = {}) {
  if (!existsSync(binary)) {
    throw new Error(
      `TLS 스푸핑 프록시를 찾을 수 없습니다: ${binary}\n` +
        '`npm run build:proxy`로 빌드하거나 TTYCORD_SPOOF_PROXY로 경로를 지정하세요.',
    );
  }

  const args = [];
  if (userAgent) args.push('--user-agent', userAgent);
  if (acceptLanguage) args.push('--accept-language', acceptLanguage);

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };

  let info;
  try {
    info = await readReady(child, { timeout, debug });
  } catch (error) {
    close();
    throw error;
  }

  child.once('exit', () => {
    closed = true;
  });
  // Short-lived commands must not be kept alive by the helper's pipes.
  child.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  process.once('exit', close);

  return {
    restUrl: info.rest,
    gatewayUrl: info.gateway,
    profile: info.profile || '',
    binary,
    close,
  };
}

function readReady(child, { timeout, debug }) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`프록시가 ${Math.round(timeout / 1000)}초 안에 준비되지 않았습니다.`));
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      let info;
      try {
        info = JSON.parse(line);
      } catch {
        finish(new Error(`프록시 응답을 해석할 수 없습니다: ${line}`));
        return;
      }
      if (!info?.rest || !info?.gateway) {
        finish(new Error('프록시가 REST/게이트웨이 주소를 알려주지 않았습니다.'));
        return;
      }
      finish(null, info);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) debug?.(`spoof-proxy: ${text}`);
    });

    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      finish(
        new Error(
          `프록시가 준비되기 전에 종료되었습니다 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });
  });
}
