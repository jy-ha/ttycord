/**
 * Minimal Discord REST client.
 *
 * Handles the headers the official desktop client sends, serialises requests
 * to stay friendly to the per-route rate limit buckets, and retries 429/5xx
 * responses. No third-party dependencies.
 */

import {
  BASE_URL,
  SEC_CH_UA_PLATFORM,
  USER_AGENT,
  acceptLanguage,
  discordLocale,
  encodeSuperProperties,
  secChUa,
  timezone,
} from './properties.js';
import { sleep } from '../util.js';

export class DiscordError extends Error {
  constructor(message, { status = 0, code = 0, body = null, retryAfter = 0, method = '', path = '' } = {}) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfter = retryAfter;
    this.method = method;
    this.path = path;
  }
}

function authHeader(token, type) {
  const value = String(token || '').trim();
  if (!value) return '';
  if (/^(Bot|Bearer)\s/i.test(value)) return value;
  if (type === 'bot') return `Bot ${value}`;
  if (type === 'bearer') return `Bearer ${value}`;
  return value;
}

/**
 * The header set a Chrome 154 Discord web client sends. Shared by the REST
 * client and token validation so a probe cannot distinguish the two by their
 * headers (Chrome always sends Sec-Ch-Ua on secure origins).
 */
export function discordHeaders({
  token,
  tokenType = 'user',
  userAgent = USER_AGENT,
  superProperties = encodeSuperProperties(),
  method = 'GET',
} = {}) {
  const headers = {
    Authorization: authHeader(token, tokenType),
    'User-Agent': userAgent,
    Accept: '*/*',
    'Accept-Language': acceptLanguage(),
    // Chrome also advertises zstd, but Node's undici cannot decode it. The
    // --spoof proxy replaces this with Chrome's full value and decodes the
    // response itself; without the proxy we stay at what undici can handle.
    'Accept-Encoding': 'gzip, deflate, br',
    'X-Super-Properties': superProperties,
    'X-Discord-Locale': discordLocale(),
    'X-Discord-Timezone': timezone(),
    'X-Debug-Options': 'bugReporterEnabled',
    Referer: 'https://discord.com/channels/@me',
    Priority: 'u=1, i',
    'Sec-Ch-Ua': secChUa(),
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': SEC_CH_UA_PLATFORM,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  // Chrome only adds Origin for methods that are not GET/HEAD on a
  // same-origin request (verified against Chrome 154). Sending it on GET is
  // an extra header a real browser never produces.
  if (!/^(GET|HEAD)$/i.test(method)) {
    headers.Origin = 'https://discord.com';
  }
  return headers;
}

function routeKey(method, path) {
  const normalized = path
    .split('?')[0]
    .replace(/\/\d{5,}/g, '/:id');
  return `${method.toUpperCase()} ${normalized}`;
}

function retryAfterSeconds(body, headers) {
  const header = Number(headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const value = Number(body?.retry_after);
  if (Number.isFinite(value) && value > 0) return value;
  return 1;
}

export class RestClient {
  constructor({
    token,
    tokenType = 'user',
    baseUrl = BASE_URL,
    userAgent = USER_AGENT,
    fetchImpl = globalThis.fetch,
    // arikawa (and therefore discordo) adds a 250ms cushion on top of every
    // bucket reset. We are deliberately faster than that but still well under
    // a burst, because the TUI serialises every call anyway.
    minInterval = 120,
    maxRetries = 2,
    timeout = 20_000,
    debug = null,
  } = {}) {
    if (!token) throw new Error('Discord token is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    this.token = token;
    this.tokenType = tokenType;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.minInterval = minInterval;
    this.maxRetries = maxRetries;
    this.timeout = timeout;
    this.debug = debug;
    this.superProperties = encodeSuperProperties();
    this.globalUntil = 0;
    this.buckets = new Map();
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
  }

  headers(extra = {}, method = 'GET') {
    return {
      ...discordHeaders({
        token: this.token,
        tokenType: this.tokenType,
        userAgent: this.userAgent,
        superProperties: this.superProperties,
        method,
      }),
      ...extra,
    };
  }

  /** Serialise calls and keep a small gap between requests. */
  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async _waitForRoute(key) {
    const bucket = this.buckets.get(key);
    const now = Date.now();
    let wait = Math.max(0, this.globalUntil - now);
    if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
      wait = Math.max(wait, bucket.resetAt - now);
    }
    const spacing = this.lastRequestAt + this.minInterval - now;
    if (spacing > 0) wait = Math.max(wait, spacing);
    if (wait > 0) await sleep(wait);
  }

  _observe(key, headers) {
    const now = Date.now();
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const resetAfter = Number(headers.get('x-ratelimit-reset-after'));
    const bucketId = headers.get('x-ratelimit-bucket');
    if (Number.isFinite(remaining)) {
      this.buckets.set(bucketId || key, {
        remaining,
        resetAt: now + (Number.isFinite(resetAfter) ? resetAfter * 1000 : 1000),
      });
      if (bucketId) this.buckets.set(key, this.buckets.get(bucketId));
    }
    this.lastRequestAt = now;
  }

  async request(method, path, { body, form, query, auth = true, retries = this.maxRetries, timeout = this.timeout } = {}) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    let url = `${this.baseUrl}${cleanPath}`;
    if (query && Object.keys(query).length) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
    }

    // Multipart bodies must let fetch add its own boundary: setting
    // Content-Type by hand produces an unusable request.
    const multipart = typeof FormData !== 'undefined' && form instanceof FormData;
    const key = routeKey(method, cleanPath);
    const headers = this.headers(
      { ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      method,
    );
    if (!auth) {
      delete headers.Authorization;
    }
    const payload = multipart ? form : body === undefined ? undefined : JSON.stringify(body);

    return this._enqueue(async () => {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        await this._waitForRoute(key);
        const started = Date.now();
        let response;
        try {
          response = await this.fetchImpl(url, {
            method: method.toUpperCase(),
            headers,
            body: payload,
            signal: AbortSignal.timeout(timeout),
          });
        } catch (error) {
          if (attempt < retries) {
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw new DiscordError(`네트워크 오류: ${error.message}`, { method, path: cleanPath });
        }

        this._observe(key, response.headers);
        const text = await response.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }

        if (response.status === 429) {
          const seconds = retryAfterSeconds(data, response.headers);
          const global = response.headers.get('x-ratelimit-global') === 'true' || Boolean(data?.global);
          if (global) this.globalUntil = Date.now() + seconds * 1000;
          this.debug?.(`REST 429 ${method} ${cleanPath} retry=${seconds}s global=${global}`);
          if (attempt < retries) {
            await sleep(Math.ceil(seconds * 1000) + 75);
            continue;
          }
          throw new DiscordError(`요청 한도 초과 (${Math.ceil(seconds)}초 후 다시 시도)`, {
            status: 429,
            code: data?.code || 0,
            body: data,
            retryAfter: seconds,
            method,
            path: cleanPath,
          });
        }

        if (response.status >= 500 && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          const message =
            data && typeof data === 'object' && data.message
              ? data.message
              : typeof data === 'string' && data
                ? data
                : response.statusText || '요청 실패';
          throw new DiscordError(`Discord API ${response.status}: ${message}`, {
            status: response.status,
            code: data?.code || 0,
            body: data,
            method,
            path: cleanPath,
          });
        }

        this.debug?.(
          `REST ${method} ${cleanPath} ${response.status} ${Date.now() - started}ms`,
        );
        return data;
      }
      throw new DiscordError('요청에 실패했습니다', { method, path: cleanPath });
    });
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }

  patch(path, body, options = {}) {
    return this.request('PATCH', path, { ...options, body });
  }

  put(path, body, options = {}) {
    return this.request('PUT', path, { ...options, body });
  }

  delete(path, options = {}) {
    return this.request('DELETE', path, options);
  }

  // ------------------------------------------------------------------ routes
  me() {
    return this.get('/users/@me');
  }

  myGuilds() {
    return this.get('/users/@me/guilds');
  }

  /**
   * Serialized `PreloadedUserSettings` (type 1). Read-only, and the only place
   * the user's guild folder order is exposed.
   */
  userSettingsProto(type = 1) {
    return this.get(`/users/@me/settings-proto/${type}`);
  }

  guildChannels(guildId) {
    return this.get(`/guilds/${guildId}/channels`);
  }

  privateChannels() {
    return this.get('/users/@me/channels');
  }

  channel(channelId) {
    return this.get(`/channels/${channelId}`);
  }

  messages(channelId, { limit = 50, before, after, around } = {}) {
    return this.get(`/channels/${channelId}/messages`, {
      query: { limit, before, after, around },
    });
  }

  sendMessage(channelId, content, { nonce, replyTo, tts = false } = {}) {
    const body = { content, tts, nonce: nonce || String(Date.now()) };
    if (replyTo) {
      body.message_reference = { message_id: replyTo, channel_id: channelId };
    }
    return this.post(`/channels/${channelId}/messages`, body);
  }

  /**
   * Send a message with attachments.
   *
   * Discord expects `payload_json` plus `files[n]` parts whose index matches
   * the `attachments[n].id` in the payload. Each file is `{ filename,
   * contentType, data }` where data is a Buffer/Uint8Array/Blob.
   */
  sendMessageWithFiles(channelId, content, files, { nonce, replyTo, tts = false } = {}) {
    const list = Array.from(files || []);
    if (!list.length) return this.sendMessage(channelId, content, { nonce, replyTo, tts });
    const payload = {
      content,
      tts,
      nonce: nonce || String(Date.now()),
      attachments: list.map((file, index) => ({
        id: index,
        filename: file.filename || `file-${index}`,
      })),
    };
    if (replyTo) {
      payload.message_reference = { message_id: replyTo, channel_id: channelId };
    }

    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    list.forEach((file, index) => {
      const type = file.contentType || 'application/octet-stream';
      const blob =
        typeof Blob !== 'undefined' && file.data instanceof Blob
          ? file.data
          : new Blob([file.data ?? ''], { type });
      form.append(`files[${index}]`, blob, file.filename || `file-${index}`);
    });
    return this.request('POST', `/channels/${channelId}/messages`, {
      form,
      // A 10 MB upload on a slow uplink can easily outlive the default 20 s.
      timeout: 120_000,
    });
  }

  editMessage(channelId, messageId, content) {
    return this.patch(`/channels/${channelId}/messages/${messageId}`, { content });
  }

  deleteMessage(channelId, messageId) {
    return this.delete(`/channels/${channelId}/messages/${messageId}`);
  }

  /**
   * React with a unicode emoji. Discord wants the raw character in the path,
   * percent-encoded by us; custom emoji would be `name:id` instead.
   */
  addReaction(channelId, messageId, emoji) {
    return this.request(
      'PUT',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  removeReaction(channelId, messageId, emoji) {
    return this.request(
      'DELETE',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  ack(channelId, messageId) {
    // Undocumented but used by every official client. The body token is
    // accepted as null and is only meaningful for the newer inbox UI.
    return this.post(`/channels/${channelId}/messages/${messageId}/ack`, { token: null });
  }

  typing(channelId) {
    return this.post(`/channels/${channelId}/typing`, undefined);
  }
}
