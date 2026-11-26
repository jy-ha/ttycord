/** Discord client identity: user agent and X-Super-Properties. */

import { randomUUID } from 'node:crypto';

/**
 * The **web** client build number, taken from Discord's own `GLOBAL_ENV`
 * (`BUILD_NUMBER`) on discord.com/app. The desktop build (649389 at the time of
 * writing) is a different number, and sending it alongside a Chrome User-Agent
 * is a self-contradiction. Discord gates a few experiments on this value, but a
 * stale one still works for the REST and Gateway endpoints we use.
 */
export const CLIENT_BUILD_NUMBER =
  Number(process.env.DISCORD_CLIENT_BUILD_NUMBER) || 671535;
export const RELEASE_CHANNEL = 'stable';

/**
 * Identity strategy.
 *
 * We present a consistent **Chrome web client**: the User-Agent, the
 * `Sec-Ch-Ua` brands, the Super-Properties `browser`/`browser_version` and the
 * TLS ClientHello all say Chrome 154. Keeping them in lockstep matters because
 * `tls-client` has no Chrome 138 profile, and an Electron 138 UA in front of a
 * Chrome 154 handshake is a mismatch a fingerprint check can see directly.
 *
 * 154 is the current stable Chrome on the target machine, and `tls-client`'s
 * `Chrome_154` profile produces the same JA4/Akamai fingerprint as the real
 * browser (verified against tls.peet.ws).
 */
export const BROWSER_NAME = 'Chrome';
export const BROWSER_MAJOR = '154';
export const BROWSER_VERSION = `${BROWSER_MAJOR}.0.0.0`;

/**
 * Platform facts.
 *
 * `osVersion` is what Discord's web client derives from the User-Agent, not
 * what the OS reports: its UA parser reads `Windows NT 10.0` as `10` and
 * `Intel Mac OS X 10_15_7` as `10.15.7`, and a Linux UA carries no version at
 * all, so the field is an empty string. Sending `os.release()` here (a kernel
 * version like `6.17.9-arch1-1`) would be a value no browser can produce.
 */
function platformInfo() {
  switch (process.platform) {
    case 'win32':
      return {
        os: 'Windows',
        osVersion: '10',
        uaPlatform: 'Windows',
        uaArch: 'x64',
        ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${BROWSER_NAME}/${BROWSER_VERSION} Safari/537.36`,
      };
    case 'darwin':
      return {
        os: 'Mac OS X',
        osVersion: '10.15.7',
        uaPlatform: 'macOS',
        uaArch: process.arch === 'arm64' ? 'arm64' : 'x64',
        ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${BROWSER_NAME}/${BROWSER_VERSION} Safari/537.36`,
      };
    default:
      return {
        os: 'Linux',
        // No version in the UA, so the browser-side value is empty.
        osVersion: '',
        uaPlatform: 'Linux',
        uaArch: process.arch === 'arm64' ? 'arm64' : 'x64',
        ua: `Mozilla/5.0 (X11; Linux ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) ${BROWSER_NAME}/${BROWSER_VERSION} Safari/537.36`,
      };
  }
}

const PLATFORM = platformInfo();

export const USER_AGENT = PLATFORM.ua;
export const SEC_CH_UA_PLATFORM = `"${PLATFORM.uaPlatform}"`;

export const BASE_URL = 'https://discord.com/api/v9';
export const GATEWAY_URL = 'wss://gateway.discord.gg';

/**
 * Chromium's `Sec-Ch-Ua` GREASE brand and ordering, derived from the major
 * version. Ported from Chromium's user_agent_utils.cc so the value matches what
 * a real Chrome 154 sends rather than a hand-written approximation.
 */
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];

export function secChUa(name = BROWSER_NAME, major = BROWSER_MAJOR) {
  const seed = Number(major) || 0;
  const list = [
    `"Not${GREASE_CHARS[seed % 11]}A${GREASE_CHARS[(seed + 1) % 11]}Brand";v="${
      ['8', '99', '24'][seed % 3]
    }"`,
    `"Chromium";v="${major}"`,
    `"Google ${name}";v="${major}"`,
  ];
  const order = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ][seed % 6];
  const shuffled = new Array(3);
  order.forEach((at, i) => {
    shuffled[at] = list[i];
  });
  return shuffled.join(', ');
}

/**
 * The locale the client claims. Discord's app language and the browser's
 * Accept-Language are separate settings in reality; `TTYCORD_LOCALE`
 * drives both so they cannot contradict each other.
 */
export const LOCALE = String(process.env.TTYCORD_LOCALE || 'ko-KR');

/**
 * Discord's own locale enum (`ko`, `en-US`, `zh-CN`, ...). It is *not* a
 * BCP-47 tag: `X-Discord-Locale: ko-KR` is invalid, the Korean value is `ko`.
 * The system locale stays `ko-KR`; only the Discord header is normalised.
 */
const DISCORD_LOCALES = new Set([
  'en-US', 'en-GB', 'bg', 'zh-CN', 'zh-TW', 'hr', 'cs', 'da', 'nl', 'fi',
  'fr', 'de', 'el', 'hi', 'hu', 'it', 'ja', 'ko', 'lt', 'no', 'pl',
  'pt-BR', 'ro', 'ru', 'es-ES', 'es-419', 'sv-SE', 'th', 'tr', 'uk', 'vi',
]);

const LANGUAGE_DEFAULTS = {
  en: 'en-US',
  pt: 'pt-BR',
  zh: 'zh-CN',
  es: 'es-ES',
  sv: 'sv-SE',
};

export function discordLocale(locale = LOCALE) {
  const tag = String(locale);
  if (DISCORD_LOCALES.has(tag)) return tag;
  const language = tag.split('-')[0];
  if (DISCORD_LOCALES.has(language)) return language;
  return LANGUAGE_DEFAULTS[language] || 'en-US';
}

export function acceptLanguage(locale = LOCALE) {
  const tag = String(locale);
  const language = tag.split('-')[0];
  if (!language) return 'en-US,en;q=0.9';
  if (language.toLowerCase() === 'en') {
    return tag.includes('-') ? `${tag},en;q=0.9` : `${tag};q=0.9,en;q=0.8`;
  }
  const fallback = tag.includes('-') ? `${language};q=0.9,` : '';
  return `${tag},${fallback}en-US;q=0.8,en;q=0.7`;
}

export function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Discord uses specific UUID bits for client-mod detection. Clearing those
 * bits keeps the generated signature neutral. The version/variant bits are
 * preserved because they are part of a valid UUIDv4.
 */
export function launchSignature() {
  const bytes = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  const mask = [
    0b11111111, 0b01111111, 0b11101111, 0b11101111,
    0b11110111, 0b11101111, 0b11110111, 0b11111111,
    0b11011111, 0b01111110, 0b11111111, 0b10111111,
    0b11111110, 0b11111111, 0b11110111, 0b11111111,
  ];
  for (let i = 0; i < bytes.length; i += 1) bytes[i] &= mask[i];
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function commonProperties() {
  return {
    os: PLATFORM.os,
    browser: BROWSER_NAME,
    device: '',
    // The web client always includes this (empty for a desktop browser).
    device_model_name: '',
    system_locale: LOCALE,
    browser_user_agent: USER_AGENT,
    browser_version: BROWSER_VERSION,
    os_version: PLATFORM.osVersion,
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: RELEASE_CHANNEL,
    client_build_number: CLIENT_BUILD_NUMBER,
    client_event_source: null,
    has_client_mods: false,
    client_launch_id: randomUUID(),
  };
}

/** Properties sent on every HTTP request (X-Super-Properties). */
export function superProperties() {
  return {
    ...commonProperties(),
    client_app_state: 'focused',
    client_heartbeat_session_id: randomUUID(),
    launch_signature: launchSignature(),
  };
}

export function encodeSuperProperties() {
  return Buffer.from(JSON.stringify(superProperties()), 'utf8').toString('base64');
}

/** Properties sent in Gateway IDENTIFY. */
export function identifyProperties() {
  return {
    ...commonProperties(),
    client_app_state: 'focused',
    client_heartbeat_session_id: randomUUID(),
    launch_signature: launchSignature(),
    is_fast_connect: true,
  };
}
