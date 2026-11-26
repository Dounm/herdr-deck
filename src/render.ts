import {
  BOLD,
  DIM,
  fitAnsiColumns,
  GRUVBOX,
  RESET,
  sanitizePreviewAnsiLine,
  style,
  visibleWidth,
} from "./ansi.ts";
import { formatDurationCompact, formatRelativeAge } from "./state.ts";
import type { AttentionGroup, DeckAgentItem } from "./types.ts";

export type UiFocusMode = "list" | "interact" | "reply";
export type FilterTab = "all" | "attention" | "working";

export interface RenderState {
  cols: number;
  rows: number;
  items: DeckAgentItem[];
  selectedPaneId: string | null;
  focusMode: UiFocusMode;
  filterTab: FilterTab;
  showIdle: boolean;
  previewText: string;
  previewScrollOffset: number;
  replyDraft: string;
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
      // Still show idle items if there are no active items at all
      const hasNonIdle = state.items.some((x) => x.group !== "idle");
      return !hasNonIdle;
    }
    return true;
  });
}

export function renderScreen(state: RenderState): string {
  const cols = Math.max(40, state.cols);
  const rows = Math.max(12, state.rows);

  const visibleItems = getVisibleItems(state);
  const selectedItem =
    visibleItems.find((x) => x.paneId === state.selectedPaneId) ??
    visibleItems[0] ??
    null;

  const lines: string[] = [];

  // 1. Top Header Bar (1 row)
  lines.push(renderTopBar(state, cols));

  // 2. Main Split Body (rows - 3 rows: top bar, action/input bar, footer help bar)
  const bodyRows = Math.max(6, rows - 3);
  const stacked = cols < 78;

  if (stacked) {
    const topRows = Math.max(3, Math.floor(bodyRows * 0.42));
    const bottomRows = Math.max(3, bodyRows - topRows - 1);
    const leftLines = renderAgentListPane(state, visibleItems, selectedItem?.paneId ?? null, cols, topRows);
    const divider = style("─".repeat(cols), GRUVBOX.darkGray);
    const rightLines = renderPreviewPane(state, selectedItem, cols, bottomRows);
    lines.push(...leftLines, divider, ...rightLines);
  } else {
    const leftWidth = Math.min(48, Math.max(32, Math.floor(cols * 0.36)));
    const rightWidth = Math.max(20, cols - leftWidth - 1);
    const leftLines = renderAgentListPane(
      state,
      visibleItems,
      selectedItem?.paneId ?? null,
      leftWidth,
      bodyRows,
    );
    const rightLines = renderPreviewPane(state, selectedItem, rightWidth, bodyRows);
    const sepGlyph =
      state.focusMode === "interact"
        ? style("┃", GRUVBOX.orange, BOLD)
        : style("│", GRUVBOX.darkGray);

    for (let r = 0; r < bodyRows; r++) {
      const l = leftLines[r] ?? " ".repeat(leftWidth);
      const rt = rightLines[r] ?? " ".repeat(rightWidth);
      lines.push(`${l}${sepGlyph}${rt}`);
    }
  }

  // 3. Bottom Reply / Status Bar (1 row)
  lines.push(renderPromptOrToastBar(state, selectedItem, cols));

  // 4. Footer Keybinding Legend (1 row)
  lines.push(renderFooterBar(state, selectedItem, cols));

  // Paint frame cleanly from top-left without full clear flicker
  return (
    "\x1b[?25l\x1b[H" +
    lines.slice(0, rows).map((line) => `${line}\x1b[K`).join("\r\n")
  );
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
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.red}${BOLD} ! ${counts.needs_you} Needs You ${RESET}`);
  } else {
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.gray} · 0 Blocked ${RESET}`);
  }

  if (counts.review > 0) {
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.green}${BOLD} ✓ ${counts.review} Review ${RESET}`);
  }

  const spin = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length]!;
  if (counts.working > 0) {
    badges.push(`${GRUVBOX.bg1}${GRUVBOX.yellow} ${spin} ${counts.working} Working ${RESET}`);
  }

  badges.push(
    `${GRUVBOX.bg1}${GRUVBOX.gray} ○ ${counts.idle} Idle${state.showIdle ? "" : " (hidden)"} ${RESET}`,
  );

  const filterTag =
    state.filterTab === "all"
      ? "Filter: All"
      : state.filterTab === "attention"
        ? "Filter: Attention"
        : "Filter: Active";

  const leftPart = `${brandLabel} ${badges.join(" ")}`;
  const rightPart = `${GRUVBOX.bg1}${GRUVBOX.fg3} ${filterTag} [f] ${RESET}`;

  const leftW = visibleWidth(leftPart);
  const rightW = visibleWidth(rightPart);

  if (leftW + rightW + 1 <= cols) {
    const gap = `${GRUVBOX.bg0Hard}${" ".repeat(cols - leftW - rightW)}${RESET}`;
    return `${leftPart}${gap}${rightPart}`;
  }

  return fitAnsiColumns(leftPart, cols, { pad: true, padBg: GRUVBOX.bg0Hard });
}

function renderAgentListPane(
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
            style("  ✓ Inbox Zero — no matching agents", GRUVBOX.green, BOLD),
            width,
            { pad: true },
          ),
        );
      } else if (r === mid + 1) {
        const hint =
          state.items.length > 0
            ? "  Press [z] to show idle agents or [f] to reset filter"
            : "  Start Claude / Codex / Agy in any Herdr pane";
        emptyLines.push(fitAnsiColumns(style(hint, GRUVBOX.gray), width, { pad: true }));
      } else {
        emptyLines.push(" ".repeat(width));
      }
    }
    return emptyLines;
  }

  // Build logical rows with track of where selected item lands so we auto-scroll viewport
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
    const headerLabel = ` ▾ ${meta.title} (${groupItems.length}) `;
    rows.push({
      text: fitAnsiColumns(style(headerLabel, meta.color, BOLD), width, { pad: true }),
    });

    for (const item of groupItems) {
      const isSelected = item.paneId === selectedPaneId;
      const [line1, line2] = renderAgentCardRows(state, item, isSelected, width);
      rows.push({ text: line1, paneId: item.paneId });
      rows.push({ text: line2, paneId: item.paneId });
    }
  }

  // Viewport scrolling around selected item
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

  const cursorBar = isSelected
    ? `${rowBg}${GRUVBOX.orange}${BOLD}▌`
    : " ";

  const spin = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length]!;
  let icon = "○";
  let iconColor: string = GRUVBOX.gray;
  let timerStr = "";

  const elapsed = Math.max(0, state.nowMs - item.sinceMs);
  if (item.group === "needs_you") {
    icon = "!";
    iconColor = GRUVBOX.red;
    timerStr = `⚑ ${formatDurationCompact(elapsed)}`;
  } else if (item.group === "review") {
    icon = "✓";
    iconColor = GRUVBOX.green;
    timerStr = formatRelativeAge(elapsed);
  } else if (item.group === "working") {
    icon = spin;
    iconColor = GRUVBOX.yellow;
    timerStr = `↻ ${formatDurationCompact(elapsed)}`;
  } else {
    icon = "○";
    iconColor = GRUVBOX.gray;
    timerStr = item.paneId;
  }

  const titleColor = isSelected ? `${BOLD}${GRUVBOX.fg0}` : GRUVBOX.fg1;
  const agentTagColor = isSelected ? GRUVBOX.aqua : GRUVBOX.fg3;
  const timerColor =
    item.group === "needs_you"
      ? `${BOLD}${GRUVBOX.orange}`
      : item.group === "working"
        ? GRUVBOX.yellow
        : item.group === "review"
          ? GRUVBOX.green
          : GRUVBOX.gray;

  const timerRendered = `${rowBg}${timerColor}${timerStr} ${RESET}`;
  const timerCols = visibleWidth(timerStr) + 1;
  const leftBudget = Math.max(8, width - timerCols - 1);

  const leftHeadline =
    `${cursorBar}${rowBg}${iconColor}${BOLD}${icon}${RESET}` +
    `${rowBg} ${titleColor}${item.workspaceLabel}${RESET}` +
    `${rowBg}${GRUVBOX.gray} · ${agentTagColor}${item.agentDisplayName}${RESET}`;

  const fittedLeft = fitAnsiColumns(leftHeadline, leftBudget, {
    pad: true,
    padBg: rowBg || undefined,
  });

  const line1 = fitAnsiColumns(`${fittedLeft} ${timerRendered}`, width, {
    pad: true,
    padBg: rowBg || undefined,
  });

  const summaryColor = isSelected ? GRUVBOX.fg2 : GRUVBOX.gray;
  const subPrefix = isSelected ? `${rowBg}${GRUVBOX.orange}${BOLD}▌${RESET}${rowBg}   ` : "    ";
  const line2Raw = `${subPrefix}${summaryColor}${item.summary}${RESET}`;
  const line2 = fitAnsiColumns(line2Raw, width, {
    pad: true,
    padBg: rowBg || undefined,
  });

  return [line1, line2];
}

function renderPreviewPane(
  state: RenderState,
  selected: DeckAgentItem | null,
  width: number,
  height: number,
): string[] {
  if (!selected) {
    return Array.from({ length: height }, () => " ".repeat(width));
  }

  const lines: string[] = [];

  // Row 0: Detail header with workspace > tab > branch > pane_id + mode pill
  const modePill =
    state.focusMode === "interact"
      ? `${GRUVBOX.bgInteract}${GRUVBOX.green}${BOLD} » LIVE KEYS → AGENT (Esc to exit) ${RESET}`
      : selected.group === "needs_you"
        ? `${GRUVBOX.bgUrgent}${GRUVBOX.red}${BOLD} ! BLOCKED — [y/n/1-4] or [Tab] interact ${RESET}`
        : `${GRUVBOX.bg1}${GRUVBOX.fg3} ${selected.paneId} ${RESET}`;

  const branchChip = selected.branch
    ? `${GRUVBOX.gray} › ${GRUVBOX.aqua}⎇ ${selected.branch}${RESET}`
    : "";

  const headerLeft =
    ` ${GRUVBOX.blue}${BOLD}${selected.workspaceLabel}${RESET}` +
    `${GRUVBOX.gray} › ${GRUVBOX.fg2}${selected.tabLabel}${RESET}` +
    branchChip +
    `${GRUVBOX.gray} › ${GRUVBOX.yellow}${selected.agentDisplayName}${RESET}`;

  const leftW = visibleWidth(headerLeft);
  const pillW = visibleWidth(modePill);
  if (leftW + pillW + 2 <= width) {
    lines.push(
      `${headerLeft}${" ".repeat(width - leftW - pillW - 1)}${modePill} `,
    );
  } else {
    lines.push(fitAnsiColumns(headerLeft, width, { pad: true }));
  }

  // Row 1: Subtle divider with CWD if available
  const cwdLabel = selected.cwd ? shortenHome(selected.cwd) : "";
  const dividerRule = cwdLabel
    ? `─ ${cwdLabel} ${"─".repeat(Math.max(1, width - visibleWidth(cwdLabel) - 4))}`
    : "─".repeat(width);
  lines.push(
    fitAnsiColumns(
      style(dividerRule, state.focusMode === "interact" ? GRUVBOX.orange : GRUVBOX.darkGray),
      width,
      { pad: true },
    ),
  );

  // Remaining rows: terminal snapshot
  const snapHeight = Math.max(1, height - 2);
  const rawLines = state.previewText
    ? state.previewText.replace(/\r\n/g, "\n").split("\n")
    : [];

  // Trim trailing completely blank lines from bottom of terminal capture so actual prompt/blocker sits nicely visible
  while (rawLines.length > 0 && visibleWidth(rawLines[rawLines.length - 1]!.trim()) === 0) {
    rawLines.pop();
  }

  if (rawLines.length === 0) {
    for (let i = 0; i < snapHeight; i++) {
      if (i === Math.floor(snapHeight / 2)) {
        lines.push(
          fitAnsiColumns(style("  (Waiting for terminal output…)", GRUVBOX.gray, DIM), width, {
            pad: true,
          }),
        );
      } else {
        lines.push(" ".repeat(width));
      }
    }
    return lines;
  }

  const maxOffset = Math.max(0, rawLines.length - snapHeight);
  const clampedOffset = Math.min(maxOffset, Math.max(0, state.previewScrollOffset));
  const endIdx = rawLines.length - clampedOffset;
  const startIdx = Math.max(0, endIdx - snapHeight);
  const slice = rawLines.slice(startIdx, endIdx);

  const innerWidth = Math.max(4, width - 2);
  for (let i = 0; i < snapHeight; i++) {
    const raw = slice[i];
    if (raw === undefined) {
      lines.push(" ".repeat(width));
    } else {
      const safe = sanitizePreviewAnsiLine(raw);
      lines.push(" " + fitAnsiColumns(safe, innerWidth, { pad: true, ellipsis: "…" }) + " ");
    }
  }

  return lines;
}

function renderPromptOrToastBar(
  state: RenderState,
  selected: DeckAgentItem | null,
  cols: number,
): string {
  if (state.focusMode === "reply") {
    const targetName = selected
      ? `${selected.workspaceLabel}/${selected.agentDisplayName}`
      : "agent";
    const prefix = `${GRUVBOX.bg2}${GRUVBOX.yellow}${BOLD} Reply → ${targetName} ❯ ${RESET}${GRUVBOX.bg1}${GRUVBOX.fg0} `;
    const cursor = `${GRUVBOX.orange}█${RESET}`;
    const line = `${prefix}${state.replyDraft}${cursor}`;
    return fitAnsiColumns(line, cols, { pad: true, padBg: GRUVBOX.bg1 });
  }

  if (state.toastMessage) {
    const color =
      state.toastKind === "error"
        ? GRUVBOX.red
        : state.toastKind === "warn"
          ? GRUVBOX.orange
          : state.toastKind === "ok"
            ? GRUVBOX.green
            : GRUVBOX.aqua;
    return fitAnsiColumns(
      `${GRUVBOX.bg1}${color}${BOLD} ✦ ${state.toastMessage}${RESET}`,
      cols,
      { pad: true, padBg: GRUVBOX.bg1 },
    );
  }

  if (!selected) {
    return fitAnsiColumns(style("─".repeat(cols), GRUVBOX.darkGray), cols, { pad: true });
  }

  if (selected.group === "needs_you") {
    return fitAnsiColumns(
      `${GRUVBOX.bgUrgent}${GRUVBOX.orange}${BOLD} ! Quick Approve:${RESET}${GRUVBOX.bgUrgent}${GRUVBOX.fg1} press [y] Yes · [n] No · [1-4] Option · or [Tab] to drive dialog with ↑/↓/Enter${RESET}`,
      cols,
      { pad: true, padBg: GRUVBOX.bgUrgent },
    );
  }

  return fitAnsiColumns(
    `${GRUVBOX.bg1}${GRUVBOX.gray} Press [r] or [/] to send an inline prompt to ${GRUVBOX.fg2}${selected.workspaceLabel}/${selected.agentDisplayName}${GRUVBOX.gray}, or [Enter] to dive into terminal${RESET}`,
    cols,
    { pad: true, padBg: GRUVBOX.bg1 },
  );
}

function renderFooterBar(
  state: RenderState,
  selected: DeckAgentItem | null,
  cols: number,
): string {
  let hints: Array<[string, string]>;

  if (state.focusMode === "reply") {
    hints = [
      ["Enter", "Send Prompt"],
      ["Ctrl+U", "Clear"],
      ["Esc", "Cancel"],
    ];
  } else if (state.focusMode === "interact") {
    hints = [
      ["↑/↓/Enter/y/n/1-9", "Forward to Agent"],
      ["Ctrl+E", "Send Esc to Agent"],
      ["Esc / Tab", "Back to List"],
    ];
  } else {
    hints = [
      ["j/k", "Select"],
      ["Enter", "Dive In"],
      ["r /", "Inline Reply"],
      ["Tab", "Control Right Pane"],
      ["y/n/1-4", "Approve"],
      ["m", selected?.group === "review" ? "Mark Reviewed" : "Seen"],
      ["[/]", "Scroll Preview"],
      ["z", state.showIdle ? "Hide Idle" : "Show Idle"],
      ["q/Esc", "Close"],
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
