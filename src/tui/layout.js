/** Geometry for the guild rail, channel sidebar, chat pane and composer. */

import { MAX_COMPOSER_LINES } from './composer.js';

export const RAIL_WIDTH = 18;
export const MIN_SIDEBAR = 18;
export const MIN_CHAT = 26;
/** Split view shows at most four channels (2x2 grid). */
export const MAX_PANES = 4;
/** Below this a pane stops being readable; the app suggests wide mode. */
export const MIN_PANE_WIDTH = 18;
/** Pending attachment rows shown above the composer hint (the rest collapse
 * into a single `+N more` row). */
export const MAX_ATTACHMENT_ROWS = 4;

export function composerAttachmentRows(count = 0) {
  const total = Math.max(0, Math.trunc(Number(count) || 0));
  return Math.min(total, MAX_ATTACHMENT_ROWS) + (total > MAX_ATTACHMENT_ROWS ? 1 : 0);
}

export function railWidth(cols) {
  if (cols >= 100) return 20;
  if (cols >= 80) return 18;
  if (cols >= 68) return 15;
  return 0;
}

export function sidebarWidth(cols, rail = RAIL_WIDTH) {
  const available = cols - rail;
  if (available >= 120) return 32;
  if (available >= 100) return 28;
  if (available >= 80) return 24;
  return Math.max(MIN_SIDEBAR, Math.min(24, available - MIN_CHAT));
}

/**
 * Lay out the shell and the chat area.
 *
 * `panes` is the number of visible channels (1..MAX_PANES) and `focus` picks
 * which pane the legacy single-pane rects (`chat`, `messages`, `composer`,
 * ...) point at. One pane fills the chat area, two sit side by side, three are
 * two on top plus one spanning the bottom, and four form a 2x2 grid. Every
 * pane has its own header/messages/typing/composer stack so panes stay aligned
 * even when drafts differ in length; the caller passes the tallest draft's
 * line count and attachment rows for all of them.
 */
export function computeLayout(
  cols,
  rows,
  {
    status = true,
    wide = false,
    attachments = 0,
    composerLines = 1,
    banner = 0,
    panes = 1,
    focus = 0,
  } = {},
) {
  const rail = wide ? 0 : railWidth(cols);
  const sidebar = wide ? 0 : Math.max(0, Math.min(sidebarWidth(cols, rail), cols - rail - MIN_CHAT));
  const top = 1;
  const statusH = status ? 1 : 0;
  const bodyH = Math.max(4, rows - top - statusH);
  const chatX = rail + sidebar;
  const chatW = Math.max(1, cols - chatX);
  const attachmentRows = composerAttachmentRows(attachments);
  const lines = Math.max(1, Math.min(Math.trunc(Number(composerLines) || 1), MAX_COMPOSER_LINES));
  // Top border, N text rows, attachment rows, an optional reply/edit banner,
  // and one hint row.
  const bannerH = banner ? 1 : 0;
  const composerH = 2 + lines + attachmentRows + bannerH;
  const typingH = 1;
  const headerH = 2;
  // Smallest row that still has one message line plus a full composer.
  const minRowH = headerH + typingH + composerH + 1;

  const count = clamp(Math.trunc(Number(panes) || 1), 1, MAX_PANES);
  // Three and four panes stack into two rows when the terminal is tall enough.
  // On a short terminal, fall back to a single row so a pane never loses its
  // composer to the row above it.
  let rowCount = count <= 2 ? 1 : 2;
  if (rowCount === 2 && bodyH < minRowH * 2 + 1) rowCount = 1;
  const rowPaneCounts = rowCount === 1 ? [count] : count === 3 ? [2, 1] : [2, 2];
  const maxCols = Math.max(...rowPaneCounts);

  // One divider column between neighbours. On an absurdly narrow terminal the
  // gaps would eat the whole area, so drop them and let some columns collapse
  // to zero width instead of drawing outside the screen.
  const vgap = maxCols > 1 && chatW >= maxCols * 2 ? 1 : 0;
  const usableW = Math.max(0, chatW - vgap * (maxCols - 1));
  const baseW = Math.floor(usableW / maxCols);
  let remainderW = usableW - baseW * maxCols;
  const widths = [];
  for (let index = 0; index < maxCols; index += 1) {
    // Spread the rounding remainder over the leftmost columns.
    widths.push(baseW + (remainderW > 0 ? 1 : 0));
    if (remainderW > 0) remainderW -= 1;
  }

  // Rows share the body height evenly; the top row gets any odd row.
  const rowHeights = [];
  if (rowCount === 1) {
    rowHeights.push(bodyH);
  } else {
    const usableH = Math.max(0, bodyH - 1);
    const baseH = Math.floor(usableH / 2);
    rowHeights.push(baseH + (usableH - baseH * 2), baseH);
  }

  const columns = [];
  const bands = [];
  let paneIndex = 0;
  let y = top;
  for (let row = 0; row < rowCount; row += 1) {
    const rowH = rowHeights[row];
    const rowCountPanes = rowPaneCounts[row];
    // A row with a single pane (the bottom of the three-pane layout) spans the
    // whole chat width instead of snapping to the two-column grid.
    const rowWidths = rowCountPanes === 1 ? [chatW] : widths.slice(0, rowCountPanes);
    const messagesH = Math.max(1, rowH - headerH - typingH - composerH);
    const rowPanes = [];
    let x = chatX;
    for (let col = 0; col < rowCountPanes; col += 1) {
      const width = rowWidths[col];
      columns.push({
        index: paneIndex,
        row,
        col,
        chat: { x, y, width, height: rowH },
        header: { x, y, width, height: headerH },
        messages: { x, y: y + headerH, width, height: messagesH },
        typing: { x, y: y + headerH + messagesH, width, height: typingH },
        composer: {
          x,
          y: y + headerH + messagesH + typingH,
          width,
          height: composerH,
          banner: bannerH,
        },
      });
      rowPanes.push(paneIndex);
      paneIndex += 1;
      x += width + (col < rowCountPanes - 1 ? vgap : 0);
    }
    bands.push({ index: row, y, height: rowH, panes: rowPanes });
    y += rowH + (row < rowCount - 1 ? 1 : 0);
  }

  // Divider geometry lives here so the view layer never has to guess where a
  // row ends or which columns meet at a junction.
  const dividers = { vertical: [], horizontal: [] };
  for (const band of bands) {
    if (band.panes.length < 2 || vgap === 0) continue;
    for (let index = 1; index < band.panes.length; index += 1) {
      const left = columns[band.panes[index - 1]];
      const right = columns[band.panes[index]];
      const x = left.chat.x + left.chat.width;
      if (right.chat.x !== x + vgap) continue;
      dividers.vertical.push({
        x,
        y: left.chat.y,
        height: left.chat.height,
        band: band.index,
        left: left.index,
        right: right.index,
      });
    }
  }
  for (let index = 0; index < bands.length - 1; index += 1) {
    const upper = bands[index];
    const lower = bands[index + 1];
    const yLine = upper.y + upper.height;
    const junctions = dividers.vertical
      .filter((rule) => rule.band === upper.index || rule.band === lower.index)
      .map((rule) => rule.x);
    dividers.horizontal.push({
      x: chatX,
      y: yLine,
      width: chatW,
      rows: [upper.index, lower.index],
      junctions: [...new Set(junctions)],
    });
  }

  const active = columns[clamp(Math.trunc(Number(focus) || 0), 0, count - 1)];
  return {
    cols,
    rows,
    topbar: { x: 0, y: 0, width: cols, height: 1 },
    rail: { x: 0, y: top, width: rail, height: bodyH },
    sidebar: { x: rail, y: top, width: sidebar, height: bodyH },
    panes: columns,
    bands,
    dividers,
    // Focused pane, kept for callers that predate split view.
    chat: active.chat,
    header: active.header,
    messages: active.messages,
    typing: active.typing,
    composer: active.composer,
    status: { x: 0, y: rows - statusH, width: cols, height: statusH },
  };
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
