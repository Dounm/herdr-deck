import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fitAnsiColumns, sanitizePreviewAnsiLine, visibleWidth } from "../src/ansi.ts";
import { parseTerminalInput, toHerdrKeySpec } from "../src/keys.ts";
import { buildDeckAgentItems, stripAnsi, summarizeScreenLines } from "../src/model.ts";
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

test("attention model orders blocked -> review -> working -> idle and handles Mark Reviewed", () => {
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
        label: "dotfiles",
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
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, agent_status: "idle" },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 5, agent_status: "working" },
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
    ["w2:p1", "Updated 3 files and all unit tests passed.\n❯ "],
  ]);

  const items = buildDeckAgentItems(snapshot, state, snippets, null, now);
  assert.deepEqual(
    items.map((x) => [x.paneId, x.group]),
    [
      ["w2:p2", "needs_you"],
      ["w2:p1", "review"],
      ["w1:p2", "working"],
      ["w1:p1", "idle"],
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

test("timer persistence tracks working transitions and prunes closed panes", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-deck-test-"));
  const file = join(dir, "deck-state.json");
  try {
    const state = createEmptyState();
    recordAgentStatusTransition(state, "w1:p1", "working", 1000);
    // Repeated working event keeps original workingStartedMs
    recordAgentStatusTransition(state, "w1:p1", "working", 5000);
    assert.equal(state.timers["w1:p1"]!.sinceMs, 1000);
    assert.equal(state.timers["w1:p1"]!.workingStartedMs, 1000);

    // Transition to blocked resets sinceMs
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

test("CJK width, ANSI sanitization, truncation, and full TUI frame rendering stay exact", () => {
  assert.equal(visibleWidth("中文abc"), 7);
  const dirty = "\x1b[2J\x1b[31mError:\x1b[0m \x1b]0;title\x07卡点测试输出内容很长很长";
  const clean = sanitizePreviewAnsiLine(dirty);
  assert.ok(!clean.includes("\x1b[2J"));
  assert.ok(!clean.includes("title"));

  const fitted = fitAnsiColumns(clean, 14, { pad: true });
  assert.equal(visibleWidth(fitted), 14);

  const summary = summarizeScreenLines("───\n│ Do you want to run rm -rf dist? │\n❯ 1. Yes\n", "blocked");
  assert.equal(summary, "Do you want to run rm -rf dist?");

  const rendered = renderScreen({
    cols: 110,
    rows: 26,
    items: [
      {
        paneId: "w1:p1",
        workspaceId: "w1",
        tabId: "w1:t1",
        workspaceLabel: "herdr-deck",
        workspaceNumber: 1,
        tabLabel: "main",
        branch: "main",
        cwd: "/Users/karllooki/workspace/personal/herdr-plugin/herdr-deck",
        agentKind: "claude",
        agentDisplayName: "claude",
        rawStatus: "blocked",
        effectiveStatus: "blocked",
        group: "needs_you",
        sinceMs: 1_000,
        summary: "Allow Bash: pnpm test?",
        completionSeq: null,
        stateChangeSeq: 3,
        revision: 10,
        focusedInHerdr: false,
      },
    ],
    selectedPaneId: "w1:p1",
    focusMode: "list",
    filterTab: "all",
    showIdle: true,
    previewText: "\x1b[33m╭─ Permission ─╮\x1b[0m\n│ Allow Bash?  │\n╰──────────────╯",
    previewScrollOffset: 0,
    replyDraft: "",
    toastMessage: null,
    toastKind: "info",
    spinnerTick: 2,
    nowMs: 66_000,
  });

  const plainFrame = stripAnsi(rendered);
  assert.ok(plainFrame.includes("HERDR DECK"));
  assert.ok(plainFrame.includes("NEEDS YOU (1)"));
  assert.ok(plainFrame.includes("01:05"));
  assert.ok(plainFrame.includes("Allow Bash?"));
});

test("key parser handles arrows, CJK UTF-8 characters, and Herdr key specs", () => {
  const events = parseTerminalInput(Buffer.from("\x1b[A\x1b[B好\r\x1b", "utf8"));
  assert.deepEqual(events, [
    { kind: "special", name: "up" },
    { kind: "special", name: "down" },
    { kind: "char", value: "好" },
    { kind: "special", name: "enter" },
    { kind: "special", name: "esc" },
  ]);
  assert.equal(toHerdrKeySpec(events[0]!), "up");
  assert.equal(toHerdrKeySpec(events[3]!), "enter");
});
