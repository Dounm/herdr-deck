import {
  BOLD,
  DIM,
  fitAnsiColumns,
  GRUVBOX,
  layoutEditableInput,
  pickNameColor,
  renderBoxBottom,
  renderBoxRow,
  renderBoxTop,
  RESET,
  style,
  visibleWidth,
  wrapAnsiLine,
} from "./ansi.ts";
import { formatDurationCompact, formatRelativeAge } from "./state.ts";
import type { AttentionGroup, DeckAgentItem, GitRepoInfo } from "./types.ts";

export type UiFocusMode = "list" | "reply" | "rename";
export type FilterTab = "all" | "attention" | "working";

export interface RenderState {
  cols: number;
  rows: number;
  items: DeckAgentItem[];
  selectedPaneId: string | null;
  focusMode: UiFocusMode;
  filterTab: FilterTab;
  showIdle: boolean;
  showHelp: boolean;
  previewText: string;
  replyDraft: string;
  replyCursor: number;
  renameDraft: string;
  renameCursor: number;
  toastMessage: string | null;
  toastKind: "info" | "ok" | "warn" | "error";
  spinnerTick: number;
  nowMs: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GROUP_META: Record<
  AttentionGroup,
  { title: string; color: string; badge: string }
> = {
  needs_you: { title: "NEEDS YOU", color: GRUVBOX.red, badge: "!" },
  review: { title: "READY FOR REVIEW", color: GRUVBOX.green, badge: "✓" },
  working: { title: "WORKING", color: GRUVBOX.yellow, badge: "↻" },
  idle: { title: "IDLE", color: GRUVBOX.gray, badge: "○" },
};

export function getVisibleItems(state: RenderState): DeckAgentItem[] {
  return state.items.filter((item) => {
    if (state.filterTab === "attention") {
      return item.group === "needs_you" || item.group === "review";
    }
    if (state.filterTab === "working") {
      return item.group === "working" || item.group === "needs_you";
    }
    if (!state.showIdle && item.group === "idle") {
      const hasNonIdle = state.items.some((x) => x.group !== "idle");
      return !hasNonIdle;
    }
    return true;
  });
}

export function renderScreen(state: RenderState): string {
  const cols = Math.max(44, state.cols);
  const rows = Math.max(14, state.rows);

  const visibleItems = getVisibleItems(state);
  const selectedItem =
    visibleItems.find((x) => x.paneId === state.selectedPaneId) ??
    visibleItems[0] ??
    null;

  const lines: string[] = [];

  // 1. Top Header Bar (1 row)
  lines.push(renderTopBar(state, cols));

  // 2. Main Body (rows - 2 rows: top bar + footer bar)
  const bodyRows = Math.max(8, rows - 2);
  let hardwareCursor: { row: number; col: number } | null = null;

  if (state.showHelp) {
    lines.push(...renderCheatsheetBody(cols, bodyRows));
  } else {
    const stacked = cols < 82;
    if (stacked) {
      const topRows = Math.max(5, Math.floor(bodyRows * 0.42));
      const bottomRows = Math.max(5, bodyRows - topRows);
      const leftLines = renderAgentListCard(
        state,
        visibleItems,
        selectedItem?.paneId ?? null,
        cols,
        topRows,
      );
      const rightCol = renderRightColumn(state, selectedItem, cols, bottomRows, 1, 1 + topRows);
      hardwareCursor = rightCol.cursor;
      lines.push(...leftLines, ...rightCol.lines);
    } else {
      const leftWidth = Math.min(50, Math.max(34, Math.floor(cols * 0.36)));
      const rightWidth = Math.max(24, cols - leftWidth);
      const leftLines = renderAgentListCard(
        state,
        visibleItems,
        selectedItem?.paneId ?? null,
        leftWidth,
        bodyRows,
      );
      const rightCol = renderRightColumn(
        state,
        selectedItem,
        rightWidth,
        bodyRows,
        leftWidth + 1,
        2,
      );
      hardwareCursor = rightCol.cursor;
      for (let r = 0; r < bodyRows; r++) {
        const l = leftLines[r] ?? " ".repeat(leftWidth);
        const rt = rightCol.lines[r] ?? " ".repeat(rightWidth);
        lines.push(`${l}${rt}`);
      }
    }
  }

  // 3. Compact Footer Bar (1 row)
  lines.push(renderFooterBar(state, cols));

  // Wrap frame with DEC 2026 Synchronized Output (BSU/ESU) + disable line auto-wrap (DECAWM off)
  // + explicit 1-based row positioning (\x1b[r;1H) per line so an exotic wide glyph in the right
  // preview pane can NEVER wrap and scroll Row 1 (Top Bar) off the top of the viewport.
  const body = lines
    .slice(0, rows)
    .map((line, idx) => `\x1b[${idx + 1};1H${line}\x1b[K`)
    .join("");

  const cursorSuffix = hardwareCursor
    ? `\x1b[${hardwareCursor.row};${hardwareCursor.col}H\x1b[6 q\x1b[?25h`
    : "\x1b[?25l";

  return `\x1b[?2026h\x1b[?7l\x1b[?25l${body}${cursorSuffix}\x1b[?2026l`;
}

function renderTopBar(state: RenderState, cols: number): string {
  const counts = {
    needs_you: 0,
    review: 0,
    working: 0,
    idle: 0,
  };
  for (const item of state.items) {
    counts[item.group] += 1;
  }

  const brandLabel = `${GRUVBOX.bg2}${GRUVBOX.orange}${BOLD} ◈ HERDR DECK ${RESET}`;

  const badges: string[] = [];
  if (counts.needs_you > 0) {
    badges.push(`${GRUVBOX.bgUrgent}${GRUVBOX.red}${BOLD} ! ${counts.needs_you} 待审批 ${RESET}`);
  } else {
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.gray} · 0 阻塞 ${RESET}`);
  }

  if (counts.review > 0) {
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.green}${BOLD} ✓ ${counts.review} 待审阅 ${RESET}`);
  }

  const spin = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length]!;
  if (counts.working > 0) {
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.yellow} ${spin} ${counts.working} 运行中 ${RESET}`);
  }

  badges.push(
    `${GRUVBOX.bg1}${GRUVBOX.gray} ○ ${counts.idle} 空闲${state.showIdle ? "" : " (隐藏)"} ${RESET}`,
  );

  const filterTag =
    state.filterTab === "all"
      ? "全部"
      : state.filterTab === "attention"
        ? "仅待办"
        : "活跃";

  const leftPart = `${brandLabel} ${badges.join(" ")}`;
  const rightPart = `${GRUVBOX.bg1}${GRUVBOX.fg3} [f] ${filterTag} ${RESET}`;

  const leftW = visibleWidth(leftPart);
  const rightW = visibleWidth(rightPart);

  if (leftW + rightW + 1 <= cols) {
    const gap = `${GRUVBOX.bg0Hard}${" ".repeat(cols - leftW - rightW)}${RESET}`;
    return `${leftPart}${gap}${rightPart}`;
  }

  return fitAnsiColumns(leftPart, cols, { pad: true, padBg: GRUVBOX.bg0Hard });
}

function renderAgentListCard(
  state: RenderState,
  visibleItems: DeckAgentItem[],
  selectedPaneId: string | null,
  width: number,
  height: number,
): string[] {
  const isFocused = state.focusMode === "list";
  const borderColor = isFocused ? GRUVBOX.orange : GRUVBOX.darkGray;
  const titleColor = isFocused ? `${BOLD}${GRUVBOX.orange}` : GRUVBOX.fg3;
  const title = `${titleColor}Agent 队列${RESET}`;
  const countTag = `${GRUVBOX.gray}${visibleItems.length}/${state.items.length}${RESET}`;

  const innerWidth = Math.max(4, width - 2);
  const innerHeight = Math.max(1, height - 2);
  const innerLines = renderAgentListInner(
    state,
    visibleItems,
    selectedPaneId,
    innerWidth,
    innerHeight,
  );

  const out: string[] = [renderBoxTop(title, countTag, width, borderColor)];
  for (let i = 0; i < innerHeight; i++) {
    out.push(renderBoxRow(innerLines[i] ?? "", width, borderColor));
  }
  out.push(renderBoxBottom(width, borderColor));
  return out;
}

function renderAgentListInner(
  state: RenderState,
  visibleItems: DeckAgentItem[],
  selectedPaneId: string | null,
  width: number,
  height: number,
): string[] {
  if (visibleItems.length === 0) {
    const emptyLines: string[] = [];
    const mid = Math.floor(height / 2) - 1;
    for (let r = 0; r < height; r++) {
      if (r === mid) {
        emptyLines.push(
          fitAnsiColumns(
            style("  ✓ Inbox Zero — 暂无匹配 Agent", GRUVBOX.green, BOLD),
            width,
            { pad: true },
          ),
        );
      } else if (r === mid + 1) {
        const hint =
          state.items.length > 0
            ? "  按 [z] 显示空闲或 [f] 切换过滤"
            : "  在任意 Herdr Pane 启动 Claude / Codex / Agy";
        emptyLines.push(fitAnsiColumns(style(hint, GRUVBOX.gray), width, { pad: true }));
      } else {
        emptyLines.push(" ".repeat(width));
      }
    }
    return emptyLines;
  }

  interface LogicalRow {
    text: string;
    paneId?: string;
  }

  const rows: LogicalRow[] = [];
  const groupsOrder: AttentionGroup[] = ["needs_you", "review", "working", "idle"];

  for (const grp of groupsOrder) {
    const groupItems = visibleItems.filter((x) => x.group === grp);
    if (groupItems.length === 0) continue;

    const meta = GROUP_META[grp];
    if (rows.length > 0) {
      rows.push({ text: " ".repeat(width) });
    }

    // Group rule header: ` ─ ! NEEDS YOU (1) ─────────────`
    const headerCore = ` ─ ${meta.badge} ${meta.title} (${groupItems.length}) `;
    const fillLen = Math.max(0, width - visibleWidth(headerCore) - 1);
    const headerLine =
      `${meta.color}${BOLD}${headerCore}${RESET}` +
      `${GRUVBOX.darkGray}${"─".repeat(fillLen)}${RESET}`;
    rows.push({
      text: fitAnsiColumns(headerLine, width, { pad: true }),
    });

    for (const item of groupItems) {
      const isSelected = item.paneId === selectedPaneId;
      const [line1, line2] = renderAgentCardRows(state, item, isSelected, width);
      rows.push({ text: line1, paneId: item.paneId });
      rows.push({ text: line2, paneId: item.paneId });
    }
  }

  let selFirstRow = 0;
  let selLastRow = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.paneId === selectedPaneId) {
      selFirstRow = i;
      selLastRow = i + 1;
      break;
    }
  }

  let scrollTop = 0;
  if (selLastRow >= height) {
    scrollTop = Math.min(rows.length - height, selLastRow - height + 2);
  }
  if (selFirstRow < scrollTop) {
    scrollTop = Math.max(0, selFirstRow - 1);
  }

  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    const logical = rows[scrollTop + r];
    out.push(logical ? logical.text : " ".repeat(width));
  }
  return out;
}

function renderGitBadge(
  gitInfo: GitRepoInfo | null | undefined,
  fallbackBranch: string | null | undefined,
  options: { rowBg?: string; maxCols?: number; includeBranch?: boolean } = {},
): string {
  const bg = options.rowBg ?? "";
  const includeBranch = options.includeBranch ?? true;
  const info: GitRepoInfo | null =
    gitInfo ??
    (fallbackBranch ? { branch: fallbackBranch, dirtyFiles: 0, ahead: 0, behind: 0 } : null);
  if (!info) return "";

  const statusParts: string[] = [];
  if (info.dirtyFiles > 0) {
    statusParts.push(`${bg}${GRUVBOX.yellow}*${info.dirtyFiles}${RESET}`);
  }
  if (info.ahead > 0) {
    statusParts.push(`${bg}${GRUVBOX.green}↑${info.ahead}${RESET}`);
  }
  if (info.behind > 0) {
    statusParts.push(`${bg}${GRUVBOX.red}↓${info.behind}${RESET}`);
  }
  const statusStr = statusParts.join(`${bg} `);

  if (!includeBranch) {
    return statusStr;
  }

  const branchPrefix = `${bg}${GRUVBOX.aqua}⎇ `;
  const statusCols = statusStr ? visibleWidth(statusStr) + 1 : 0;
  let branchText = info.branch;

  if (options.maxCols !== undefined) {
    const branchBudget = options.maxCols - 2 - statusCols;
    if (branchBudget >= 4) {
      branchText = fitAnsiColumns(info.branch, branchBudget, { ellipsis: "…" });
    } else if (statusStr && visibleWidth(statusStr) <= options.maxCols) {
      return statusStr;
    } else {
      return fitAnsiColumns(`${branchPrefix}${info.branch}${RESET}`, options.maxCols, { ellipsis: "…" });
    }
  }

  const branchRendered = `${branchPrefix}${branchText}${RESET}`;
  return statusStr ? `${branchRendered}${bg} ${statusStr}` : branchRendered;
}

function renderAgentCardRows(
  state: RenderState,
  item: DeckAgentItem,
  isSelected: boolean,
  width: number,
): [string, string] {
  const rowBg = isSelected
    ? item.group === "needs_you"
      ? GRUVBOX.bgUrgent
      : GRUVBOX.bg1
    : "";

  const cursorBar = isSelected ? `${rowBg}${GRUVBOX.orange}${BOLD}▌` : " ";

  const spin = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length]!;
  let icon = "○";
  let iconColor: string = GRUVBOX.gray;
  let rightRendered = "";
  let rightCols = 0;

  const elapsed = Math.max(0, state.nowMs - item.sinceMs);
  if (item.group === "needs_you") {
    icon = "!";
    iconColor = GRUVBOX.red;
    const timerStr = `⚑ ${formatDurationCompact(elapsed)}`;
    rightRendered = `${rowBg}${BOLD}${GRUVBOX.orange}${timerStr} ${RESET}`;
    rightCols = visibleWidth(timerStr) + 1;
  } else if (item.group === "review") {
    icon = "✓";
    iconColor = GRUVBOX.green;
    const timerStr = formatRelativeAge(elapsed);
    rightRendered = `${rowBg}${GRUVBOX.green}${timerStr} ${RESET}`;
    rightCols = visibleWidth(timerStr) + 1;
  } else if (item.group === "working") {
    icon = spin;
    iconColor = GRUVBOX.yellow;
    const timerStr = `↻ ${formatDurationCompact(elapsed)}`;
    rightRendered = `${rowBg}${GRUVBOX.yellow}${timerStr} ${RESET}`;
    rightCols = visibleWidth(timerStr) + 1;
  } else {
    icon = "○";
    iconColor = GRUVBOX.gray;
    const maxGitCols = Math.max(8, Math.floor(width * 0.48));
    const gitBadge = renderGitBadge(item.gitInfo, item.branch, {
      rowBg,
      maxCols: maxGitCols,
      includeBranch: true,
    });
    if (gitBadge) {
      rightRendered = `${gitBadge}${rowBg} ${RESET}`;
      rightCols = visibleWidth(gitBadge) + 1;
    }
  }

  // Distinct deterministic color per primaryTitle so multiple agents in one workspace stand out immediately
  const nameColor = pickNameColor(item.primaryTitle);
  const titleStyle = isSelected ? `${BOLD}${nameColor}` : nameColor;
  const currentDot = item.focusedInHerdr ? `${rowBg}${GRUVBOX.fg3} •${RESET}` : "";

  const leftHeadline =
    `${cursorBar}${rowBg}${iconColor}${BOLD}${icon}${RESET}` +
    `${rowBg} ${titleStyle}${item.primaryTitle}${RESET}${currentDot}`;

  let line1: string;
  if (rightRendered) {
    const leftBudget = Math.max(8, width - rightCols - 1);
    const fittedLeft = fitAnsiColumns(leftHeadline, leftBudget, {
      pad: true,
      padBg: rowBg || undefined,
    });
    line1 = fitAnsiColumns(`${fittedLeft} ${rightRendered}`, width, {
      pad: true,
      padBg: rowBg || undefined,
    });
  } else {
    line1 = fitAnsiColumns(leftHeadline, width, {
      pad: true,
      padBg: rowBg || undefined,
    });
  }

  // Line 2: compact meta (`workspace · agent`) + cleaned summary
  const subPrefix = isSelected
    ? `${rowBg}${GRUVBOX.orange}${BOLD}▌${RESET}${rowBg}  `
    : "   ";
  const showWorkspaceInMeta =
    item.primaryTitle.toLowerCase() !== item.workspaceLabel.toLowerCase();
  const metaTag = showWorkspaceInMeta
    ? `${item.workspaceLabel}·${item.agentDisplayName}`
    : item.agentDisplayName;
  const metaColor = isSelected ? GRUVBOX.fg3 : GRUVBOX.darkGray;
  const summaryColor = isSelected ? GRUVBOX.fg2 : GRUVBOX.gray;

  const line2Raw =
    `${subPrefix}${metaColor}${metaTag}${RESET}` +
    `${rowBg}${GRUVBOX.darkGray} │ ${RESET}` +
    `${rowBg}${summaryColor}${item.summary}${RESET}`;

  const line2 = fitAnsiColumns(line2Raw, width, {
    pad: true,
    padBg: rowBg || undefined,
  });

  return [line1, line2];
}

function renderRightColumn(
  state: RenderState,
  selected: DeckAgentItem | null,
  width: number,
  height: number,
  startCol1Based: number,
  startRow1Based: number,
): { lines: string[]; cursor: { row: number; col: number } | null } {
  // Reserve fixed 3-row rounded reply/action box at the bottom of the right column
  const replyBoxHeight = 3;
  const previewBoxHeight = Math.max(4, height - replyBoxHeight);

  const previewLines = renderPreviewCard(state, selected, width, previewBoxHeight);
  const replyStartRow = startRow1Based + previewBoxHeight;
  const reply = renderInlineReplyCard(
    state,
    selected,
    width,
    replyBoxHeight,
    startCol1Based,
    replyStartRow,
  );

  return {
    lines: [...previewLines, ...reply.lines],
    cursor: reply.cursor,
  };
}

function renderPreviewCard(
  state: RenderState,
  selected: DeckAgentItem | null,
  width: number,
  height: number,
): string[] {
  const isBlocked = selected?.group === "needs_you";
  const borderColor =
    isBlocked && state.focusMode !== "reply" ? GRUVBOX.red : GRUVBOX.darkGray;

  let headerTitle = `${GRUVBOX.gray}终端快照${RESET}`;
  let rightTag = "";

  if (selected) {
    const titleColor = pickNameColor(selected.primaryTitle);
    const gitBadge = renderGitBadge(selected.gitInfo, selected.branch, { includeBranch: true });
    const cwdPart = selected.cwd ? ` ${GRUVBOX.gray}${shortenHome(selected.cwd)}${RESET}` : "";
    const baseTitle =
      `${titleColor}${BOLD}${selected.primaryTitle}${RESET}` +
      `${GRUVBOX.gray} · ${GRUVBOX.fg3}${selected.workspaceLabel} › ${selected.tabLabel} › ${GRUVBOX.yellow}${selected.agentDisplayName}${RESET}`;

    if (isBlocked) {
      const branchPart = gitBadge ? ` ${gitBadge}` : "";
      headerTitle = baseTitle + branchPart + (width >= 88 ? cwdPart : "");
      rightTag = `${GRUVBOX.bgUrgent}${GRUVBOX.red}${BOLD} ! 待审批 ${RESET}`;
    } else {
      const maxGitCols = Math.max(12, Math.floor(width * 0.42));
      const fittedGitBadge = renderGitBadge(selected.gitInfo, selected.branch, {
        maxCols: maxGitCols,
        includeBranch: true,
      });
      const canShowCwd =
        width >= 88 &&
        visibleWidth(baseTitle + cwdPart) + (fittedGitBadge ? visibleWidth(fittedGitBadge) + 6 : 0) <=
          width - 6;
      headerTitle = baseTitle + (canShowCwd ? cwdPart : "");
      rightTag = fittedGitBadge;
    }
  }

  const innerWidth = Math.max(4, width - 2);
  const innerHeight = Math.max(1, height - 2);

  const out: string[] = [renderBoxTop(headerTitle, rightTag, width, borderColor)];

  if (!selected) {
    for (let i = 0; i < innerHeight; i++) {
      out.push(renderBoxRow("", width, borderColor));
    }
    out.push(renderBoxBottom(width, borderColor));
    return out;
  }

  const rawLines = state.previewText
    ? state.previewText.replace(/\r\n/g, "\n").split("\n")
    : [];

  // Trim trailing empty lines so the live prompt / approval card stays pinned neatly at bottom
  while (rawLines.length > 0 && visibleWidth(rawLines[rawLines.length - 1]!.trim()) === 0) {
    rawLines.pop();
  }

  if (rawLines.length === 0) {
    const mid = Math.floor(innerHeight / 2);
    for (let i = 0; i < innerHeight; i++) {
      const content =
        i === mid ? style("  (正在加载终端画面…)", GRUVBOX.gray, DIM) : "";
      out.push(renderBoxRow(content, width, borderColor));
    }
    out.push(renderBoxBottom(width, borderColor));
    return out;
  }

  // Soft-wrap every logical line to fit the right preview card cleanly (preserving ANSI styles)
  const contentCols = Math.max(2, innerWidth - 2);
  const wrappedLines: string[] = [];
  for (const raw of rawLines) {
    const pieces = wrapAnsiLine(raw, contentCols);
    wrappedLines.push(...pieces);
  }

  // Always show the latest bottom visual lines (press Enter to scroll full history in real terminal)
  const startIdx = Math.max(0, wrappedLines.length - innerHeight);
  const slice = wrappedLines.slice(startIdx);

  for (let i = 0; i < innerHeight; i++) {
    const line = slice[i];
    if (line === undefined) {
      out.push(renderBoxRow("", width, borderColor));
    } else {
      const fitted = fitAnsiColumns(line, contentCols, { pad: true, ellipsis: "" });
      out.push(renderBoxRow(` ${fitted} `, width, borderColor));
    }
  }

  out.push(renderBoxBottom(width, borderColor));
  return out;
}

function renderInlineReplyCard(
  state: RenderState,
  selected: DeckAgentItem | null,
  width: number,
  height: number,
  startCol1Based: number,
  startRow1Based: number,
): { lines: string[]; cursor: { row: number; col: number } | null } {
  const isReply = state.focusMode === "reply";
  const isRename = state.focusMode === "rename";
  const isEditing = isReply || isRename;
  const isBlocked = selected?.group === "needs_you";

  const borderColor = isRename
    ? GRUVBOX.aqua
    : isReply
      ? GRUVBOX.yellow
      : isBlocked
        ? GRUVBOX.orange
        : GRUVBOX.darkGray;

  const targetName = selected ? selected.primaryTitle : "Agent";
  const title = isRename
    ? `${GRUVBOX.aqua}${BOLD}重命名 Pane → ${targetName}${RESET}`
    : isReply
      ? `${GRUVBOX.yellow}${BOLD}回复 → ${targetName}${RESET}`
      : isBlocked
        ? `${GRUVBOX.orange}${BOLD}快速审批 / 回复${RESET}`
        : `${GRUVBOX.fg3}快速回复${RESET}`;

  const rightTag = isRename
    ? `${GRUVBOX.gray}Enter 保存 · 留空清除 · Esc 取消${RESET}`
    : isReply
      ? `${GRUVBOX.gray}Enter 发送 · Esc 取消${RESET}`
      : isBlocked
        ? `${GRUVBOX.gray}[y/n/1-4] 审批 · [Enter] 进终端${RESET}`
        : `${GRUVBOX.gray}[r] 输入 · [R] 重命名 · [Enter] 进终端${RESET}`;

  let content = "";
  let rowBg: string | undefined;
  let cursor: { row: number; col: number } | null = null;

  if (isEditing) {
    rowBg = GRUVBOX.bg1;
    // Inner width excludes left/right │ borders (2 cols) and leading " ❯ " prompt (3 cols)
    const innerWidth = Math.max(4, width - 2);
    const promptPrefixWidth = 3;
    const inputCols = Math.max(2, innerWidth - promptPrefixWidth);
    const activeDraft = isRename ? state.renameDraft : state.replyDraft;
    const activeCursor = isRename ? state.renameCursor : state.replyCursor;
    const promptColor = isRename ? GRUVBOX.aqua : GRUVBOX.yellow;
    const { visibleText, cursorCellOffset } = layoutEditableInput(
      activeDraft,
      activeCursor,
      inputCols,
    );
    content = `${GRUVBOX.bg1}${promptColor}${BOLD} ❯ ${RESET}${GRUVBOX.bg1}${GRUVBOX.fg0}${visibleText}${RESET}`;
    // 1-based cursor coordinates inside the inline input row (enables macOS CJK IME preedit)
    cursor = {
      row: startRow1Based + 1,
      col: startCol1Based + 1 + promptPrefixWidth + cursorCellOffset,
    };
  } else if (state.toastMessage) {
    const color =
      state.toastKind === "error"
        ? GRUVBOX.red
        : state.toastKind === "warn"
          ? GRUVBOX.orange
          : state.toastKind === "ok"
            ? GRUVBOX.green
            : GRUVBOX.aqua;
    content = `${color}${BOLD} ✦ ${state.toastMessage}${RESET}`;
  } else if (!selected) {
    content = `${GRUVBOX.gray} 暂无可操作 Agent${RESET}`;
  } else if (isBlocked) {
    rowBg = GRUVBOX.bgUrgent;
    content = `${GRUVBOX.bgUrgent}${GRUVBOX.orange}${BOLD} ❯ ${RESET}${GRUVBOX.bgUrgent}${GRUVBOX.fg1}按 [y] 同意 · [n] 拒绝 · [1-4] 选第 N 项 · 或 [Enter] 进入终端处理${RESET}`;
  } else {
    content = `${GRUVBOX.gray} ❯ 按 ${GRUVBOX.fg2}[r]${GRUVBOX.gray} 一句话派活给 ${pickNameColor(targetName)}${targetName}${GRUVBOX.gray}，或 ${GRUVBOX.fg2}[Enter]${GRUVBOX.gray} 深入终端${RESET}`;
  }

  const out: string[] = [renderBoxTop(title, rightTag, width, borderColor)];
  if (height >= 3) {
    out.push(renderBoxRow(content, width, borderColor, rowBg));
  }
  out.push(renderBoxBottom(width, borderColor));
  return { lines: out, cursor };
}

function renderCheatsheetBody(cols: number, height: number): string[] {
  const modalWidth = Math.min(72, Math.max(44, cols - 6));
  const padLeft = Math.floor((cols - modalWidth) / 2);
  const padRight = Math.max(0, cols - padLeft - modalWidth);

  const sections: Array<{ heading: string; rows: Array<[string, string]> }> = [
    {
      heading: "导航与跳转",
      rows: [
        ["j / k / ↑ / ↓", "上下切换 Agent，右侧实时预览最新输出"],
        ["g / G", "跳到队列顶部 / 底部"],
        ["Enter", "深入进入选中 Agent 的真实终端并关闭面板"],
        ["q / Esc", "关闭 Herdr Deck 弹窗"],
      ],
    },
    {
      heading: "原地审批与内联回复",
      rows: [
        ["y / n / a / 1-4", "选中「待审批」项时直接发送审批按键"],
        ["r / /", "聚焦右下角输入框，一句话发送给选中 Agent"],
        ["← / → / Ctrl+A/E", "输入框内移动光标编辑（支持中文输入法）"],
        ["Ctrl+U / Ctrl+W", "清空光标前文本 / 删除前一个词"],
      ],
    },
    {
      heading: "队列管理",
      rows: [
        ["R (Shift+r)", "原地重命名选中 Pane（留空回车清除名称）"],
        ["m / Space", "将「待审阅」项标记为已阅并移向下一待办"],
        ["f", "循环切换过滤视图（全部 / 仅待办 / 活跃）"],
        ["z", "展开或隐藏 IDLE 空闲分组"],
        ["Ctrl+r", "立即手动刷新全量快照"],
        ["?", "打开 / 关闭本快捷键速查表"],
      ],
    },
  ];

  const modalRows: string[] = [];
  const innerWidth = modalWidth - 2;
  const bg = GRUVBOX.bgModal;

  modalRows.push(
    renderBoxTop(
      `${GRUVBOX.orange}${BOLD}Herdr Deck 快捷键速查${RESET}`,
      `${GRUVBOX.gray}? / Esc 关闭${RESET}`,
      modalWidth,
      GRUVBOX.orange,
      bg,
    ),
  );

  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s]!;
    if (s > 0) {
      modalRows.push(renderBoxRow("", modalWidth, GRUVBOX.orange, bg));
    }
    modalRows.push(
      renderBoxRow(
        `${bg} ${GRUVBOX.aqua}${BOLD}▸ ${sec.heading}${RESET}`,
        modalWidth,
        GRUVBOX.orange,
        bg,
      ),
    );
    for (const [k, desc] of sec.rows) {
      const keyCol = fitAnsiColumns(`${bg}   ${GRUVBOX.yellow}${BOLD}${k}${RESET}`, 20, {
        pad: true,
        padBg: bg,
      });
      const descCol = `${bg}${GRUVBOX.fg1}${desc}${RESET}`;
      modalRows.push(
        renderBoxRow(
          fitAnsiColumns(`${keyCol} ${descCol}`, innerWidth, { pad: true, padBg: bg }),
          modalWidth,
          GRUVBOX.orange,
          bg,
        ),
      );
    }
  }

  modalRows.push(renderBoxBottom(modalWidth, GRUVBOX.orange, bg));

  const trimmedModal = modalRows.slice(0, height);
  const topPad = Math.max(0, Math.floor((height - trimmedModal.length) / 2));

  const out: string[] = [];
  const blankFull = `${GRUVBOX.bg0Hard}${" ".repeat(cols)}${RESET}`;
  const leftMargin = `${GRUVBOX.bg0Hard}${" ".repeat(padLeft)}${RESET}`;
  const rightMargin = `${GRUVBOX.bg0Hard}${" ".repeat(padRight)}${RESET}`;

  for (let r = 0; r < height; r++) {
    const mIdx = r - topPad;
    if (mIdx >= 0 && mIdx < trimmedModal.length) {
      out.push(`${leftMargin}${trimmedModal[mIdx]!}${rightMargin}`);
    } else {
      out.push(blankFull);
    }
  }

  return out;
}

function renderFooterBar(state: RenderState, cols: number): string {
  let hints: Array<[string, string]>;

  if (state.showHelp) {
    hints = [
      ["? / Esc", "返回面板"],
    ];
  } else if (state.focusMode === "rename") {
    hints = [
      ["Enter", "保存名称"],
      ["Ctrl+U", "清空(清除名称)"],
      ["Esc", "取消"],
    ];
  } else if (state.focusMode === "reply") {
    hints = [
      ["Enter", "发送"],
      ["Ctrl+U", "清空"],
      ["Esc", "取消"],
    ];
  } else {
    hints = [
      ["j/k", "切换"],
      ["Enter", "进入终端"],
      ["r", "回复"],
      ["y/n", "审批"],
      ["m", "已阅"],
      ["?", "全部快捷键"],
    ];
  }

  const formatted = hints
    .map(
      ([k, desc]) =>
        `${GRUVBOX.bg0Hard}${GRUVBOX.yellow}${BOLD}[${k}]${RESET}${GRUVBOX.bg0Hard}${GRUVBOX.fg3} ${desc}${RESET}`,
    )
    .join(`${GRUVBOX.bg0Hard}  ${RESET}`);

  return fitAnsiColumns(` ${formatted}`, cols, { pad: true, padBg: GRUVBOX.bg0Hard });
}

function shortenHome(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
