/**
 * Phosphor-terminal palette.
 *
 * Deliberately not Discord's palette: near-black background, one dominant
 * green, amber for warnings. Chrome is ASCII, not emoji or Discord glyphs.
 */

import { style } from './term.js';

export const C = {
  bg: '#080b08',
  panel: '#0b0f0b',
  surface: '#070a07',
  surfaceAlt: '#0b0f0b',
  raised: '#142014',
  line: '#1b2b1b',
  lineSoft: '#131f13',
  text: '#b9e6b9',
  textDim: '#7fae7f',
  textFaint: '#557a55',
  textGhost: '#33502f',
  accent: '#49ff9c',
  accentDim: '#2fbf74',
  green: '#49ff9c',
  amber: '#ffb454',
  red: '#ff6b6b',
  blue: '#5fd7ff',
  purple: '#c9a0ff',
  railBg: '#080b08',
  railSel: '#0f2a1b',
  railHover: '#142014',
  ownBg: '#070a07',
  otherBg: '#070a07',
  mentionBg: '#0f2a1b',
  cursorBg: '#16281c',
  mentionFg: '#d7ffe6',
  selectedBg: '#0f2a1b',
  selectedFg: '#49ff9c',
  unread: '#b9e6b9',
  badgeBg: '#49ff9c',
  badgeFg: '#04120a',
  mutedBadgeBg: '#1b2b1b',
  mutedBadgeFg: '#7fae7f',
  overlay: '#050705',
  codeBg: '#10201a',
  codeFg: '#a8ffd0',
};

export const T = {
  screen: style(C.text, C.bg),

  topbar: style(C.textFaint, C.panel),
  brand: style(C.accent, C.panel, { bold: true }),
  topName: style(C.textDim, C.panel),
  topDim: style(C.textGhost, C.panel),
  clock: style(C.textDim, C.panel, { bold: true }),
  topSep: style(C.textGhost, C.panel),

  rail: style(C.textDim, C.railBg),
  railDim: style(C.textGhost, C.railBg),
  railSel: style(C.text, C.railSel),
  railFolder: style(C.amber, C.railBg, { bold: true }),
  railFolderSel: style(C.amber, C.railSel, { bold: true }),
  railIcon: style(C.textGhost, C.railBg),
  railIconSel: style(C.accent, C.railSel, { bold: true }),
  railIconUnread: style(C.text, C.railBg, { bold: true }),
  railName: style(C.textDim, C.railBg),
  railNameSel: style(C.accent, C.railSel, { bold: true }),
  railBar: style(C.accent, C.railBg),
  railMark: style(C.accent, C.railBg, { bold: true }),

  sidebar: style(C.text, C.panel),
  sideTitle: style(C.accent, C.panel, { bold: true }),
  sideDim: style(C.textGhost, C.panel),
  sideSep: style(C.textGhost, C.panel),
  sideCategory: style(C.textGhost, C.panel, { bold: true }),
  // Mouse-drag selection overlay: dark text on the accent colour.
  selection: style(C.bg, C.accent),
  channel: style(C.textDim, C.panel),
  channelUnread: style(C.text, C.panel, { bold: true }),
  channelSel: style(C.selectedFg, C.selectedBg, { bold: true }),
  channelIcon: style(C.textGhost, C.panel),
  channelIconSel: style(C.accent, C.selectedBg),
  channelMark: style(C.accent, C.panel, { bold: true }),
  badge: style(C.amber, C.panel, { bold: true }),
  badgeMuted: style(C.mutedBadgeFg, C.panel),

  chat: style(C.text, C.surface),
  chatHeader: style(C.accent, C.surface, { bold: true }),
  chatTopic: style(C.textFaint, C.surface),
  chatDivider: style(C.line, C.surface),
  chatSep: style(C.textGhost, C.surface),

  // Split view: the focused column gets a tinted header, the others recede.
  paneHeaderFocus: style(C.accent, C.railSel, { bold: true }),
  paneHeaderFocusIcon: style(C.accentDim, C.railSel),
  paneHeader: style(C.textDim, C.surface),
  paneHeaderIcon: style(C.textGhost, C.surface),
  paneHeaderTopic: style(C.textFaint, C.surface),
  paneHeaderMeta: style(C.textGhost, C.surface),
  paneHeaderMetaFocus: style(C.accentDim, C.railSel),
  paneDivider: style(C.line, C.bg),
  paneDividerFocus: style(C.accentDim, C.bg),

  msgAuthor: style(C.text, C.surface, { bold: true }),
  msgText: style(C.text, C.surface),
  msgDim: style(C.textDim, C.surface),
  msgFaint: style(C.textFaint, C.surface),
  msgTime: style(C.textGhost, C.surface),
  msgMention: style(C.mentionFg, C.mentionBg),
  msgMentionBar: style(C.amber, C.mentionBg, { bold: true }),
  msgMentionAuthor: style(C.mentionFg, C.mentionBg, { bold: true }),
  msgCode: style(C.codeFg, C.codeBg),
  codePlain: style(C.codeFg, C.codeBg),
  codeKeyword: style(C.accent, C.codeBg, { bold: true }),
  codeString: style(C.amber, C.codeBg),
  codeNumber: style(C.blue, C.codeBg),
  codeComment: style(C.textFaint, C.codeBg, { italic: true }),
  codePunct: style(C.textDim, C.codeBg),
  codeFunc: style(C.purple, C.codeBg),
  codeBuiltin: style(C.blue, C.codeBg),
  codeAdd: style(C.green, C.codeBg),
  codeDel: style(C.red, C.codeBg),
  codeHunk: style(C.blue, C.codeBg),
  codeLabel: style(C.textGhost, C.codeBg),
  msgBot: style(C.textGhost, C.surface),
  msgOwnTag: style(C.textGhost, C.surface),

  // Message cursor: the row band the action keys apply to.
  msgCursor: style(C.text, C.cursorBg),
  msgCursorBar: style(C.accent, C.cursorBg, { bold: true }),
  msgCursorGutter: style(C.accent, C.surface, { bold: true }),
  reaction: style(C.textDim, C.surface),
  reactionMine: style(C.accent, C.surface, { bold: true }),
  reactionCount: style(C.textGhost, C.surface),

  banner: style(C.amber, C.surface),
  bannerKey: style(C.textGhost, C.surface),

  divider: style(C.lineSoft, C.surface),
  dividerText: style(C.textGhost, C.surface),
  newDivider: style(C.badgeFg, C.badgeBg, { bold: true }),

  composer: style(C.text, C.surface),
  composerBar: style(C.line, C.surface),
  composerBarFocus: style(C.accentDim, C.surface),
  composerPrompt: style(C.accent, C.surface, { bold: true }),
  composerPromptDim: style(C.textGhost, C.surface),
  composerText: style(C.text, C.surface),
  composerTextDim: style(C.textDim, C.surface),
  composerPlaceholder: style(C.textGhost, C.surface),
  composerAttach: style(C.amber, C.surface),
  composerHint: style(C.textGhost, C.surface),

  menuBorder: style(C.line, C.overlay),
  menuBg: style(C.text, C.overlay),
  menuSel: style(C.bg, C.accent, { bold: true }),
  menuKey: style(C.accent, C.overlay, { bold: true }),
  menuDim: style(C.textGhost, C.overlay),
  menuDanger: style(C.red, C.overlay, { bold: true }),

  typing: style(C.textGhost, C.surface),
  typingName: style(C.textDim, C.surface),

  status: style(C.textGhost, C.panel),
  statusKey: style(C.textFaint, C.panel, { bold: true }),
  statusAccent: style(C.accent, C.panel, { bold: true }),
  statusSep: style(C.textGhost, C.panel),

  helpBg: style(C.text, C.overlay),
  helpTitle: style(C.accent, C.overlay, { bold: true }),
  helpKey: style(C.text, C.overlay, { bold: true }),
  helpText: style(C.textDim, C.overlay),
  helpDim: style(C.textGhost, C.overlay),
  helpBorder: style(C.line, C.overlay),

  toast: style(C.text, C.raised, { bold: true }),
  toastError: style(C.badgeFg, C.red, { bold: true }),
  toastOk: style(C.badgeFg, C.green, { bold: true }),

  loading: style(C.textFaint, C.surface),
  empty: style(C.textGhost, C.surface),
  error: style(C.red, C.surface),
};

const AUTHOR_COLORS = [
  '#7ee787',
  '#79c0ff',
  '#ffa657',
  '#d2a8ff',
  '#ff7b72',
  '#56d4dd',
  '#e3b341',
  '#a5d6ff',
];

export function authorColor(id) {
  const text = String(id || '0');
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 100_000;
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length];
}
