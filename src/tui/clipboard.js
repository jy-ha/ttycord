/**
 * Screen selection text and clipboard delivery.
 *
 * Mouse drags select cells in the cell grid (the app owns mouse reporting, so
 * the terminal cannot select for us). Ctrl+C then copies that text. We try the
 * platform clipboard helpers first, then a small GTK/X11 helper (for VTE
 * terminals, which do not implement OSC 52), and finally OSC 52 itself.
 */

import { spawn } from 'node:child_process';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Plain text for a drag selection, trailing blanks trimmed. */
export function selectionText(screen, selection, bounds = null) {
  if (!screen) return '';
  const cols = screen.cols;
  if (!cols) return '';
  const lines = [];
  for (const { y, start, end } of selectionRanges(screen, selection, bounds)) {
    let line = '';
    for (let x = start; x <= end; x += 1) {
      const ch = screen.chars[y * cols + x];
      // '' is the continuation cell of a wide glyph; the base already carries it.
      line += ch === '' ? '' : ch;
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

/**
 * Cell ranges covered by a drag selection.
 *
 * This is the linear model used by GUI text editors, not a rectangle: the
 * first line runs from the anchor to the end of the row, the last line from
 * the start of the row to the focus, and the rows in between are selected
 * whole. A single-row drag uses both columns. `selectionText()` and the
 * on-screen highlight both consume these ranges so they can never disagree.
 */
export function selectionRanges(screen, selection, bounds = null) {
  if (!screen || !selection) return [];
  const cols = screen.cols;
  const rows = screen.rows;
  if (!cols || !rows) return [];
  // `bounds` keeps a drag inside the pane it started in (messages, sidebar,
  // rail, ...). Without it the whole screen is selectable, which is what the
  // unit tests and the clipboard helper use.
  const left = clamp(bounds?.left ?? 0, 0, cols - 1);
  const right = clamp(bounds?.right ?? cols - 1, 0, cols - 1);
  const top = clamp(bounds?.top ?? 0, 0, rows - 1);
  const bottom = clamp(bounds?.bottom ?? rows - 1, 0, rows - 1);
  const ax = clamp(selection.ax, left, right);
  const fx = clamp(selection.fx, left, right);
  const ay = clamp(selection.ay, top, bottom);
  const fy = clamp(selection.fy, top, bottom);
  const x0 = Math.min(ax, fx);
  const x1 = Math.max(ax, fx);
  const y0 = Math.min(ay, fy);
  const y1 = Math.max(ay, fy);
  const downward = ay <= fy;
  const single = y0 === y1;

  const ranges = [];
  for (let y = y0; y <= y1; y += 1) {
    let start = left;
    let end = right;
    if (single) {
      start = x0;
      end = x1;
    } else if (y === y0) {
      start = downward ? ax : left;
      end = downward ? right : fx;
    } else if (y === y1) {
      start = downward ? left : ax;
      end = downward ? fx : right;
    }
    ranges.push({ y, start, end });
  }
  return ranges;
}

function clipboardTools() {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  return [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
}

function writeToTool(command, args, text, spawnImpl) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on?.('error', () => finish(false));
    child.on?.('close', (code) => finish(code === 0));
    // A helper that exits before reading stdin is normal; ignore EPIPE.
    child.stdin?.on?.('error', () => {});
    try {
      child.stdin?.end(text);
    } catch {
      finish(false);
    }
  });
}

/**
 * GTK/X11 fallback for terminals without OSC 52 (notably VTE/GNOME Terminal)
 * on machines where xclip/xsel are not installed. The helper owns the X11
 * selection long enough for the clipboard manager to take it over, then exits.
 */
const GTK_CLIPBOARD = `
import sys, time
try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk
    Gtk.init([])
    text = sys.stdin.buffer.read().decode('utf-8', 'replace')
    cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    cb.set_text(text, -1)
    try:
        cb.store()
    except Exception:
        pass
    sys.stdout.write('ok')
    sys.stdout.flush()
    deadline = time.time() + 2.0
    while time.time() < deadline:
        while Gtk.events_pending():
            Gtk.main_iteration()
        time.sleep(0.02)
except Exception:
    sys.exit(1)
`;

function writeViaGtk(text, spawnImpl, command = 'python3') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, ['-c', GTK_CLIPBOARD], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    child.on?.('error', () => finish(false));
    child.on?.('close', (code) => finish(code === 0));
    // Resolve as soon as the selection is set; the helper lingers in the
    // background so the clipboard manager can fetch the contents.
    child.stdout?.on?.('data', (chunk) => {
      if (String(chunk).includes('ok')) finish(true);
    });
    child.stdin?.on?.('error', () => {});
    try {
      child.stdin?.end(text);
    } catch {
      finish(false);
    }
    timer = setTimeout(() => {
      finish(false);
      try {
        child.kill?.();
      } catch {
        /* already gone */
      }
    }, 2_500);
    timer.unref?.();
  });
}

/**
 * Copy `text`. Resolves to the delivery method (`wl-copy`, `xclip`, `xsel`,
 * `pbcopy`, `clip`, `gtk` or `osc52`), or `''` when there was nothing to copy.
 */
export async function copyText(text, { out = process.stdout, spawnImpl = spawn } = {}) {
  const value = String(text ?? '');
  if (!value) return '';
  for (const [command, args] of clipboardTools()) {
    if (await writeToTool(command, args, value, spawnImpl)) return command;
  }
  if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    for (const python of ['python3', 'python']) {
      if (await writeViaGtk(value, spawnImpl, python)) return 'gtk';
    }
  }
  out.write(`\x1b]52;c;${Buffer.from(value, 'utf8').toString('base64')}\x07`);
  return 'osc52';
}
