# ttycord

An unofficial Discord terminal client for personal use. It talks to Discord's
**REST API v9** and **Gateway WebSocket** directly from Node.js and ships both a
scriptable CLI and a full-screen TUI.

> **Not affiliated with Discord Inc.** This client uses a user token, which may
> violate Discord's Terms of Service. Account action is possible, and you take
> that risk yourself. See [Security & disclaimer](#security--disclaimer).

## Features

- Zero runtime npm dependencies (Node.js 22+, built-in `fetch` and `WebSocket`)
- Real-time messages, typing indicators and read acknowledgements
- Guild rail, channel sidebar, message view and composer with mouse support
- Split view for up to four channels or DMs in a 2×2 grid
- Inline images rendered with half-block characters
- File drag-and-drop and clipboard image paste for attachments
- `@` / `#` mention autocomplete and multiline input
- Notification sound driven by Discord's per-channel settings
- Optional Chrome-TLS fingerprint proxy (Go helper, on by default)
- Recovery from suspend, sleep and long stays in a background terminal tab

## Requirements

- **Node.js 22 or newer**
- **Go 1.27 or newer** — only to build the TLS fingerprint proxy
- Linux or macOS terminal; Windows has limited support

## Install

```bash
git clone https://github.com/jy-ha/ttycord.git
cd ttycord

npm run build:proxy     # builds the Go TLS helper (once)
npm link                # or: npm install -g .
ttycord --help
```

`npm link` points the `ttycord` command at the checkout, so code changes only
need a restart. `npm install -g .` copies the files and must be repeated after
changes.

The TLS proxy is enabled by default and has **no silent fallback**: if the
binary is missing, ttycord exits with build instructions instead of connecting
directly. Use `--no-spoof` (or `TTYCORD_SPOOF=0`) to skip it; without the proxy
the TLS fingerprint is Node's, not Chrome's.

This project is not published to npm. Install it from the repository above.

## Token

ttycord resolves the token in this order:

1. `--token <token>`
2. `DISCORD_TOKEN`
3. `~/.config/ttycord/config.json` (written by `ttycord login`)
4. The local Discord desktop client's `Local Storage/leveldb` (read-only)

```bash
ttycord login                 # find a local token, validate and save it
ttycord login --token "..."   # or supply one directly
ttycord token                 # show the source and account (token masked)
ttycord logout                # delete the saved token
```

Saved token files are created with mode `0600`. Set `TTYCORD_CONFIG_DIR` to move
the config directory, or `TTYCORD_TOKEN_DIRS` (colon-separated) to change where
local tokens are searched.

## CLI

```bash
ttycord me
ttycord guilds
ttycord channels <guild-id>
ttycord dms
ttycord messages <channel-id> --limit 20
ttycord messages <channel-id> --before <message-id>
ttycord send <channel-id> "hello"
echo "piped input" | ttycord send <channel-id>
ttycord ack <channel-id> [message-id]
ttycord watch <channel-id>    # stream one channel
ttycord watch --all           # stream every channel
ttycord doctor                # check token, REST and gateway
```

`--json` prints lists and messages as JSON. `--debug` writes request and gateway
logs to `$TMPDIR/ttycord-debug.log` (tokens are never logged).

## TUI

```bash
ttycord                                      # or: ttycord tui
ttycord tui --dump --width 110 --height 34   # render a preview, no network
```

The TUI runs on the terminal's alternate screen. On narrow terminals the guild
rail is hidden and only the channel sidebar and message pane are shown.

### Keys

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Move between guild rail, channels and composer |
| `j` / `k`, `↑` / `↓` | Move the cursor; in the composer, move lines then history |
| `g` / `G` | Jump the message cursor to the first / last message |
| `enter` | Open a guild or channel; send a message |
| `ctrl+enter`, `alt+enter`, `ctrl+j` | Newline in the composer |
| `space` | Collapse or expand a guild folder or channel category |
| `esc` | Cancel reply/edit, leave message mode, clear selection |
| `m` | Enter message cursor mode |
| Click a message | Move the cursor and open the action menu |
| `r` | React (`1`-`8` for quick picks, or type a name/emoji) |
| `R` | Reply to the selected message |
| `e` / `d` | Edit your message / delete it (`d` twice) |
| `y` | Copy a link to the selected message |
| `h` / `l`, `←` / `→` | Move between panes |
| `pageup` / `pagedown` | Scroll; reaching the top loads older messages |
| `i` | Toggle inline images |
| `z` | Wide mode: hide rail and sidebar, let images use the full width |
| `s` | Toggle split view (up to four panes) |
| `1`-`4`, `ctrl+←` / `ctrl+→` | Focus a split pane |
| `ctrl+w` | Close the focused split pane |
| `ctrl+r` | Reload recent messages |
| `ctrl+u` | Clear the composer |
| `ctrl+x` | Remove the last pending attachment |
| `ctrl+v` | Paste an image or file from the clipboard |
| Drag | Select text; `shift`+drag uses the terminal's own selection |
| Drop a file | Attach it |
| `ctrl+c` | Copy the selection; twice to quit |
| `?` | Help |

Opening a channel marks it read. New messages in a visible channel are also
marked read while the terminal is focused and scrolled to the bottom. When the
terminal is in the background nothing is marked read, so mentions keep their
badge and sound.

### Notifications

New messages that are not visible on screen play a sound, and mentions are
counted in the terminal title (`ttycord !1`) and marked with `!` in the gutter.

Discord's per-channel notification settings are respected:

| Channel setting | Behaviour |
| --- | --- |
| All messages | Sound for every unseen message |
| Mentions only | Sound only when you are mentioned |
| Nothing / muted | Silent (title and gutter markers remain) |

`TTYCORD_BELL` overrides the default when Discord settings are unavailable:
`mention` (default), `all`, or `off` (master mute).

Sound uses the system audio player (`paplay`, `pw-play`, `aplay`, then `afplay`)
with freedesktop sound files, falling back to the terminal bell. Control it with
`TTYCORD_SOUND` (`auto`, `off`, `bell`, or a file path) and
`TTYCORD_SOUND_CMD`. A 1.5 second cooldown keeps bursts quiet.

### Attachments and images

Drag files onto the terminal to attach them. Up to 10 files per message, 10 MB
each by default (`TTYCORD_MAX_UPLOAD_MB`). `ctrl+v` attaches an image from the
desktop clipboard; text on the clipboard is pasted instead. `ctrl+x` removes the
last pending attachment, and a message can consist of attachments alone.

Images are rendered inline with quadrant block characters, so they work over
SSH and in any terminal without a graphics protocol. Resolution follows the cell
grid and `z` widens it. Decoding uses ImageMagick, then `ffmpeg`; without either,
an `[img]` label is shown. Click an image to open its URL in the browser.

### Persistence

The last view, split layout, per-guild last channel, wide mode and collapsed
folders/categories are stored in `config.json` and restored on the next launch.
Only the focused split pane is loaded at startup; other panes load when focused.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Token without saving it |
| `TTYCORD_CONFIG_DIR` | Config directory |
| `TTYCORD_TOKEN_DIRS` | Extra local token search paths |
| `TTYCORD_BELL` | `mention`, `all`, `off` |
| `TTYCORD_SOUND` | `auto`, `off`, `bell`, or a sound file |
| `TTYCORD_SOUND_CMD` | Custom sound player command |
| `TTYCORD_SPOOF` | Set `0` to disable the TLS proxy |
| `TTYCORD_SPOOF_PROXY` | Path to the proxy binary |
| `TTYCORD_LOCALE` | Locale, default `ko-KR` |
| `TTYCORD_MAX_UPLOAD_MB` | Per-file upload limit |

## How it works

- **REST** requests are serialized through one queue with a 120 ms minimum gap.
  Rate-limit buckets are tracked per route, and `429`/`5xx` responses retry with
  exponential backoff.
- **Gateway** connects to `wss://gateway.discord.gg/?v=9&encoding=json`, heartbeats
  every 41.25 s, and reconnects when an ACK is missing for 10 s. Sessions resume
  with `RESUME` when possible.
- **Suspend and focus**: a 10 s wall-clock jump, `SIGCONT` or a focus return
  after 15 s triggers a gateway probe and a quiet refresh of visible channels.
  Connect and `HELLO` timeouts are 20 s, and a 5 s watchdog reconnects a socket
  that produces no payloads for 90 s.
- **TLS fingerprint**: the Go helper in `spoof-proxy/` listens on loopback and
  makes only the upstream connections with `bogdanfinn/tls-client` using a
  Chrome 154 profile. REST uses HTTP/2; the Gateway WebSocket is proxied over
  HTTP/1.1 with Chrome headers. There is no fallback.

## Security & disclaimer

- Tokens are never printed in full in logs, errors or the UI.
- The local leveldb store is read only.
- Saved token files are mode `0600`.
- `me --json` prints the raw Discord user object and may include private fields
  such as an email address. Review it before sharing.
- Message content is never sent anywhere except Discord.
- Using a user token with an unofficial client can violate Discord's Terms of
  Service. Account suspension and token invalidation are possible, and all risk
  is yours.
- This project is not affiliated with, endorsed by or supported by Discord Inc.
  "Discord" and related marks belong to Discord Inc.
- No real tokens or account data are included in this repository; test fixtures
  are synthetic.

## Limitations

- No voice, video, threads, search or forum channels.
- Markdown support covers bold, italics, inline code, spoilers, mentions,
  timestamps and fenced code blocks with syntax highlighting. Unknown languages
  render as plain text.
- Images are drawn in the cell grid; resolution scales with the window. GIFs
  show the first frame and SVG is not rendered.
- Guild folder order is decoded from `PreloadedUserSettings.guild_folders` when
  available; otherwise REST order is used.
- `client_build_number` follows the Discord web build and can be overridden with
  `DISCORD_CLIENT_BUILD_NUMBER`.

## Development

```bash
npm test                 # offline test suite (341 tests)
npm run dump             # render the TUI to text
npm run build:proxy      # build the Go TLS helper
```

Layout:

```
bin/ttycord.js             entry point
src/cli.js                 CLI commands
src/client.js              REST wrapper and token resolution
src/live.js                gateway events to UI events
src/protocol/              REST, gateway, identity, guild order
src/tui/                   renderer, layout, app state, images, input
spoof-proxy/               Go TLS fingerprint helper
test/                      node:test offline tests
docs/REPORT.md             implementation report
```

## License

MIT — see [LICENSE](LICENSE).
