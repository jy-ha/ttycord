/**
 * Discord Gateway (WebSocket) client.
 *
 * Implements the handful of operations a text client needs: HELLO,
 * IDENTIFY, HEARTBEAT, RESUME, and dispatch fan-out. Reconnects with
 * exponential backoff, resuming the session when the server still has it.
 */

import { EventEmitter } from 'node:events';

import { GATEWAY_URL, identifyProperties } from './properties.js';

const RECONNECT_DELAYS = [1, 2, 3, 5, 8, 13, 20, 30];

/**
 * Gateway capabilities advertised in IDENTIFY.
 *
 * This is the set the current official client sends (and the one discordo
 * uses): LazyUserNotes(1) | VersionedReadStates(4) |
 * VersionedUserGuildSettings(8) | DedupeUserObjects(16) |
 * PrioritizedReadyPayload(32) | MultipleGuildExperimentPopulations(64) |
 * NonChannelReadStates(128) | AuthTokenRefresh(256) |
 * DebounceMessageReactions(8192).
 *
 * The payload-changing bits are handled by the parser: versioned read states
 * are read from `read_state.entries`, and `DedupeUserObjects` recipient stubs
 * are hydrated from the READY `users` array in `live.js`.
 */
export const DEFAULT_CAPABILITIES = 8701;

/** Close codes that mean "do not reconnect, the credentials are wrong". */
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function isFatalCloseCode(code) {
  return FATAL_CLOSE_CODES.has(Number(code));
}

export function closeReason(code) {
  switch (Number(code)) {
    case 4004:
      return 'authentication failed. Check the token.';
    case 4010:
      return 'invalid shard configuration.';
    case 4011:
      return 'sharding is required.';
    case 4012:
      return 'unsupported gateway version.';
    case 4013:
      return 'invalid intents value.';
    case 4014:
      return 'disallowed intents value.';
    case 4008:
      return 'rate limited. Try again shortly.';
    default:
      return `gateway connection closed (${code})`;
  }
}

export class Gateway extends EventEmitter {
  constructor({
    token,
    properties = identifyProperties(),
    capabilities = DEFAULT_CAPABILITIES,
    presence = { status: 'online', since: 0, activities: [], afk: false },
    url = GATEWAY_URL,
    // When set, always reconnect through `url` even if READY advertised a
    // resume_gateway_url.
    urlLocked = false,
    // Maps a remote gateway URL to a local one plus per-connect headers. Used
    // by the TLS-spoofing proxy so RESUME can follow READY's shard host.
    urlRewrite = null,
    // A heartbeat should be acknowledged within this window. Waiting for the
    // next interval (41s) made a dead socket after suspend look like a freeze.
    ackTimeout = 10_000,
    // A connection that never opens, or opens but never sends HELLO, must not
    // hang forever (common when the network is still coming back after wake).
    connectTimeout = 20_000,
    helloTimeout = 20_000,
    // Belt-and-braces: a quiet, half-open socket is reconnected even if the
    // heartbeat timer itself was lost or throttled.
    watchdogInterval = 5_000,
    staleAfter = null,
    debug = null,
  } = {}) {
    super();
    if (!token) throw new Error('Discord token is required');
    this.token = token;
    this.properties = properties;
    this.capabilities = capabilities;
    this.presence = presence;
    this.url = url;
    this.urlLocked = urlLocked;
    this.urlRewrite = urlRewrite;
    this.debug = debug;

    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.userId = null;

    this.heartbeatTimer = null;
    this.ackTimer = null;
    this.connectTimer = null;
    this.helloTimer = null;
    this.heartbeatInterval = 41_250;
    this.ackTimeout = ackTimeout;
    this.acked = true;
    this.connectTimeout = connectTimeout;
    this.helloTimeout = helloTimeout;
    this.watchdogInterval = watchdogInterval;
    this.staleAfter = staleAfter;
    this.watchdogTimer = null;
    this.lastActivityAt = 0;

    this.attempt = 0;
    this.reconnectTimer = null;
    this.stopping = false;
    this.state = 'offline';
    this.connected = false;
  }

  setState(state, extra = {}) {
    if (this.state === state && !extra.force) return;
    this.state = state;
    this.emit('state', { state, ...extra });
  }

  connect() {
    if (this.stopping) return;
    this.clearReconnect();
    this.clearConnectTimers();
    this.startWatchdog();
    this.setState(this.connected ? 'retrying' : 'connecting', { force: true });

    const base =
      !this.urlLocked && this.sessionId && this.resumeUrl ? this.resumeUrl : this.url;
    let target = `${base.replace(/\/$/, '')}/?v=9&encoding=json`;
    let headers;
    if (this.urlRewrite) {
      try {
        ({ url: target, headers } = this.urlRewrite(target));
      } catch (error) {
        this.debug?.(`gateway url rewrite failed: ${error.message}`);
        this.scheduleReconnect(Boolean(this.sessionId));
        return;
      }
    }
    this.debug?.(`gateway connect ${this.sessionId ? 'resume' : 'fresh'} ${target}`);

    let socket;
    try {
      socket = headers ? new WebSocket(target, { headers }) : new WebSocket(target);
    } catch (error) {
      this.debug?.(`gateway socket error: ${error.message}`);
      this.scheduleReconnect(Boolean(this.sessionId));
      return;
    }
    this.ws = socket;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.stopping || this.ws !== socket) return;
      this.debug?.('gateway connect timeout; retrying');
      this.reconnect(Boolean(this.sessionId), { immediate: true });
    }, this.connectTimeout);
    this.connectTimer.unref?.();

    socket.addEventListener('open', () => {
      if (this.ws !== socket) return;
      this.connected = true;
      this.lastActivityAt = Date.now();
      this.clearConnectTimer();
      this.armHelloTimeout();
      this.debug?.('gateway open');
    });

    socket.addEventListener('message', (event) => {
      if (this.ws !== socket) return;
      let payload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        this.debug?.('gateway sent invalid JSON');
        return;
      }
      this.handlePayload(payload);
    });

    socket.addEventListener('error', () => {
      // The close event carries the actionable code; just note the failure.
      this.debug?.('gateway socket error event');
    });

    socket.addEventListener('close', (event) => {
      if (this.ws !== socket) return;
      this.connected = false;
      this.ws = null;
      this.clearConnectTimers();
      this.stopHeartbeat();
      this.handleClose(event.code, event.reason);
    });
  }

  handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    this.lastActivityAt = Date.now();
    if (payload.s !== undefined && payload.s !== null) this.seq = payload.s;

    switch (payload.op) {
      case 0:
        this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.debug?.('gateway requested reconnect');
        this.reconnect(true);
        break;
      case 9:
        this.handleInvalidSession(payload.d);
        break;
      case 10:
        this.clearHelloTimer();
        this.heartbeatInterval = Number(payload.d?.heartbeat_interval) || 41_250;
        this.startHeartbeat();
        if (this.sessionId && this.seq !== null) this.sendResume();
        else this.sendIdentify();
        break;
      case 11:
        this.acked = true;
        this.clearAckTimer();
        break;
      default:
        break;
    }
  }

  handleDispatch(payload) {
    const { t, d } = payload;
    if (t === 'READY') {
      this.sessionId = d?.session_id || null;
      this.resumeUrl = this.urlLocked ? null : d?.resume_gateway_url || null;
      this.userId = d?.user?.id || null;
      this.attempt = 0;
      this.setState('online', { force: true });
      this.emit('ready', d);
    } else if (t === 'RESUMED') {
      this.attempt = 0;
      this.setState('online', { force: true });
      this.emit('resumed', d);
    }
    this.emit('dispatch', { t, d, s: payload.s });
    if (t) this.emit(`dispatch:${t}`, d);
  }

  sendIdentify() {
    this.debug?.('gateway identify');
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: this.capabilities,
        properties: this.properties,
        compress: false,
        presence: this.presence,
      },
    });
  }

  sendResume() {
    this.debug?.(`gateway resume seq=${this.seq}`);
    this.send({
      op: 6,
      d: { token: this.token, session_id: this.sessionId, seq: this.seq },
    });
  }

  sendHeartbeat() {
    this.acked = false;
    this.send({ op: 1, d: this.seq });
    this.armAckTimeout();
  }

  /**
   * Do not wait a full heartbeat interval to notice a half-open socket (the
   * usual state after a laptop resumes from suspend).
   */
  armAckTimeout() {
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.stopping || this.acked) return;
      this.debug?.('gateway heartbeat ACK timeout; reconnecting');
      this.reconnect(Boolean(this.sessionId));
    }, this.ackTimeout);
    this.ackTimer.unref?.();
  }

  clearAckTimer() {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  clearHelloTimer() {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  clearConnectTimers() {
    this.clearConnectTimer();
    this.clearHelloTimer();
  }

  /** A new socket must answer HELLO in time; otherwise it is a dead end. */
  armHelloTimeout() {
    this.clearHelloTimer();
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.stopping || this.state === 'online') return;
      this.debug?.('gateway HELLO timeout; retrying');
      this.reconnect(Boolean(this.sessionId), { immediate: true });
    }, this.helloTimeout);
    this.helloTimer.unref?.();
  }

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkHealth(), this.watchdogInterval);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** How long a healthy (but quiet) gateway may go without any payload. */
  watchdogStaleAfter() {
    return this.staleAfter ?? Math.max(90_000, this.heartbeatInterval * 2 + this.ackTimeout);
  }

  /**
   * Reconnect a socket that stopped producing payloads. Normally the 10s ACK
   * watchdog catches this, but this also covers a lost/throttled heartbeat
   * timer after a long background stay or a suspend.
   */
  checkHealth() {
    if (this.stopping || this.state !== 'online') return;
    if (this.ws?.readyState !== 1 || !this.lastActivityAt) return;
    const idle = Date.now() - this.lastActivityAt;
    if (idle <= this.watchdogStaleAfter()) return;
    this.debug?.(`gateway watchdog: no payload for ${idle}ms; reconnecting`);
    this.reconnect(Boolean(this.sessionId), { immediate: true });
  }

  send(payload) {
    if (this.ws?.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.debug?.(`gateway send failed: ${error.message}`);
      return false;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.acked = true;
    // Discord asks clients to wait a random fraction of the interval first.
    const first = Math.floor(this.heartbeatInterval * Math.random());
    this.heartbeatTimer = setTimeout(() => {
      if (this.stopping) return;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.stopping) return;
        if (!this.acked) {
          this.debug?.('gateway heartbeat not acknowledged; reconnecting');
          this.reconnect(true);
          return;
        }
        this.sendHeartbeat();
      }, this.heartbeatInterval);
      this.heartbeatTimer.unref?.();
    }, first);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    // Node's clearTimeout/clearInterval are interchangeable for Timeout handles.
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearAckTimer();
  }

  /**
   * Called after the process wakes from suspend (or regains the foreground).
   * A socket can look open while its peer is long gone, so probe a live one
   * and reconnect immediately instead of waiting for the next heartbeat.
   */
  wake() {
    if (this.stopping) return;
    this.clearReconnect();
    this.attempt = 0;
    if (this.ws?.readyState === 1) {
      // A sleeping machine leaves the socket open but produces no payloads.
      // Skip the probe and reconnect immediately; waiting 10s for an ACK is
      // what made the app look frozen after resume.
      const maxIdle = this.staleAfter ?? Math.max(60_000, this.heartbeatInterval + this.ackTimeout);
      const idle = this.lastActivityAt ? Date.now() - this.lastActivityAt : 0;
      if (!this.acked || idle > maxIdle) {
        this.debug?.(`gateway wake stale (${idle}ms); reconnecting`);
        this.reconnect(Boolean(this.sessionId), { immediate: true });
        return;
      }
      this.debug?.('gateway wake probe');
      this.sendHeartbeat();
      return;
    }
    this.debug?.('gateway wake reconnect');
    this.reconnect(Boolean(this.sessionId), { immediate: true });
  }

  handleInvalidSession(resumable) {
    this.debug?.(`gateway invalid session resumable=${resumable}`);
    if (resumable === true && this.sessionId) {
      // Discord recommends a short random wait before resuming.
      const delay = 1_000 + Math.floor(Math.random() * 4_000);
      this.setState('retrying', { force: true, delay });
      setTimeout(() => {
        if (this.stopping) return;
        this.reconnect(true);
      }, delay).unref?.();
      return;
    }
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
    this.reconnect(false);
  }

  handleClose(code, reason) {
    this.debug?.(`gateway close ${code} ${reason || ''}`);
    if (this.stopping) {
      this.setState('stopped', { force: true });
      return;
    }
    if (isFatalCloseCode(code)) {
      this.setState('offline', { force: true, fatal: true });
      const error = new Error(closeReason(code));
      error.code = code;
      error.fatal = true;
      this.emit('fatal', error);
      return;
    }
    this.scheduleReconnect(Boolean(this.sessionId));
  }

  reconnect(resume = true, { immediate = false } = {}) {
    if (this.stopping) return;
    this.closeSocket();
    this.stopHeartbeat();
    this.scheduleReconnect(resume, { immediate });
  }

  scheduleReconnect(resume = true, { immediate = false } = {}) {
    if (this.stopping || this.reconnectTimer) return;
    if (!resume) {
      this.sessionId = null;
      this.resumeUrl = null;
      this.seq = null;
    }
    const seconds = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt += 1;
    const delay = immediate ? 0 : Math.round(seconds * 1000 + Math.random() * 500);
    this.setState('retrying', { force: true, delay, resume });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  closeSocket() {
    const socket = this.ws;
    this.ws = null;
    this.connected = false;
    this.clearConnectTimers();
    if (!socket) return;
    try {
      socket.close(1000, 'client shutdown');
    } catch {
      /* already closed */
    }
  }

  close() {
    if (this.stopping) return;
    this.stopping = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.clearAckTimer();
    this.clearConnectTimers();
    this.stopWatchdog();
    this.closeSocket();
    this.setState('stopped', { force: true });
  }
}
