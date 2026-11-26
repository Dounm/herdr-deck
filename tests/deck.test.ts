import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  fitAnsiColumns,
  pickNameColor,
  sanitizePreviewAnsiLine,
  visibleWidth,
  wrapAnsiLine,
} from "../src/ansi.ts";
import { parseTerminalInput, toHerdrKeySpec } from "../src/keys.ts";
import {
  buildDeckAgentItems,
  resolvePrimaryTitle,
  stripAnsi,
  summarizeScreenLines,
} from "../src/model.ts";
import { renderScreen } from "../src/render.ts";
import {
  createEmptyState,
  formatDurationCompact,
  loadDeckState,
  markAgentSeenInDeck,
  reconcileTimersWithSnapshot,
  recordAgentStatusTransition,
  saveDeckState,
} from "../src/state.ts";
import type { SessionSnapshot } from "../src/types.ts";

test("attention model orders blocked -> review -> working -> idle, resolves primary titles, and handles Mark Reviewed", () => {
  const now = 1_700_000_000_000;
  const state = createEmptyState();
  state.timers["w1:p1"] = { status: "idle", sinceMs: now - 300_000 };
  state.timers["w1:p2"] = { status: "working", sinceMs: now - 95_000, workingStartedMs: now - 95_000 };
  state.timers["w2:p1"] = { status: "done", sinceMs: now - 20_000 };
  state.timers["w2:p2"] = { status: "blocked", sinceMs: now - 180_000 };

  const snapshot: SessionSnapshot = {
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "misc",
        focused: true,
        pane_count: 2,
        tab_count: 1,
        active_tab_id: "w1:t1",
        agent_status: "working",
      },
      {
        workspace_id: "w2",
        number: 2,
        label: "dsh-launcher",
        focused: false,
        pane_count: 2,
        tab_count: 1,
        active_tab_id: "w2:t1",
        agent_status: "blocked",
        worktree: { branch: "feat/inbox" },
      },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, agent_status: "working" },
      { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "dev", focused: false, pane_count: 2, agent_status: "blocked" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, label: "ovis", agent_status: "idle" },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 5, label: "herdr plugin", agent_status: "working" },
      { pane_id: "w2:p1", terminal_id: "t3", workspace_id: "w2", tab_id: "w2:t1", focused: false, revision: 9, agent_status: "done" },
      { pane_id: "w2:p2", terminal_id: "t4", workspace_id: "w2", tab_id: "w2:t1", focused: false, revision: 12, agent_status: "blocked" },
    ],
    agents: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, agent: "agy", agent_status: "idle" },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 5, agent: "claude", agent_status: "working", tokens: { summary: "Running pnpm verify" } },
      { pane_id: "w2:p1", terminal_id: "t3", workspace_id: "w2", tab_id: "w2:t1", focused: false, revision: 9, agent: "codex", agent_status: "done", completion_seq: 4 },
      { pane_id: "w2:p2", terminal_id: "t4", workspace_id: "w2", tab_id: "w2:t1", focused: false, revision: 12, agent: "claude", agent_status: "blocked" },
    ],
  };

  const snippets = new Map<string, string>([
    ["w2:p2", "╭──────────────╮\n│ Allow Bash(pnpm db:migrate)? │\n│ ❯ 1. Yes │\n╰──────────────╯"],
    ["w2:p1", "Updated 3 files and all unit tests passed.\nTip: Press shift+tab to cycle modes\n❯ "],
  ]);

  const items = buildDeckAgentItems(snapshot, state, snippets, null, now);
  assert.deepEqual(
    items.map((x) => [x.paneId, x.group, x.primaryTitle]),
    [
      ["w2:p2", "needs_you", "dsh-launcher"],
      ["w2:p1", "review", "dsh-launcher"],
      ["w1:p2", "working", "herdr plugin"],
      ["w1:p1", "idle", "ovis"],
    ],
  );
  assert.equal(items[0]!.summary, "Allow Bash(pnpm db:migrate)?");
  assert.equal(items[1]!.summary, "Updated 3 files and all unit tests passed.");
  assert.equal(items[2]!.summary, "Running pnpm verify");

  // Mark w2:p1 reviewed -> demotes from review to idle until next completion_seq
  markAgentSeenInDeck(state, snapshot.agents[2]!, now);
  const afterSeen = buildDeckAgentItems(snapshot, state, snippets, null, now);
  const demoted = afterSeen.find((x) => x.paneId === "w2:p1")!;
  assert.equal(demoted.group, "idle");
});

test("resolvePrimaryTitle priority and deterministic pickNameColor", () => {
  assert.equal(
    resolvePrimaryTitle({ name: "reviewer" }, { label: "herdr plugin" }, "misc", "/a/b/herdr-plugin"),
    "herdr plugin",
  );
  assert.equal(
    resolvePrimaryTitle({ name: "reviewer" }, { label: "1" }, "misc", "/a/b/herdr-plugin"),
    "reviewer",
  );
  assert.equal(
    resolvePrimaryTitle({ name: null }, undefined, "work", "/Users/me/workspace/work/lifelogging-server"),
    "lifelogging-server",
  );
  assert.equal(
    resolvePrimaryTitle({ name: null }, undefined, "work", "/Users/me/workspace/work"),
    "work",
  );

  // Color hashing is deterministic and differentiates distinct names
  assert.equal(pickNameColor("herdr plugin"), pickNameColor("herdr plugin"));
  const distinctColors = new Set([
    pickNameColor("herdr plugin"),
    pickNameColor("ovis"),
    pickNameColor("lifelogging-server"),
    pickNameColor("dsh-launcher"),
    pickNameColor("local-server"),
    pickNameColor("dotfiles"),
  ]);
  assert.ok(distinctColors.size >= 3, "expected multiple distinct colors across agent names");
});

test("timer persistence tracks working transitions and prunes closed panes", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-deck-test-"));
  const file = join(dir, "deck-state.json");
  try {
    const state = createEmptyState();
    recordAgentStatusTransition(state, "w1:p1", "working", 1000);
    recordAgentStatusTransition(state, "w1:p1", "working", 5000);
    assert.equal(state.timers["w1:p1"]!.sinceMs, 1000);
    assert.equal(state.timers["w1:p1"]!.workingStartedMs, 1000);

    recordAgentStatusTransition(state, "w1:p1", "blocked", 9000);
    assert.equal(state.timers["w1:p1"]!.sinceMs, 9000);
    assert.equal(formatDurationCompact(125_000), "02:05");

    saveDeckState(state, file);
    const loaded = loadDeckState(file);
    assert.equal(loaded.timers["w1:p1"]!.status, "blocked");

    const emptySnap: SessionSnapshot = {
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      panes: [],
      agents: [],
    };
    reconcileTimersWithSnapshot(loaded, emptySnap, 12000);
    assert.equal(Object.keys(loaded.timers).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3-card layout & cheatsheet overlay render with exact column width and DEC 2026 sync markers", () => {
  assert.equal(visibleWidth("中文abc"), 7);
  const dirty = "\x1b[2J\x1b[31mError:\x1b[0m \x1b]0;title\x07卡点测试输出内容很长很长";
  const clean = sanitizePreviewAnsiLine(dirty);
  assert.ok(!clean.includes("\x1b[2J"));
  assert.ok(!clean.includes("title"));

  const fitted = fitAnsiColumns(clean, 14, { pad: true });
  assert.equal(visibleWidth(fitted), 14);

  const summary = summarizeScreenLines("───\n│ Do you want to run rm -rf dist? │\n❯ 1. Yes\n", "blocked");
  assert.equal(summary, "Do you want to run rm -rf dist?");

  const cols = 112;
  const rows = 26;
  const baseState = {
    cols,
    rows,
    items: [
      {
        paneId: "w1:p1",
        workspaceId: "w1",
        tabId: "w1:t1",
        workspaceLabel: "misc",
        workspaceNumber: 1,
        tabLabel: "main",
        paneLabel: "herdr plugin",
        primaryTitle: "herdr plugin",
        branch: "main",
        cwd: "/Users/karllooki/workspace/personal/herdr-plugin/herdr-deck",
        agentKind: "claude",
        agentDisplayName: "claude",
        rawStatus: "blocked" as const,
        effectiveStatus: "blocked" as const,
        group: "needs_you" as const,
        sinceMs: 1_000,
        summary: "Allow Bash: pnpm test?",
        completionSeq: null,
        stateChangeSeq: 3,
        revision: 10,
        focusedInHerdr: true,
      },
    ],
    selectedPaneId: "w1:p1",
    focusMode: "list" as const,
    filterTab: "all" as const,
    showIdle: true,
    showHelp: false,
    previewText: "\x1b[33m╭─ Permission ─╮\x1b[0m\n│ Allow Bash?  │\n╰──────────────╯",
    replyDraft: "",
    replyCursor: 0,
    toastMessage: null,
    toastKind: "info" as const,
    spinnerTick: 2,
    nowMs: 66_000,
  };

  const rendered = renderScreen(baseState);
  assert.ok(rendered.startsWith("\x1b[?2026h\x1b[?7l"));
  assert.ok(rendered.endsWith("\x1b[?2026l"));

  // Split by explicit 1-based row positioning (\x1b[r;1H)
  const extractRows = (frame: string): string[] => {
    const matches = [...frame.matchAll(/\x1b\[(\d+);1H([\s\S]*?)\x1b\[K/g)];
    return matches.map((m) => stripAnsi(m[2]!));
  };

  const plainLines = extractRows(rendered);
  assert.equal(plainLines.length, rows);
  for (const [idx, line] of plainLines.entries()) {
    assert.equal(visibleWidth(line), cols, `row ${idx} width mismatch: "${line}"`);
  }
  const plainAll = plainLines.join("\n");
  assert.ok(plainAll.includes("HERDR DECK"));
  assert.ok(plainAll.includes("herdr plugin"));
  assert.ok(plainAll.includes("01:05"));
  assert.ok(plainAll.includes("Allow Bash?"));
  assert.ok(plainAll.includes("快速审批"));
  assert.ok(plainAll.includes("[?]"));

  // Cheatsheet overlay
  const helpFrame = renderScreen({ ...baseState, showHelp: true });
  const helpLines = extractRows(helpFrame);
  assert.equal(helpLines.length, rows);
  for (const [idx, line] of helpLines.entries()) {
    assert.equal(visibleWidth(line), cols, `help row ${idx} width mismatch: "${line}"`);
  }
  assert.ok(helpLines.join("\n").includes("Herdr Deck 快捷键速查"));

  // Reply mode exposes real hardware terminal cursor at exact input cell for macOS CJK IME preedit
  const replyFrame = renderScreen({
    ...baseState,
    focusMode: "reply",
    replyDraft: "你好a",
    replyCursor: 3,
  });
  // Row 24 (1-based: top bar 1 + bodyRows 24 -> reply middle row is 1 + 24 - 1 = 24)
  // Left width = floor(112 * 0.36) = 40; right starts at col 41; border + " ❯ " = +4 -> col 45; "你好a" = 5 cells -> col 50
  assert.ok(replyFrame.includes("\x1b[24;50H\x1b[6 q\x1b[?25h"), "expected hardware cursor positioned inside reply box");
});

test("key parser handles arrows, CJK UTF-8 characters, and Herdr key specs", () => {
  const events = parseTerminalInput(Buffer.from("\x1b[A\x1b[B好\r\x1b?", "utf8"));
  assert.deepEqual(events, [
    { kind: "special", name: "up" },
    { kind: "special", name: "down" },
    { kind: "char", value: "好" },
    { kind: "special", name: "enter" },
    { kind: "special", name: "esc" },
    { kind: "char", value: "?" },
  ]);
  assert.equal(toHerdrKeySpec(events[0]!), "up");
  assert.equal(toHerdrKeySpec(events[3]!), "enter");
});

test("wrapAnsiLine soft-wraps long CJK/ANSI lines while keeping horizontal dividers on one line", () => {
  // Colored long CJK + ASCII line wraps across multiple visual rows and carries SGR color forward
  const colored = "\x1b[38;5;12m你好世界HelloWorld测试换行效果\x1b[0m";
  const wrapped = wrapAnsiLine(colored, 12);
  assert.ok(wrapped.length >= 3, `expected >= 3 wrapped lines, got ${wrapped.length}`);
  for (const row of wrapped) {
    assert.ok(visibleWidth(row) <= 12, `wrapped row exceeded 12 cols: "${stripAnsi(row)}"`);
  }
  assert.equal(wrapped.map((r) => stripAnsi(r)).join(""), "你好世界HelloWorld测试换行效果");
  // Continuation line preserves ANSI color escape
  assert.ok(wrapped[1]!.startsWith("\x1b[38;5;12m"));

  // Horizontal rule stays clipped to a single neat line instead of wrapping into multiple rows
  const divider = "\x1b[38;5;8m" + "─".repeat(160) + "\x1b[0m";
  const wrappedDivider = wrapAnsiLine(divider, 40);
  assert.equal(wrappedDivider.length, 1);
  assert.equal(visibleWidth(wrappedDivider[0]!), 40);
});
