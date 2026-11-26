/**
 * Read the guild order out of Discord's `PreloadedUserSettings` protobuf.
 *
 * `/users/@me/guilds` returns guilds in an unspecified order (in practice by
 * id), while the client renders them in the user's folder order. That order
 * lives in `PreloadedUserSettings.guild_folders` (field 14):
 *
 *   GuildFolders { repeated GuildFolder folders = 1;
 *                  repeated fixed64 guild_positions = 2; }   // deprecated
 *   GuildFolder  { repeated fixed64 guild_ids = 1; ... }
 *
 * We only need the field numbers, so this is a tiny generic protobuf walker
 * instead of a generated schema.
 */

function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  let at = pos;
  while (at < buf.length) {
    const byte = buf[at];
    at += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, pos: at };
    shift += 7n;
    if (shift > 63n) break;
  }
  return null;
}

/** Decode one message level into `{ field, wire, value }` entries. */
function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) break;
    pos = key.pos;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);

    if (wire === 0) {
      const value = readVarint(buf, pos);
      if (!value) break;
      pos = value.pos;
      out.push({ field, wire, value: value.value });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break;
      out.push({ field, wire, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      pos = len.pos;
      const end = pos + Number(len.value);
      if (end > buf.length) break;
      out.push({ field, wire, value: buf.subarray(pos, end) });
      pos = end;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break;
      out.push({ field, wire, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

function fixed64s(buf) {
  const ids = [];
  for (let pos = 0; pos + 8 <= buf.length; pos += 8) {
    ids.push(buf.readBigUInt64LE(pos).toString());
  }
  return ids;
}

/**
 * Unwrap a `google.protobuf.*Value` wrapper: `{ value = 1 }`. Returns the raw
 * payload for messages that store the value unwrapped.
 */
function wrapperVarint(buf) {
  const field = readFields(buf).find((entry) => entry.field === 1 && entry.wire === 0);
  return field ? field.value : null;
}

function wrapperString(buf) {
  const field = readFields(buf).find((entry) => entry.field === 1 && entry.wire === 2);
  if (field) return Buffer.from(field.value).toString('utf8');
  return Buffer.from(buf).toString('utf8');
}

export function orderGuilds(list, ids) {
  const guilds = Array.isArray(list) ? list : [];
  if (!Array.isArray(ids) || !ids.length) return [...guilds];
  const rank = new Map(ids.map((id, index) => [String(id), index]));
  const unknown = ids.length;
  return guilds
    .map((guild, index) => ({ guild, index }))
    .sort((a, b) => {
      const left = rank.has(String(a.guild.id)) ? rank.get(String(a.guild.id)) : unknown + a.index;
      const right = rank.has(String(b.guild.id)) ? rank.get(String(b.guild.id)) : unknown + b.index;
      return left - right;
    })
    .map((entry) => entry.guild);
}

/**
 * Flatten `guild_folders` into a guild id list. Returns `[]` when the payload
 * has no usable folder data, so callers can keep their current order.
 */
export function guildOrderFromSettings(settingsBase64) {
  const { folders, positions } = guildFolderData(settingsBase64);
  const ordered = folders.flatMap((folder) => folder.guildIds);
  const ids = ordered.length ? ordered : positions;
  // Deduplicate while keeping the first occurrence.
  return [...new Set(ids)];
}

/**
 * Decode the folder tree itself, not just the flattened order.
 *
 * Returns folders in display order. Discord represents a guild that is *not*
 * in a user folder as a folder with a single guild id and no name/id, so
 * callers should treat nameless folders as plain guild rows.
 */
export function guildFoldersFromSettings(settingsBase64) {
  return guildFolderData(settingsBase64).folders;
}

function guildFolderData(settingsBase64) {
  const empty = { folders: [], positions: [] };
  if (!settingsBase64 || typeof settingsBase64 !== 'string') return empty;
  let buf;
  try {
    buf = Buffer.from(settingsBase64, 'base64');
  } catch {
    return empty;
  }
  if (!buf.length) return empty;

  const settings = readFields(buf);
  const guildFolders = settings.find((entry) => entry.field === 14 && entry.wire === 2);
  if (!guildFolders) return empty;

  const fields = readFields(guildFolders.value);
  const folders = [];
  const positions = [];

  for (const entry of fields) {
    if (entry.field === 1 && entry.wire === 2) {
      const folder = { id: '', name: '', color: null, guildIds: [] };
      for (const field of readFields(entry.value)) {
        if (field.field === 1 && (field.wire === 2 || field.wire === 1)) {
          folder.guildIds.push(...fixed64s(field.value));
        } else if (field.field === 2 && field.wire === 2) {
          // id: Int64Value
          const id = wrapperVarint(field.value);
          folder.id = id === null ? '' : id.toString();
        } else if (field.field === 3 && field.wire === 2) {
          // name: StringValue
          folder.name = wrapperString(field.value);
        } else if (field.field === 4 && field.wire === 2) {
          // color: UInt64Value
          const color = wrapperVarint(field.value);
          folder.color = color === null ? null : Number(color);
        }
      }
      // Empty folders carry no row to draw; skipping them also keeps the
      // flattened order identical to what Discord shows.
      if (folder.guildIds.length) folders.push(folder);
    } else if (entry.field === 2 && entry.wire === 2) {
      positions.push(...fixed64s(entry.value));
    }
  }

  return { folders, positions };
}
