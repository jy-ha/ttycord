import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearConfig, configPath, loadConfig, saveConfig } from '../src/store.js';

test('config storage writes 0600 and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttycord-config-'));
  const previous = process.env.TTYCORD_CONFIG_DIR;
  process.env.TTYCORD_CONFIG_DIR = dir;
  try {
    assert.equal(loadConfig(), null);
    saveConfig({ token: 'secret', userId: '1', username: 'me' });
    const loaded = loadConfig();
    assert.equal(loaded.token, 'secret');
    assert.equal(loaded.userId, '1');
    assert.equal(loaded.tokenType, 'user');
    assert.equal(loaded.typingIndicator, true, 'typing indicator defaults to on');
    saveConfig({ typingIndicator: false });
    assert.equal(loadConfig().typingIndicator, false);
    const mode = fs.statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(clearConfig(), true);
    assert.equal(loadConfig(), null);
  } finally {
    if (previous === undefined) delete process.env.TTYCORD_CONFIG_DIR;
    else process.env.TTYCORD_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('last view round-trips and ignores unusable values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttycord-config-'));
  const previous = process.env.TTYCORD_CONFIG_DIR;
  process.env.TTYCORD_CONFIG_DIR = dir;
  try {
    saveConfig({ token: 'secret' });
    assert.equal(loadConfig().lastView, null);

    saveConfig({
      lastView: { guildId: 10, channelId: 102, dm: false, wide: true },
    });
    assert.deepEqual(loadConfig().lastView, {
      guildId: '10',
      channelId: '102',
      dm: false,
      wide: true,
    });
    // Saving unrelated settings must not drop the view.
    saveConfig({ typingIndicator: false });
    assert.equal(loadConfig().lastView.channelId, '102');

    saveConfig({
      lastView: {
        guildId: '10',
        channelId: '102',
        dm: false,
        wide: false,
        split: { enabled: true, panes: ['101', '102', 'bad'], focus: 9 },
      },
    });
    assert.deepEqual(loadConfig().lastView.split, {
      enabled: true,
      panes: ['101', '102'],
      focus: 1,
    });
    // A one-pane "split" is just the normal view.
    saveConfig({
      lastView: {
        guildId: '10',
        channelId: '102',
        dm: false,
        wide: false,
        split: { enabled: true, panes: ['102'], focus: 0 },
      },
    });
    assert.equal(loadConfig().lastView.split, undefined);

    saveConfig({ lastView: { guildId: '', channelId: '', dm: true, wide: false } });
    assert.equal(loadConfig().lastView, null);
    saveConfig({ lastView: 'nope' });
    assert.equal(loadConfig().lastView, null);

    assert.deepEqual(loadConfig().lastChannels, {});
    saveConfig({ lastChannels: { 10: '102', 20: 202, bad: '1', 30: 'x' } });
    assert.deepEqual(loadConfig().lastChannels, { 10: '102', 20: '202' });
    saveConfig({ typingIndicator: true });
    assert.equal(loadConfig().lastChannels['10'], '102');
    saveConfig({ lastChannels: [] });
    assert.deepEqual(loadConfig().lastChannels, {});
  } finally {
    if (previous === undefined) delete process.env.TTYCORD_CONFIG_DIR;
    else process.env.TTYCORD_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy discord-tui config is read and copied to the new path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttycord-home-'));
  const previousHome = process.env.HOME;
  const previousDir = process.env.TTYCORD_CONFIG_DIR;
  delete process.env.TTYCORD_CONFIG_DIR;
  process.env.HOME = home;
  const legacy = path.join(home, '.config', 'discord-tui');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ token: 'old-token' }));
  try {
    assert.equal(loadConfig().token, 'old-token');
    const migrated = path.join(home, '.config', 'ttycord', 'config.json');
    assert.equal(fs.existsSync(migrated), true);
    assert.equal(JSON.parse(fs.readFileSync(migrated, 'utf8')).token, 'old-token');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDir === undefined) delete process.env.TTYCORD_CONFIG_DIR;
    else process.env.TTYCORD_CONFIG_DIR = previousDir;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
