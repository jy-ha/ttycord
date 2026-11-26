import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guildFoldersFromSettings,
  guildOrderFromSettings,
} from '../src/protocol/guild-order.js';

/** Minimal protobuf writer for the shapes we decode. */
function varint(value) {
  const out = [];
  let left = BigInt(value);
  while (left > 0x7fn) {
    out.push(Number(left & 0x7fn) | 0x80);
    left >>= 7n;
  }
  out.push(Number(left));
  return Buffer.from(out);
}

function lenField(field, payload) {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

function fixed64s(ids) {
  const buf = Buffer.alloc(ids.length * 8);
  ids.forEach((id, index) => buf.writeBigUInt64LE(BigInt(id), index * 8));
  return buf;
}

function settingsWithFolders(folders) {
  // GuildFolders.folders(1) -> GuildFolder { guild_ids(1) = packed fixed64 }
  const folderBytes = folders.map((ids) => lenField(1, lenField(1, fixed64s(ids))));
  return lenField(14, Buffer.concat(folderBytes)).toString('base64');
}

/** GuildFolder with Discord's `Int64Value`/`StringValue`/`UInt64Value` wrappers. */
function folderField(ids, { id, name, color } = {}) {
  const parts = [lenField(1, fixed64s(ids))];
  // google.protobuf.Int64Value/UInt64Value: { int64 value = 1 } (wire 0).
  if (id !== undefined) parts.push(lenField(2, Buffer.concat([varint(8), varint(id)])));
  // google.protobuf.StringValue: { string value = 1 } (wire 2).
  if (name !== undefined) parts.push(lenField(3, lenField(1, Buffer.from(name, 'utf8'))));
  if (color !== undefined) parts.push(lenField(4, Buffer.concat([varint(8), varint(color)])));
  return lenField(1, Buffer.concat(parts));
}

function settingsFromFolderFields(fields) {
  return lenField(14, Buffer.concat(fields)).toString('base64');
}

test('guildOrderFromSettings flattens folder order', () => {
  const settings = settingsWithFolders([
    [300n, 100n],
    [200n],
  ]);
  assert.deepEqual(guildOrderFromSettings(settings), ['300', '100', '200']);
});

test('guildOrderFromSettings falls back to guild_positions', () => {
  const positions = lenField(2, fixed64s([20n, 10n]));
  const settings = lenField(14, positions).toString('base64');
  assert.deepEqual(guildOrderFromSettings(settings), ['20', '10']);
});

test('guildOrderFromSettings ignores unrelated settings fields', () => {
  const unrelated = lenField(1, Buffer.from([0x08, 0x01]));
  const folder = lenField(1, lenField(1, fixed64s([42n])));
  const settings = Buffer.concat([unrelated, lenField(14, folder)]).toString('base64');
  assert.deepEqual(guildOrderFromSettings(settings), ['42']);
});

test('guildOrderFromSettings returns [] for junk input', () => {
  assert.deepEqual(guildOrderFromSettings(''), []);
  assert.deepEqual(guildOrderFromSettings(null), []);
  assert.deepEqual(guildOrderFromSettings('not base64 protobuf'), []);
});

test('guildFoldersFromSettings decodes wrappers for id, name and color', () => {
  const settings = settingsFromFolderFields([
    folderField([300n, 100n], { id: 1929507120n, name: 'work', color: 0x5865f2n }),
    folderField([200n]),
  ]);
  assert.deepEqual(guildFoldersFromSettings(settings), [
    { id: '1929507120', name: 'work', color: 0x5865f2, guildIds: ['300', '100'] },
    { id: '', name: '', color: null, guildIds: ['200'] },
  ]);
});

test('guildFoldersFromSettings keeps unnamed multi-guild folders', () => {
  // Real accounts store folders without a name: the id is the only handle.
  const settings = settingsFromFolderFields([
    folderField([10n, 20n, 30n], { id: 1929507120n }),
  ]);
  const [folder] = guildFoldersFromSettings(settings);
  assert.equal(folder.id, '1929507120');
  assert.equal(folder.name, '');
  assert.equal(folder.color, null);
  assert.deepEqual(folder.guildIds, ['10', '20', '30']);
});

test('guildFoldersFromSettings flattens through the folder tree', () => {
  const settings = settingsFromFolderFields([
    folderField([1n]),
    folderField([2n, 3n], { id: 7n, name: 'group' }),
    folderField([4n]),
  ]);
  assert.deepEqual(guildOrderFromSettings(settings), ['1', '2', '3', '4']);
  assert.deepEqual(
    guildFoldersFromSettings(settings).map((folder) => folder.guildIds),
    [['1'], ['2', '3'], ['4']],
  );
});

test('guildFoldersFromSettings ignores empty folders and junk input', () => {
  const settings = settingsFromFolderFields([folderField([]), folderField([5n])]);
  assert.deepEqual(
    guildFoldersFromSettings(settings).map((folder) => folder.guildIds),
    [['5']],
  );
  assert.deepEqual(guildFoldersFromSettings(''), []);
  assert.deepEqual(guildFoldersFromSettings(null), []);
  assert.deepEqual(guildFoldersFromSettings('not base64 protobuf'), []);
});
