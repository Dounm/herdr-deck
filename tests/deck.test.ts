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
import { parseGitPorcelainV2, refreshGitInfoForCwds, type GitCacheEntry } from "../src/git.ts";
import { parseTerminalInput, toHerdrKeySpec } from "../src/keys.ts";
import {
  buildDeckAgentItems,
  buildMultiMachineDeckItems,
  collectSnapshotGitCwds,
  DEFAULT_SLEEP_AFTER_HOURS,
  resolvePrimaryTitle,
  resolveSleepAfterMs,
  stripAnsi,
  summarizeScreenLines,
} from "../src/model.ts";
import { parseMachineListJson, parseSnapshotCliJson } from "../src/remote-client.ts";
import { getVisibleItems, renderScreen } from "../src/render.ts";
import {
  createEmptyState,
  formatDurationCompact,
  loadDeckState,
  makeAgentTimerKey,
  markAgentSeenInDeck,
  reconcileTimersWithSnapshot,
  recordAgentStatusTransition,
  saveDeckState,
  setAgentSleepingInDeck,
  wakeAgentInDeck,
} from "../src/state.ts";
import type { AgentInfo, DeckAgentItem, SessionSnapshot } from "../src/types.ts";

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
        itemKey: "w1:p1",
        machineId: null,
        machineLabel: null,
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
    selectedItemKey: "w1:p1",
    focusMode: "list" as const,
    filterTab: "all" as const,
    showIdle: true,
    showHelp: false,
    previewText: "\x1b[33m╭─ Permission ─╮\x1b[0m\n│ Allow Bash?  │\n╰──────────────╯",
    replyDraft: "",
    replyCursor: 0,
    renameDraft: "",
    renameCursor: 0,
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

  // Rename mode reuses inline input box with aqua theme & real hardware cursor
  const renameFrame = renderScreen({
    ...baseState,
    focusMode: "rename",
    renameDraft: "auth",
    renameCursor: 4,
  });
  const renameLines = extractRows(renameFrame);
  assert.equal(renameLines.length, rows);
  for (const [idx, line] of renameLines.entries()) {
    assert.equal(visibleWidth(line), cols, `rename row ${idx} width mismatch: "${line}"`);
  }
  assert.ok(renameLines.join("\n").includes("重命名 Pane → herdr plugin"));
  assert.ok(renameFrame.includes("\x1b[24;49H\x1b[6 q\x1b[?25h"), "expected hardware cursor positioned inside rename box");
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

test("git porcelain v2 parser, TTL cache, and UI rendering replace paneId with git status", async () => {
  const parsed = parseGitPorcelainV2(
    [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head feat/git-status",
      "# branch.upstream origin/feat/git-status",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaaa bbbb src/render.ts",
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new.ts\tsrc/old.ts",
      "? src/untracked.ts",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    branch: "feat/git-status",
    dirtyFiles: 3,
    ahead: 2,
    behind: 1,
    detached: false,
  });

  const detached = parseGitPorcelainV2(
    "# branch.oid abcdef1234567890\n# branch.head (detached)\n",
  );
  assert.deepEqual(detached, {
    branch: "abcdef1",
    dirtyFiles: 0,
    ahead: 0,
    behind: 0,
    detached: true,
  });
  assert.equal(parseGitPorcelainV2("fatal: not a git repository"), null);

  // Deduplication + TTL cache check
  const cache = new Map<string, GitCacheEntry>();
  let probeCount = 0;
  const fakeProbe = async (cwd: string) => {
    probeCount += 1;
    return cwd === "/repo/a" ? parsed : null;
  };
  const first = await refreshGitInfoForCwds(["/repo/a", "/repo/a", "/non-git"], cache, {
    nowMs: 1000,
    ttlMs: 5000,
    probe: fakeProbe,
  });
  assert.equal(first.changed, true);
  assert.equal(probeCount, 2);

  // Within TTL: no extra probes
  const second = await refreshGitInfoForCwds(["/repo/a", "/non-git"], cache, {
    nowMs: 3000,
    ttlMs: 5000,
    probe: fakeProbe,
  });
  assert.equal(second.changed, false);
  assert.equal(probeCount, 2);

  // Build snapshot with git repo and non-git workspace cwds
  const snap: SessionSnapshot = {
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "repo-ws",
        focused: true,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: "w1:t1",
        agent_status: "idle",
      },
      {
        workspace_id: "w2",
        number: 2,
        label: "plain-ws",
        focused: false,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: "w2:t1",
        agent_status: "idle",
      },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" },
      { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "main", focused: false, pane_count: 1, agent_status: "idle" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, cwd: "/repo/a", agent_status: "idle" },
      { pane_id: "w2:p1", terminal_id: "t2", workspace_id: "w2", tab_id: "w2:t1", focused: false, revision: 1, cwd: "/non-git", agent_status: "idle" },
    ],
    agents: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, cwd: "/repo/a", agent: "claude", agent_status: "idle" },
      { pane_id: "w2:p1", terminal_id: "t2", workspace_id: "w2", tab_id: "w2:t1", focused: false, revision: 1, cwd: "/non-git", agent: "agy", agent_status: "idle" },
    ],
  };

  assert.deepEqual(collectSnapshotGitCwds(snap).sort(), ["/non-git", "/repo/a"]);

  const gitMap = new Map(
    [...cache.entries()].map(([k, v]) => [k, v.info]),
  );
  const items = buildDeckAgentItems(snap, createEmptyState(), new Map(), null, 5000, gitMap);
  assert.equal(items[0]!.gitInfo?.branch, "feat/git-status");
  assert.equal(items[1]!.gitInfo, null);

  // Render IDLE items: git repo shows branch + dirty + ahead/behind, paneId (w1:p1 / w2:p1) is never shown
  const cols = 112;
  const rows = 20;
  const frame = renderScreen({
    cols,
    rows,
    items,
    selectedItemKey: "w1:p1",
    focusMode: "list",
    filterTab: "all",
    showIdle: true,
    showHelp: false,
    previewText: "Ready.",
    replyDraft: "",
    replyCursor: 0,
    renameDraft: "",
    renameCursor: 0,
    toastMessage: null,
    toastKind: "info",
    spinnerTick: 0,
    nowMs: 5000,
  });

  const plainLines = [...frame.matchAll(/\x1b\[(\d+);1H([\s\S]*?)\x1b\[K/g)].map((m) =>
    stripAnsi(m[2]!),
  );
  assert.equal(plainLines.length, rows);
  for (const [idx, line] of plainLines.entries()) {
    assert.equal(visibleWidth(line), cols, `row ${idx} width mismatch: "${line}"`);
  }
  const plainAll = plainLines.join("\n");
  assert.ok(!plainAll.includes("w1:p1"), "expected w1:p1 to be removed from UI");
  assert.ok(!plainAll.includes("w2:p1"), "expected w2:p1 to be removed from UI");
  assert.ok(plainAll.includes("⎇ feat/git-status *3 ↑2 ↓1"), "expected full git status in preview header");
  assert.ok(plainAll.includes("*3 ↑2 ↓1"), "expected git dirty/ahead/behind counters in IDLE row");
});

test("multi-machine aggregation isolates colliding paneIds, timers, and renders @machine badges", () => {
  const machines = parseMachineListJson(
    JSON.stringify([
      { id: "m-tokyo", label: "soltokyo", target: "soltokyo-box", session: "default", enabled: true, selected: false },
      { id: "m-disabled", label: "old-box", target: "old", session: "default", enabled: false, selected: false },
    ]),
  );
  assert.equal(machines.length, 2);
  assert.equal(machines[0]!.label, "soltokyo");
  assert.equal(machines[1]!.enabled, false);

  const remoteSnap = parseSnapshotCliJson(
    JSON.stringify({
      id: "req_1",
      result: {
        snapshot: {
          version: "0.9.5",
          protocol: 22,
          workspaces: [
            {
              workspace_id: "w1",
              number: 1,
              label: "repo",
              focused: true,
              pane_count: 1,
              tab_count: 1,
              active_tab_id: "w1:t1",
              agent_status: "working",
            },
          ],
          tabs: [
            { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "1", focused: true, pane_count: 1, agent_status: "working" },
          ],
          panes: [
            { pane_id: "w1:p1", terminal_id: "rt1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 3, cwd: "/home/dev/sol-execbench", agent_status: "working" },
          ],
          agents: [
            { pane_id: "w1:p1", terminal_id: "rt1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 3, cwd: "/home/dev/sol-execbench", agent: "agy", agent_status: "working" },
          ],
        },
      },
    }),
  );

  const localSnap: SessionSnapshot = {
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "local-ws",
        focused: true,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: "w1:t1",
        agent_status: "idle",
      },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "lt1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, cwd: "/Users/me/local-ws", agent_status: "idle" },
    ],
    agents: [
      { pane_id: "w1:p1", terminal_id: "lt1", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, cwd: "/Users/me/local-ws", agent: "claude", agent_status: "idle" },
    ],
  };

  const state = createEmptyState();
  const now = 100_000;
  reconcileTimersWithSnapshot(state, localSnap, now - 60_000, null);
  reconcileTimersWithSnapshot(state, remoteSnap, now - 15_000, "m-tokyo");
  // Reconciling local again must NOT prune remote machine timers
  reconcileTimersWithSnapshot(state, localSnap, now, null);
  assert.ok(state.timers["w1:p1"]);
  assert.ok(state.timers[makeAgentTimerKey("w1:p1", "m-tokyo")]);

  const snippets = new Map<string, string>([
    [makeAgentTimerKey("w1:p1", "m-tokyo"), "Running remote benchmark suite..."],
  ]);
  const items = buildMultiMachineDeckItems(
    [
      { snapshot: localSnap },
      { machineId: "m-tokyo", machineLabel: "soltokyo", snapshot: remoteSnap },
    ],
    state,
    snippets,
    now,
  );

  assert.equal(items.length, 2);
  // Remote working agent sorts ahead of local idle agent, and itemKeys do not collide even though both paneIds are w1:p1
  assert.equal(items[0]!.itemKey, "m-tokyo::w1:p1");
  assert.equal(items[0]!.machineLabel, "soltokyo");
  assert.equal(items[0]!.focusedInHerdr, false);
  assert.equal(items[0]!.summary, "Running remote benchmark suite...");
  assert.equal(items[1]!.itemKey, "w1:p1");
  assert.equal(items[1]!.machineId, null);

  const cols = 112;
  const rows = 20;
  const frame = renderScreen({
    cols,
    rows,
    items,
    selectedItemKey: "m-tokyo::w1:p1",
    focusMode: "list",
    filterTab: "all",
    showIdle: true,
    showHelp: false,
    previewText: "Benchmark step 3/10",
    replyDraft: "",
    replyCursor: 0,
    renameDraft: "",
    renameCursor: 0,
    toastMessage: null,
    toastKind: "info",
    spinnerTick: 1,
    nowMs: now,
  });

  const plainLines = [...frame.matchAll(/\x1b\[(\d+);1H([\s\S]*?)\x1b\[K/g)].map((m) =>
    stripAnsi(m[2]!),
  );
  assert.equal(plainLines.length, rows);
  for (const [idx, line] of plainLines.entries()) {
    assert.equal(visibleWidth(line), cols, `remote row ${idx} width mismatch: "${line}"`);
  }
  const plainAll = plainLines.join("\n");
  assert.ok(plainAll.includes("@soltokyo"), "expected @soltokyo badge in list and preview header");
  assert.ok(plainAll.includes("远端仅原地操作"), "expected remote-only hint in reply box");
  assert.ok(!plainAll.includes("[Enter] 进终端"), "expected Enter jump hint to be hidden for remote items");
});

function makeSleepTestSnapshot(agents: Array<{
  paneId: string;
  label: string;
  status: AgentInfo["agent_status"];
  completionSeq?: number | null;
  stateChangeSeq?: number;
  revision?: number;
}>): SessionSnapshot {
  return {
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "work",
        focused: true,
        pane_count: agents.length,
        tab_count: 1,
        active_tab_id: "w1:t1",
        agent_status: "idle",
      },
    ],
    tabs: [
      {
        tab_id: "w1:t1",
        workspace_id: "w1",
        number: 1,
        label: "main",
        focused: true,
        pane_count: agents.length,
        agent_status: "idle",
      },
    ],
    panes: agents.map((a, idx) => ({
      pane_id: a.paneId,
      terminal_id: `t${idx + 1}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: idx === 0,
      revision: a.revision ?? 1,
      label: a.label,
      agent_status: a.status,
    })),
    agents: agents.map((a, idx) => ({
      pane_id: a.paneId,
      terminal_id: `t${idx + 1}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: idx === 0,
      revision: a.revision ?? 1,
      agent: "claude",
      agent_status: a.status,
      completion_seq: a.completionSeq ?? null,
      state_change_seq: a.stateChangeSeq ?? 1,
    })),
  };
}

test("manual sleep/wake handles idle, review (marks seen), wokeAtMs countdown reset, and never swallows active groups", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_100_000_000;
  const state = createEmptyState();

  const snapshot = makeSleepTestSnapshot([
    { paneId: "w1:p_idle", label: "idle-app", status: "idle", stateChangeSeq: 2, revision: 2 },
    { paneId: "w1:p_review", label: "review-app", status: "done", completionSeq: 7, stateChangeSeq: 5, revision: 11 },
    { paneId: "w1:p_blocked", label: "blocked-app", status: "blocked", stateChangeSeq: 3, revision: 4 },
    { paneId: "w1:p_unread", label: "unread-done", status: "done", completionSeq: 9, stateChangeSeq: 6, revision: 14 },
    { paneId: "w1:p_working", label: "working-app", status: "working", stateChangeSeq: 4, revision: 8 },
  ]);

  // Seed timers: active/blocked/unread even with >48h age and sleeping: true must never be swallowed
  state.timers["w1:p_idle"] = { status: "idle", sinceMs: now - 30 * 60 * 1000 };
  state.timers["w1:p_review"] = { status: "done", sinceMs: now - 5 * 60 * 1000 };
  state.timers["w1:p_blocked"] = { status: "blocked", sinceMs: now - 48 * HOUR, sleeping: true, sleepingSinceMs: now - 10 * HOUR };
  state.timers["w1:p_unread"] = { status: "done", sinceMs: now - 48 * HOUR, sleeping: true, sleepingSinceMs: now - 10 * HOUR };
  state.timers["w1:p_working"] = { status: "working", sinceMs: now - 48 * HOUR, workingStartedMs: now - 48 * HOUR, sleeping: true };

  // 1) Manual sleep on idle -> sleeping with sleepReason === "manual"
  setAgentSleepingInDeck(state, snapshot.agents[0]!, now);
  assert.equal(state.timers["w1:p_idle"]!.sleeping, true);
  assert.equal(state.timers["w1:p_idle"]!.sleepingSinceMs, now);

  // 2) Manual sleep on review (unread done) -> marks seen (seenCompletionSeq & seenRevision) and sleeps
  setAgentSleepingInDeck(state, snapshot.agents[1]!, now);
  assert.equal(state.timers["w1:p_review"]!.sleeping, true);
  assert.equal(state.timers["w1:p_review"]!.seenCompletionSeq, 7);
  assert.equal(state.timers["w1:p_review"]!.seenRevision, 11);

  const items = buildDeckAgentItems(snapshot, state, new Map(), null, now);
  const byPane = new Map(items.map((x) => [x.paneId, x]));

  assert.equal(byPane.get("w1:p_idle")!.group, "sleeping");
  assert.equal(byPane.get("w1:p_idle")!.sleepReason, "manual");
  assert.equal(byPane.get("w1:p_review")!.group, "sleeping");
  assert.equal(byPane.get("w1:p_review")!.sleepReason, "manual");

  // 3) blocked / unread done / working are never swallowed by sleeping
  assert.equal(byPane.get("w1:p_blocked")!.group, "needs_you");
  assert.equal(byPane.get("w1:p_blocked")!.sleepReason, null);
  assert.equal(byPane.get("w1:p_unread")!.group, "review");
  assert.equal(byPane.get("w1:p_unread")!.sleepReason, null);
  assert.equal(byPane.get("w1:p_working")!.group, "working");
  assert.equal(byPane.get("w1:p_working")!.sleepReason, null);

  // 4) Wake a sleeping item whose original sinceMs is > 48h ago -> returns to idle, wokeAtMs resets 24h countdown
  state.timers["w1:p_idle"]!.sinceMs = now - 48 * HOUR;
  wakeAgentInDeck(state, "w1:p_idle", now);
  assert.equal(state.timers["w1:p_idle"]!.sleeping, undefined);
  assert.equal(state.timers["w1:p_idle"]!.sleepingSinceMs, undefined);
  assert.equal(state.timers["w1:p_idle"]!.wokeAtMs, now);

  const afterWake = buildDeckAgentItems(snapshot, state, new Map(), null, now + 1000);
  const woken = afterWake.find((x) => x.paneId === "w1:p_idle")!;
  assert.equal(woken.group, "idle");
  assert.equal(woken.sleepReason, null);

  // Still idle at 23h59m after wake, then auto-sleeps at >= 24h after wake
  const beforeThreshold = buildDeckAgentItems(snapshot, state, new Map(), null, now + 24 * HOUR - 60_000);
  assert.equal(beforeThreshold.find((x) => x.paneId === "w1:p_idle")!.group, "idle");
  const atThreshold = buildDeckAgentItems(snapshot, state, new Map(), null, now + 24 * HOUR);
  assert.equal(atThreshold.find((x) => x.paneId === "w1:p_idle")!.group, "sleeping");
  assert.equal(atThreshold.find((x) => x.paneId === "w1:p_idle")!.sleepReason, "auto");
});

test("24h auto-sleep threshold and HERDR_DECK_SLEEP_AFTER_HOURS env override", () => {
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  assert.equal(DEFAULT_SLEEP_AFTER_HOURS, 24);
  assert.equal(resolveSleepAfterMs({}), 24 * HOUR);
  assert.equal(resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "" }), 24 * HOUR);
  assert.equal(resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "not-a-number" }), 24 * HOUR);
  assert.equal(resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "0.5" }), 30 * MIN);
  assert.equal(resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "0" }), 0);
  assert.equal(resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "-4" }), 0);

  const now = 1_700_200_000_000;
  const snap = makeSleepTestSnapshot([
    { paneId: "w1:p_almost", label: "almost-24h", status: "idle" },
    { paneId: "w1:p_over", label: "over-24h", status: "idle" },
    { paneId: "w1:p_manual", label: "manual-sleep", status: "idle" },
  ]);
  const state = createEmptyState();
  state.timers["w1:p_almost"] = { status: "idle", sinceMs: now - (24 * HOUR - MIN) }; // 23h59m
  state.timers["w1:p_over"] = { status: "idle", sinceMs: now - 24 * HOUR }; // exactly 24h
  state.timers["w1:p_manual"] = { status: "idle", sinceMs: now - 5 * MIN, sleeping: true, sleepingSinceMs: now - 2 * MIN };

  // Default 24h threshold
  const defaultItems = buildDeckAgentItems(snap, state, new Map(), null, now, undefined, resolveSleepAfterMs({}));
  const defByPane = new Map(defaultItems.map((x) => [x.paneId, x]));
  assert.equal(defByPane.get("w1:p_almost")!.group, "idle");
  assert.equal(defByPane.get("w1:p_almost")!.sleepReason, null);
  assert.equal(defByPane.get("w1:p_over")!.group, "sleeping");
  assert.equal(defByPane.get("w1:p_over")!.sleepReason, "auto");
  assert.equal(defByPane.get("w1:p_manual")!.group, "sleeping");
  assert.equal(defByPane.get("w1:p_manual")!.sleepReason, "manual");

  // Fractional override (0.5h = 30m): both 23h59m and 24h auto-sleep
  const halfHourMs = resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "0.5" });
  const halfHourItems = buildDeckAgentItems(snap, state, new Map(), null, now, undefined, halfHourMs);
  assert.equal(halfHourItems.find((x) => x.paneId === "w1:p_almost")!.group, "sleeping");
  assert.equal(halfHourItems.find((x) => x.paneId === "w1:p_almost")!.sleepReason, "auto");

  // Disabled (0): even 24h+ stays idle, while manual sleeping still sleeps
  const disabledItems = buildDeckAgentItems(snap, state, new Map(), null, now, undefined, resolveSleepAfterMs({ HERDR_DECK_SLEEP_AFTER_HOURS: "0" }));
  assert.equal(disabledItems.find((x) => x.paneId === "w1:p_over")!.group, "idle");
  assert.equal(disabledItems.find((x) => x.paneId === "w1:p_over")!.sleepReason, null);
  assert.equal(disabledItems.find((x) => x.paneId === "w1:p_manual")!.group, "sleeping");
  assert.equal(disabledItems.find((x) => x.paneId === "w1:p_manual")!.sleepReason, "manual");
});

test("5-tier group priority and descending sinceMs ordering inside sleeping group", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_300_000_000;
  const snap = makeSleepTestSnapshot([
    { paneId: "w1:p_sleep_old", label: "sleep-oldest", status: "idle" },
    { paneId: "w1:p_idle", label: "hot-idle", status: "idle" },
    { paneId: "w1:p_sleep_mid", label: "sleep-mid", status: "idle" },
    { paneId: "w1:p_working", label: "working-one", status: "working" },
    { paneId: "w1:p_review", label: "review-one", status: "done", completionSeq: 2 },
    { paneId: "w1:p_blocked", label: "blocked-one", status: "blocked" },
    { paneId: "w1:p_sleep_new", label: "sleep-newest", status: "idle" },
  ]);

  const state = createEmptyState();
  state.timers["w1:p_blocked"] = { status: "blocked", sinceMs: now - 10_000 };
  state.timers["w1:p_review"] = { status: "done", sinceMs: now - 20_000 };
  state.timers["w1:p_working"] = { status: "working", sinceMs: now - 30_000, workingStartedMs: now - 30_000 };
  state.timers["w1:p_idle"] = { status: "idle", sinceMs: now - 40_000 };
  state.timers["w1:p_sleep_old"] = { status: "idle", sinceMs: now - 96 * HOUR };
  state.timers["w1:p_sleep_mid"] = { status: "idle", sinceMs: now - 36 * HOUR };
  state.timers["w1:p_sleep_new"] = { status: "idle", sinceMs: now - 2 * HOUR, sleeping: true, sleepingSinceMs: now - 1000 };

  const items = buildDeckAgentItems(snap, state, new Map(), null, now);
  assert.deepEqual(
    items.map((x) => [x.paneId, x.group]),
    [
      ["w1:p_blocked", "needs_you"],
      ["w1:p_review", "review"],
      ["w1:p_working", "working"],
      ["w1:p_idle", "idle"],
      ["w1:p_sleep_new", "sleeping"],
      ["w1:p_sleep_mid", "sleeping"],
      ["w1:p_sleep_old", "sleeping"],
    ],
  );
});

test("wake rules: markAgentSeenInDeck does not wake, working transition wakes, and remote reconcile handles seq advancement without migration false-wake", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_400_000_000;
  const state = createEmptyState();

  // 1) markAgentSeenInDeck does NOT clear sleeping and does NOT update wokeAtMs
  state.timers["w1:p1"] = {
    status: "done",
    sinceMs: now - 30 * HOUR,
    sleeping: true,
    sleepingSinceMs: now - 5 * HOUR,
    wokeAtMs: now - 40 * HOUR,
  };
  markAgentSeenInDeck(
    state,
    { pane_id: "w1:p1", agent_status: "done", completion_seq: 3, revision: 12 },
    now,
  );
  assert.equal(state.timers["w1:p1"]!.sleeping, true);
  assert.equal(state.timers["w1:p1"]!.sleepingSinceMs, now - 5 * HOUR);
  assert.equal(state.timers["w1:p1"]!.wokeAtMs, now - 40 * HOUR);

  // 2) Non-working status transition preserves sleeping & wokeAtMs
  recordAgentStatusTransition(state, "w1:p1", "idle", now + 1000);
  assert.equal(state.timers["w1:p1"]!.sleeping, true);
  assert.equal(state.timers["w1:p1"]!.wokeAtMs, now - 40 * HOUR);

  // 3) recordAgentStatusTransition(..., "working") clears sleeping/sleepingSinceMs and refreshes wokeAtMs
  recordAgentStatusTransition(state, "w1:p1", "working", now + 2000);
  assert.equal(state.timers["w1:p1"]!.sleeping, undefined);
  assert.equal(state.timers["w1:p1"]!.sleepingSinceMs, undefined);
  assert.equal(state.timers["w1:p1"]!.wokeAtMs, now + 2000);

  // Same-status working transition when sleeping was somehow set still clears sleeping & updates wokeAtMs
  state.timers["w1:p1"]!.sleeping = true;
  state.timers["w1:p1"]!.sleepingSinceMs = now + 2500;
  recordAgentStatusTransition(state, "w1:p1", "working", now + 3000);
  assert.equal(state.timers["w1:p1"]!.sleeping, undefined);
  assert.equal(state.timers["w1:p1"]!.sleepingSinceMs, undefined);
  assert.equal(state.timers["w1:p1"]!.wokeAtMs, now + 3000);

  // 4) Remote SSH machine reconcile: migration backfill does NOT false-wake
  const remoteKey = makeAgentTimerKey("w1:p_remote", "m-tokyo");
  state.timers[remoteKey] = {
    status: "idle",
    sinceMs: now - 30 * HOUR,
    sleeping: true,
    sleepingSinceMs: now - 10 * HOUR,
    // Old deck-state.json has no lastStateChangeSeq / lastCompletionSeq
  };

  const snapInitial = makeSleepTestSnapshot([
    { paneId: "w1:p_remote", label: "remote-box", status: "idle", stateChangeSeq: 10, completionSeq: 4, revision: 20 },
  ]);
  reconcileTimersWithSnapshot(state, snapInitial, now, "m-tokyo");
  assert.equal(state.timers[remoteKey]!.sleeping, true, "backfilling seqs on migration must not wake sleeping agent");
  assert.equal(state.timers[remoteKey]!.lastStateChangeSeq, 10);
  assert.equal(state.timers[remoteKey]!.lastCompletionSeq, 4);

  // 5) Remote state_change_seq advances -> auto-wakes & updates baseline
  const snapStateSeqAdvanced = makeSleepTestSnapshot([
    { paneId: "w1:p_remote", label: "remote-box", status: "idle", stateChangeSeq: 11, completionSeq: 4, revision: 21 },
  ]);
  reconcileTimersWithSnapshot(state, snapStateSeqAdvanced, now + 5000, "m-tokyo");
  assert.equal(state.timers[remoteKey]!.sleeping, undefined);
  assert.equal(state.timers[remoteKey]!.sleepingSinceMs, undefined);
  assert.equal(state.timers[remoteKey]!.wokeAtMs, now + 5000);
  assert.equal(state.timers[remoteKey]!.lastStateChangeSeq, 11);

  // 6) Remote completion_seq advances -> auto-wakes & updates baseline
  state.timers[remoteKey]!.sleeping = true;
  state.timers[remoteKey]!.sleepingSinceMs = now + 6000;
  const snapCompSeqAdvanced = makeSleepTestSnapshot([
    { paneId: "w1:p_remote", label: "remote-box", status: "idle", stateChangeSeq: 11, completionSeq: 5, revision: 22 },
  ]);
  reconcileTimersWithSnapshot(state, snapCompSeqAdvanced, now + 10_000, "m-tokyo");
  assert.equal(state.timers[remoteKey]!.sleeping, undefined);
  assert.equal(state.timers[remoteKey]!.wokeAtMs, now + 10_000);
  assert.equal(state.timers[remoteKey]!.lastCompletionSeq, 5);

  // 7) Remote agent_status === "working" -> auto-wakes
  state.timers[remoteKey]!.sleeping = true;
  state.timers[remoteKey]!.sleepingSinceMs = now + 11_000;
  const snapWorking = makeSleepTestSnapshot([
    { paneId: "w1:p_remote", label: "remote-box", status: "working", stateChangeSeq: 11, completionSeq: 5, revision: 23 },
  ]);
  reconcileTimersWithSnapshot(state, snapWorking, now + 15_000, "m-tokyo");
  assert.equal(state.timers[remoteKey]!.sleeping, undefined);
  assert.equal(state.timers[remoteKey]!.wokeAtMs, now + 15_000);
});

test("renderScreen & getVisibleItems handle collapsed/expanded SLEEPING group, top bar badge, empty state, and cheatsheet", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_500_000_000;
  const cols = 112;
  const rows = 26;

  const hotIdleItem: DeckAgentItem = {
    itemKey: "w1:p1",
    machineId: null,
    machineLabel: null,
    paneId: "w1:p1",
    workspaceId: "w1",
    tabId: "w1:t1",
    workspaceLabel: "misc",
    workspaceNumber: 1,
    tabLabel: "main",
    paneLabel: "hot-agent",
    primaryTitle: "hot-agent",
    branch: "main",
    cwd: "/repo/hot",
    agentKind: "claude",
    agentDisplayName: "claude",
    rawStatus: "idle",
    effectiveStatus: "idle",
    group: "idle",
    sleepReason: null,
    sinceMs: now - 5 * 60 * 1000,
    summary: "Idle at prompt",
    completionSeq: null,
    stateChangeSeq: 1,
    revision: 1,
    focusedInHerdr: true,
  };

  const sleepingManualItem: DeckAgentItem = {
    ...hotIdleItem,
    itemKey: "w1:p2",
    paneId: "w1:p2",
    paneLabel: "manual-sleeper",
    primaryTitle: "manual-sleeper",
    group: "sleeping",
    sleepReason: "manual",
    sinceMs: now - 10 * 60 * 1000,
    focusedInHerdr: false,
  };

  const sleepingAutoItem: DeckAgentItem = {
    ...hotIdleItem,
    itemKey: "w1:p3",
    paneId: "w1:p3",
    paneLabel: "auto-sleeper",
    primaryTitle: "auto-sleeper",
    group: "sleeping",
    sleepReason: "auto",
    sinceMs: now - 72 * HOUR,
    focusedInHerdr: false,
  };

  const extractRows = (frame: string): string[] =>
    [...frame.matchAll(/\x1b\[(\d+);1H([\s\S]*?)\x1b\[K/g)].map((m) => stripAnsi(m[2]!));

  const baseRenderState = {
    cols,
    rows,
    items: [hotIdleItem, sleepingManualItem, sleepingAutoItem],
    selectedItemKey: "w1:p1",
    focusMode: "list" as const,
    filterTab: "all" as const,
    showIdle: true,
    showSleeping: false,
    showHelp: false,
    previewText: "Ready.",
    replyDraft: "",
    replyCursor: 0,
    renameDraft: "",
    renameCursor: 0,
    toastMessage: null,
    toastKind: "info" as const,
    spinnerTick: 0,
    nowMs: now,
  };

  // 1) Collapsed by default (showSleeping = false): hides sleeping items, top bar counts only hot idle + shows ☾ 2 badge, bottom shows fold hint
  assert.deepEqual(
    getVisibleItems(baseRenderState).map((x) => x.itemKey),
    ["w1:p1"],
  );
  const collapsedFrame = renderScreen(baseRenderState);
  const collapsedLines = extractRows(collapsedFrame);
  assert.equal(collapsedLines.length, rows);
  for (const [idx, line] of collapsedLines.entries()) {
    assert.equal(visibleWidth(line), cols, `collapsed row ${idx} width mismatch: "${line}"`);
  }
  const collapsedText = collapsedLines.join("\n");
  assert.ok(collapsedText.includes("○ 1 空闲"), "top bar should count only hot idle");
  assert.ok(collapsedText.includes("☾ 2"), "top bar should show muted sleeping badge");
  assert.ok(collapsedText.includes("SLEEPING (2) · [S] 展开"), "bottom should show collapsed sleeping hint");
  assert.ok(!collapsedText.includes("manual-sleeper"), "sleeping cards should be hidden when collapsed");

  // 2) Only sleeping items exist + showSleeping = false -> empty state hint
  const onlySleepingState = {
    ...baseRenderState,
    items: [sleepingManualItem, sleepingAutoItem],
    selectedItemKey: null,
  };
  assert.deepEqual(getVisibleItems(onlySleepingState), []);
  const emptyFrame = renderScreen(onlySleepingState);
  const emptyLines = extractRows(emptyFrame);
  assert.equal(emptyLines.length, rows);
  for (const [idx, line] of emptyLines.entries()) {
    assert.equal(visibleWidth(line), cols, `empty-sleeping row ${idx} width mismatch: "${line}"`);
  }
  assert.ok(emptyLines.join("\n").includes("按 [S] 展开 2 个休眠 Session"));

  // 3) Expanded (showSleeping = true): renders ☾ SLEEPING (2) group header and sleeping cards
  const expandedState = { ...baseRenderState, showSleeping: true };
  assert.deepEqual(
    getVisibleItems(expandedState).map((x) => x.itemKey),
    ["w1:p1", "w1:p2", "w1:p3"],
  );
  const expandedFrame = renderScreen(expandedState);
  const expandedLines = extractRows(expandedFrame);
  assert.equal(expandedLines.length, rows);
  for (const [idx, line] of expandedLines.entries()) {
    assert.equal(visibleWidth(line), cols, `expanded row ${idx} width mismatch: "${line}"`);
  }
  const expandedText = expandedLines.join("\n");
  assert.ok(expandedText.includes("☾ SLEEPING (2)"), "expanded view should render SLEEPING group header");
  assert.ok(expandedText.includes("manual-sleeper"), "expanded view should render manual sleeping card");
  assert.ok(expandedText.includes("auto-sleeper"), "expanded view should render auto sleeping card");

  // 4) Cheatsheet includes s and S shortcuts
  const helpFrame = renderScreen({ ...baseRenderState, showHelp: true });
  const helpLines = extractRows(helpFrame);
  assert.equal(helpLines.length, rows);
  for (const [idx, line] of helpLines.entries()) {
    assert.equal(visibleWidth(line), cols, `help row ${idx} width mismatch: "${line}"`);
  }
  const helpText = helpLines.join("\n");
  assert.ok(helpText.includes("休眠 / 唤醒"), "cheatsheet should document s shortcut");
  assert.ok(helpText.includes("SLEEPING"), "cheatsheet should document S shortcut");
});
