/**
 * Read the system clipboard: images, copied files and text.
 *
 * A terminal never forwards clipboard *images* to the app — bracketed paste
 * only carries text. Ctrl+V therefore asks the desktop clipboard directly and
 * saves an image to a temp PNG that can be uploaded like a dragged file.
 *
 * Linux goes through a small GTK helper (python3 + PyGObject), the same
 * dependency the copy path already uses for VTE terminals. macOS uses
 * osascript. Everything is best-effort: an unavailable helper or an empty
 * clipboard resolves to `{ kind: 'none' }` instead of throwing.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How long a clipboard image survives if it is never sent. */
const CLIPBOARD_TTL_MS = 24 * 60 * 60 * 1000;

export const GTK_READER = `
import json, sys
out = {"kind": "none"}
target = sys.argv[1] if len(sys.argv) > 1 else ""
timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
except Exception as error:
    sys.stderr.write(str(error))
    print(json.dumps(out))
    sys.exit(0)

Gtk.init([])
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
loop = GLib.MainLoop()
state = {"pixbuf": None, "uris": None, "text": None, "done": False}

def finish():
    if not state["done"]:
        state["done"] = True
        loop.quit()

def on_image(_clip, pixbuf, _data=None):
    state["pixbuf"] = pixbuf
    finish()

def on_uris(_clip, uris, _data=None):
    state["uris"] = list(uris or [])
    finish()

def on_text(_clip, text, _data=None):
    state["text"] = text
    finish()

def on_targets(clip, atoms, _data=None):
    names = [a.name() for a in atoms] if atoms else []
    if any(name.startswith("image/") for name in names):
        clip.request_image(on_image)
        return
    if "text/uri-list" in names:
        clip.request_uris(on_uris)
        return
    if any(name in names for name in ("UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING")):
        clip.request_text(on_text)
        return
    finish()

def on_timeout():
    finish()
    return False

GLib.timeout_add(int(max(0.2, timeout) * 1000), on_timeout)
clipboard.request_targets(on_targets)
loop.run()

if state["pixbuf"] is not None and target:
    try:
        state["pixbuf"].savev(target, "png", [], [])
        out = {"kind": "image", "file": target}
    except Exception as error:
        sys.stderr.write(str(error))
elif state["uris"]:
    out = {"kind": "files", "uris": state["uris"]}
elif state["text"]:
    out = {"kind": "text", "text": state["text"]}
print(json.dumps(out))
`;

/** Cache directory for images copied out of the clipboard. */
export function clipboardDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(base, 'ttycord', 'clipboard');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Delete clipboard images that were never sent, so the cache cannot grow. */
export function sweepClipboard({ dir = clipboardDir(), maxAgeMs = CLIPBOARD_TTL_MS, now = Date.now() } = {}) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      /* another instance may have swept it */
    }
  }
  return removed;
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

/** Unique, human-readable name: `clipboard-20261119-142530.png`. */
function imagePath(dir, now = new Date()) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* the caller falls back to { kind: 'none' } */
  }
  const base = `clipboard-${stamp(now)}`;
  for (let index = 0; index < 100; index += 1) {
    const name = index ? `${base}-${index}.png` : `${base}.png`;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return file;
  }
  return path.join(dir, `${base}-${process.pid}.png`);
}

/** Run a helper, collect stdout and never wait longer than the deadline. */
function runHelper(command, args, timeoutMs, spawnImpl) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(stdout);
    }, Math.max(250, timeoutMs));
    timer.unref?.();
    child.on?.('error', () => finish(''));
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk;
    });
    child.on?.('close', () => finish(stdout));
  });
}

function interpret(stdout, file) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim() || '{"kind":"none"}');
  } catch {
    return { kind: 'none' };
  }
  if (parsed.kind === 'image' && file) {
    let info;
    try {
      info = fs.statSync(file);
    } catch {
      return { kind: 'none' };
    }
    if (!info.isFile() || !info.size) return { kind: 'none' };
    return {
      kind: 'image',
      path: file,
      name: path.basename(file),
      size: info.size,
      contentType: 'image/png',
    };
  }
  if (parsed.kind === 'files' && Array.isArray(parsed.uris) && parsed.uris.length) {
    return { kind: 'files', uris: parsed.uris.map(String) };
  }
  if (parsed.kind === 'text' && typeof parsed.text === 'string' && parsed.text) {
    return { kind: 'text', text: parsed.text };
  }
  return { kind: 'none' };
}

/**
 * Read whatever the clipboard currently holds.
 *
 * Resolves to one of:
 *   `{ kind: 'image', path, name, size, contentType }`
 *   `{ kind: 'files', uris }`   (files copied in a file manager)
 *   `{ kind: 'text', text }`
 *   `{ kind: 'none' }`
 */
let swept = false;

/** Sweep stale clipboard images once per process, before the first read. */
function sweepOnce(dir) {
  if (swept) return;
  swept = true;
  sweepClipboard({ dir });
}

export async function readClipboard({
  dir = null,
  timeoutMs = 2000,
  spawnImpl = spawn,
  platform = process.platform,
  now = new Date(),
} = {}) {
  if (platform === 'linux') {
    const target = dir || clipboardDir();
    sweepOnce(target);
    const file = imagePath(target, now);
    const stdout = await runHelper(
      'python3',
      ['-c', GTK_READER, file, String(timeoutMs / 1000)],
      timeoutMs + 500,
      spawnImpl,
    );
    return interpret(stdout, file);
  }
  if (platform === 'darwin') {
    const target = dir || clipboardDir();
    sweepOnce(target);
    const file = imagePath(target, now);
    const script = [
      'try',
      'set theData to the clipboard as «class PNGf»',
      `set theFile to open for access POSIX file ${JSON.stringify(file)} with write permission`,
      'set eof theFile to 0',
      'write theData to theFile',
      'close access theFile',
      'return "ok"',
      'on error',
      'return "no"',
      'end try',
    ];
    const args = script.flatMap((line) => ['-e', line]);
    const stdout = await runHelper('osascript', args, timeoutMs + 500, spawnImpl);
    if (String(stdout).trim() === 'ok') return interpret('{"kind":"image"}', file);
    return { kind: 'none' };
  }
  return { kind: 'none' };
}
