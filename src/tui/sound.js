/**
 * Notification sound playback.
 *
 * The terminal bell is only a fallback: most desktops map it to a visual flash
 * or silence. When a freedesktop sound file and an audio player are available,
 * spawn one detached player so the TUI never waits on audio.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILES = [
  '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
  '/usr/share/sounds/freedesktop/stereo/message.oga',
  '/usr/share/sounds/freedesktop/stereo/bell.oga',
  '/usr/share/sounds/gnome/default/alerts/glass.oga',
];

const PLAYERS = [
  { command: 'paplay', args: (file) => [file] },
  { command: 'pw-play', args: (file) => [file] },
  { command: 'aplay', args: (file) => ['-q', file] },
  { command: 'afplay', args: (file) => [file] },
];

function commandExists(command, env) {
  if (command.includes('/')) return fs.existsSync(command);
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => fs.existsSync(path.join(dir, command)));
}

/**
 * Decide how a notification should be announced.
 *
 * `TTYCORD_SOUND`:
 *   auto (default) — play a system sound, fall back to the terminal bell
 *   off            — stay silent
 *   bell           — terminal bell only
 *   /path/file     — play this file with the first available player
 *
 * `TTYCORD_SOUND_CMD` overrides the player command (a path or a name on PATH).
 */
export function resolveSound(env = process.env) {
  const raw = String(env.TTYCORD_SOUND || '').trim();
  const choice = raw.toLowerCase();
  if (choice === 'off' || choice === 'none' || choice === 'silent') return { mode: 'off' };
  if (choice === 'bell') return { mode: 'bell' };

  const file = raw && choice !== 'auto' ? raw : DEFAULT_FILES.find((entry) => fs.existsSync(entry));
  if (!file || !fs.existsSync(file)) return { mode: 'bell' };

  const override = String(env.TTYCORD_SOUND_CMD || '').trim();
  const players = override ? [{ command: override, args: (value) => [value] }] : PLAYERS;
  for (const player of players) {
    if (!commandExists(player.command, env)) continue;
    return { mode: 'play', command: player.command, args: player.args(file), file };
  }
  return { mode: 'bell' };
}

/** Play the configured sound. Returns `play`, `bell` or `off`. */
export function playSound({ env = process.env, spawnFn = spawn } = {}) {
  const plan = resolveSound(env);
  if (plan.mode !== 'play') return plan.mode;
  try {
    const child = spawnFn(plan.command, plan.args, { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref?.();
    return 'play';
  } catch {
    return 'bell';
  }
}
