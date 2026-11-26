import { parseTerminalInput, type ParsedKey } from "./keys.ts";
import { buildDeckAgentItems } from "./model.ts";
import { getVisibleItems, renderScreen, type FilterTab, type RenderState, type UiFocusMode } from "./render.ts";
import { HerdrRpcError, HerdrSocketClient } from "./socket-client.ts";
import {
  loadDeckState,
  markAgentSeenInDeck,
  reconcileTimersWithSnapshot,
  recordAgentStatusTransition,
  saveDeckState,
} from "./state.ts";
import type { AgentStatus, DeckAgentItem, PersistedDeckState, SessionSnapshot } from "./types.ts";

const GLOBAL_SUBSCRIPTIONS = [
  { type: "workspace.created" },
  { type: "workspace.updated" },
  { type: "workspace.renamed" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.renamed" },
  { type: "tab.closed" },
  { type: "pane.created" },
  { type: "pane.updated" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
];

function readOriginFocusedPaneId(): string | null {
  const rawCtx = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (rawCtx) {
    try {
      const ctx = JSON.parse(rawCtx) as Record<string, unknown>;
      if (typeof ctx.focused_pane_id === "string" && ctx.focused_pane_id) {
        return ctx.focused_pane_id;
      }
      if (typeof ctx.pane_id === "string" && ctx.pane_id) {
        return ctx.pane_id;
      }
    } catch {
      // ignore
    }
  }
  return process.env.HERDR_PANE_ID ?? null;
}

export async function runTuiApp(): Promise<void> {
  const client = new HerdrSocketClient();
  const selfPaneId = process.env.HERDR_PANE_ID ?? null;
  let originFocusedPaneId: string | null = readOriginFocusedPaneId();

  let persisted: PersistedDeckState = loadDeckState();

  let snapshot: SessionSnapshot | null = null;
  const snippetsByPane = new Map<string, string>();
  const previewCache = new Map<string, string>();
  const lastFetchedRevision = new Map<string, number>();

  let items: DeckAgentItem[] = [];
  let selectedPaneId: string | null = null;
  let focusMode: UiFocusMode = "list";
  let filterTab: FilterTab = "all";
  let showIdle = true;
  let showHelp = false;
  let previewText = "";
  let replyDraft = "";
  let replyCursor = 0;
  let toastMessage: string | null = null;
  let toastKind: "info" | "ok" | "warn" | "error" = "info";
  let toastTimer: NodeJS.Timeout | null = null;
  let spinnerTick = 0;

  let exiting = false;
  let renderScheduled = false;
  let lastRenderedFrame = "";
  let refreshInFlight = false;
  let refreshQueued = false;
  let previewRequestSeq = 0;
  let previewDebounceTimer: NodeJS.Timeout | null = null;
  let previewRefreshTimer: NodeJS.Timeout | null = null;
  let subHandle: { close: () => void } | null = null;

  const setToast = (msg: string, kind: "info" | "ok" | "warn" | "error" = "info", durationMs = 3000) => {
    toastMessage = msg;
    toastKind = kind;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastMessage = null;
      scheduleRender();
    }, durationMs);
    scheduleRender();
  };

  const buildRenderState = (): RenderState => ({
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
    items,
    selectedPaneId,
    focusMode,
    filterTab,
    showIdle,
    showHelp,
    previewText,
    replyDraft,
    replyCursor,
    toastMessage,
    toastKind,
    spinnerTick,
    nowMs: Date.now(),
  });

  const getCurrentVisible = (): DeckAgentItem[] => getVisibleItems(buildRenderState());

  const getSelectedItem = (): DeckAgentItem | null => {
    const vis = getCurrentVisible();
    return vis.find((x) => x.paneId === selectedPaneId) ?? vis[0] ?? null;
  };

  const scheduleRender = (forceWrite = false) => {
    if (exiting || renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      if (exiting) return;
      const frame = renderScreen(buildRenderState());
      if (!forceWrite && frame === lastRenderedFrame) {
        return;
      }
      lastRenderedFrame = frame;
      process.stdout.write(frame);
    });
  };

  const fetchPreviewForPane = async (targetPaneId: string, seq: number) => {
    try {
      const readRes = await client.readPane(targetPaneId, {
        source: "recent",
        format: "ansi",
        stripAnsi: false,
        lines: 100,
      });
      if (exiting) return;

      previewCache.set(targetPaneId, readRes.text);
      snippetsByPane.set(targetPaneId, readRes.text);
      lastFetchedRevision.set(targetPaneId, readRes.revision);

      // Strict generation & selection guard: never let a stale response overwrite a newer selection
      const currentSel = getSelectedItem();
      if (seq !== previewRequestSeq || currentSel?.paneId !== targetPaneId) {
        return;
      }

      const previewChanged = previewText !== readRes.text;
      previewText = readRes.text;

      if (snapshot) {
        const nextItems = buildDeckAgentItems(snapshot, persisted, snippetsByPane, selfPaneId);
        items = nextItems;
      }
      if (previewChanged) {
        scheduleRender();
      }
    } catch {
      // Ignore transient read error if pane just closed
    }
  };

  const requestSelectedPreview = (debounceMs = 0) => {
    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = null;
    }

    const sel = getSelectedItem();
    if (!sel) {
      previewRequestSeq += 1;
      previewText = "";
      scheduleRender();
      return;
    }

    const seq = ++previewRequestSeq;
    const targetPaneId = sel.paneId;

    // Immediately show cached preview for this pane so rapid j/k navigation never flashes blank or old pane
    const cached = previewCache.get(targetPaneId);
    if (cached !== undefined) {
      previewText = cached;
    }

    if (debounceMs <= 0) {
      void fetchPreviewForPane(targetPaneId, seq);
      return;
    }

    previewDebounceTimer = setTimeout(() => {
      previewDebounceTimer = null;
      if (exiting || seq !== previewRequestSeq) return;
      void fetchPreviewForPane(targetPaneId, seq);
    }, debounceMs);
  };

  const refreshSnippetsForPriorityAgents = async (snap: SessionSnapshot) => {
    const candidates = snap.agents.filter(
      (a) =>
        a.pane_id !== selfPaneId &&
        (a.agent_status === "blocked" || a.agent_status === "done" || a.agent_status === "working"),
    );

    await Promise.all(
      candidates.slice(0, 12).map(async (agent) => {
        const prevRev = lastFetchedRevision.get(agent.pane_id);
        if (prevRev !== undefined && prevRev === agent.revision && snippetsByPane.has(agent.pane_id)) {
          return;
        }
        try {
          const res = await client.readPane(agent.pane_id, {
            source: "detection",
            format: "text",
            stripAnsi: true,
          });
          snippetsByPane.set(agent.pane_id, res.text);
          lastFetchedRevision.set(agent.pane_id, res.revision);
        } catch {
          // ignore
        }
      }),
    );
  };

  const refreshSnapshot = async (preserveSelection = true) => {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    try {
      persisted = loadDeckState();

      const snap = await client.getSnapshot();
      snapshot = snap;
      if (!originFocusedPaneId && snap.focused_pane_id) {
        originFocusedPaneId = snap.focused_pane_id;
      }

      const dirty = reconcileTimersWithSnapshot(persisted, snap);
      if (dirty) {
        saveDeckState(persisted);
      }

      await refreshSnippetsForPriorityAgents(snap);

      items = buildDeckAgentItems(snap, persisted, snippetsByPane, selfPaneId);

      const vis = getCurrentVisible();
      if (!preserveSelection || !selectedPaneId || !vis.some((x) => x.paneId === selectedPaneId)) {
        selectedPaneId = vis[0]?.paneId ?? null;
      }

      const sel = getSelectedItem();
      if (sel && previewCache.has(sel.paneId)) {
        previewText = previewCache.get(sel.paneId)!;
      }

      scheduleRender();
      requestSelectedPreview(0);
    } catch (err) {
      setToast(
        `无法读取 Herdr 状态: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshSnapshot(true);
      }
    }
  };

  const startSubscriptions = (agentPaneIds: string[]) => {
    subHandle?.close();
    const perAgentStatusSubs = agentPaneIds.map((pane_id) => ({
      type: "pane.agent_status_changed",
      pane_id,
    }));

    subHandle = client.subscribe([...GLOBAL_SUBSCRIPTIONS, ...perAgentStatusSubs], {
      onEvent: (ev) => {
        if (ev.event === "pane.agent_status_changed") {
          const paneId = typeof ev.data.pane_id === "string" ? ev.data.pane_id : null;
          const nextStatus = ev.data.agent_status as AgentStatus | undefined;
          if (paneId && nextStatus) {
            recordAgentStatusTransition(persisted, paneId, nextStatus);
            saveDeckState(persisted);
          }
        }
        void refreshSnapshot(true);
      },
      onEventsLost: () => {
        void refreshSnapshot(true).then(() => {
          startSubscriptions(items.map((x) => x.paneId));
        });
      },
      onClose: () => {
        if (!exiting) {
          setTimeout(() => {
            if (!exiting) {
              startSubscriptions(items.map((x) => x.paneId));
            }
          }, 1200);
        }
      },
    });
  };

  const cleanupAndExit = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    subHandle?.close();
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    if (previewRefreshTimer) clearInterval(previewRefreshTimer);
    if (toastTimer) clearTimeout(toastTimer);

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdin.pause();
    // Ensure synchronized output is off, re-enable line auto-wrap, reset cursor shape, restore cursor, and leave alternate screen
    process.stdout.write("\x1b[?2026l\x1b[?7h\x1b[0 q\x1b[?25h\x1b[?1049l");

    await client.closePopup();
    process.exit(code);
  };

  const selectPaneById = (nextPaneId: string) => {
    if (selectedPaneId === nextPaneId) return;
    selectedPaneId = nextPaneId;
    const cached = previewCache.get(nextPaneId);
    if (cached !== undefined) {
      previewText = cached;
    }
    scheduleRender();
    requestSelectedPreview(55);
  };

  const moveSelection = (delta: number) => {
    const vis = getCurrentVisible();
    if (vis.length === 0) return;
    const idx = vis.findIndex((x) => x.paneId === selectedPaneId);
    const cur = idx === -1 ? 0 : idx;
    const nextIdx = (cur + delta + vis.length) % vis.length;
    selectPaneById(vis[nextIdx]!.paneId);
  };

  const advanceToNextAttentionItem = (previousPaneId: string) => {
    const vis = getCurrentVisible();
    const nextUrgent = vis.find(
      (x) =>
        x.paneId !== previousPaneId &&
        (x.group === "needs_you" || x.group === "review"),
    );
    if (nextUrgent) {
      selectPaneById(nextUrgent.paneId);
    }
  };

  const diveIntoSelectedAgent = async () => {
    const sel = getSelectedItem();
    if (!sel || exiting) return;

    markAgentSeenInDeck(persisted, {
      pane_id: sel.paneId,
      agent_status: sel.rawStatus,
      completion_seq: sel.completionSeq,
      revision: sel.revision,
    });
    saveDeckState(persisted);

    const alreadyFocused =
      sel.focusedInHerdr ||
      (originFocusedPaneId !== null && sel.paneId === originFocusedPaneId);

    // IMPORTANT: Focus target FIRST before closing popup (popup.close terminates us via SIGHUP).
    // If target is already the focused underlying pane, skip redundant focus RPCs and close cleanly!
    if (!alreadyFocused) {
      try {
        await client.focusWorkspace(sel.workspaceId);
      } catch {
        // continue to agent/pane focus fallback
      }
      try {
        await client.focusAgent(sel.paneId);
      } catch {
        try {
          await client.focusPaneAcrossWorkspaces(sel.paneId, sel.workspaceId, sel.tabId);
        } catch {
          // still close popup cleanly
        }
      }
    }

    await cleanupAndExit(0);
  };

  const quickSendKeyToSelected = async (herdrKey: string, label?: string) => {
    const sel = getSelectedItem();
    if (!sel) return;
    const wasUrgent = sel.group === "needs_you";
    try {
      await client.sendAgentKeys(sel.paneId, [herdrKey]);
      setToast(`已发送 [${label ?? herdrKey}] → ${sel.primaryTitle}`, "ok", 2000);
      setTimeout(() => {
        requestSelectedPreview(0);
        void refreshSnapshot(true).then(() => {
          if (wasUrgent && focusMode === "list") {
            const updated = items.find((x) => x.paneId === sel.paneId);
            if (updated && updated.group !== "needs_you") {
              advanceToNextAttentionItem(sel.paneId);
            }
          }
        });
      }, 140);
    } catch (err) {
      try {
        await client.sendPaneKeys(sel.paneId, [herdrKey]);
        setToast(`已发送 [${label ?? herdrKey}] → ${sel.primaryTitle}`, "ok", 2000);
        setTimeout(() => requestSelectedPreview(0), 140);
      } catch (err2) {
        setToast(
          `发送按键失败: ${err2 instanceof Error ? err2.message : String(err)}`,
          "error",
        );
      }
    }
  };

  const submitInlineReply = async () => {
    const sel = getSelectedItem();
    const text = replyDraft.trim();
    if (!sel || !text) {
      focusMode = "list";
      scheduleRender();
      return;
    }

    try {
      await client.sendAgentPrompt(sel.paneId, text);
      replyDraft = "";
      replyCursor = 0;
      focusMode = "list";
      markAgentSeenInDeck(persisted, {
        pane_id: sel.paneId,
        agent_status: sel.rawStatus,
        completion_seq: sel.completionSeq,
        revision: sel.revision,
      });
      saveDeckState(persisted);
      setToast(`已发送回复 → ${sel.primaryTitle}`, "ok");
      setTimeout(() => {
        void refreshSnapshot(true);
      }, 180);
    } catch (err) {
      if (err instanceof HerdrRpcError && err.code === "agent_blocked") {
        setToast(
          "该 Agent 正卡在审批弹窗，请先用 [y/n/1-4] 审批或按 [Enter] 进入终端处理",
          "warn",
          4200,
        );
        focusMode = "list";
        scheduleRender();
        return;
      }
      setToast(
        `发送失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  const markSelectedReviewed = () => {
    const sel = getSelectedItem();
    if (!sel) return;
    markAgentSeenInDeck(persisted, {
      pane_id: sel.paneId,
      agent_status: sel.rawStatus,
      completion_seq: sel.completionSeq,
      revision: sel.revision,
    });
    saveDeckState(persisted);
    if (snapshot) {
      items = buildDeckAgentItems(snapshot, persisted, snippetsByPane, selfPaneId);
    }
    setToast(`已将 ${sel.primaryTitle} 标记为已审阅`, "ok", 1800);
    advanceToNextAttentionItem(sel.paneId);
    scheduleRender();
  };

  const handleListModeKey = async (key: ParsedKey) => {
    if (key.kind === "ctrl" && key.key === "c") {
      await cleanupAndExit(0);
      return;
    }

    // Help overlay intercepts navigation cleanly
    if (showHelp) {
      if (
        (key.kind === "special" && (key.name === "esc" || key.name === "enter" || key.name === "space")) ||
        (key.kind === "char" && (key.value === "?" || key.value === "q"))
      ) {
        showHelp = false;
        scheduleRender();
      }
      return;
    }

    if (key.kind === "special") {
      switch (key.name) {
        case "esc":
          await cleanupAndExit(0);
          return;
        case "down":
          moveSelection(1);
          return;
        case "up":
          moveSelection(-1);
          return;
        case "enter":
          await diveIntoSelectedAgent();
          return;
        case "space":
          markSelectedReviewed();
          return;
        default:
          break;
      }
    }

    if (key.kind === "ctrl") {
      if (key.key === "n" || key.key === "j") {
        moveSelection(1);
        return;
      }
      if (key.key === "p" || key.key === "k") {
        moveSelection(-1);
        return;
      }
      if (key.key === "r") {
        await refreshSnapshot(true);
        setToast("已刷新全部 Agent 状态", "info", 1400);
        return;
      }
    }

    if (key.kind === "char") {
      switch (key.value) {
        case "?":
          showHelp = true;
          scheduleRender();
          return;
        case "q":
          await cleanupAndExit(0);
          return;
        case "j":
          moveSelection(1);
          return;
        case "k":
          moveSelection(-1);
          return;
        case "g": {
          const vis = getCurrentVisible();
          if (vis[0]) {
            selectPaneById(vis[0].paneId);
          }
          return;
        }
        case "G": {
          const vis = getCurrentVisible();
          if (vis.length > 0) {
            selectPaneById(vis[vis.length - 1]!.paneId);
          }
          return;
        }
        case "r":
        case "/":
          if (getSelectedItem()) {
            focusMode = "reply";
            replyCursor = Array.from(replyDraft).length;
            scheduleRender();
          }
          return;
        case "m":
          markSelectedReviewed();
          return;
        case "f":
          filterTab =
            filterTab === "all"
              ? "attention"
              : filterTab === "attention"
                ? "working"
                : "all";
          {
            const vis = getCurrentVisible();
            if (!vis.some((x) => x.paneId === selectedPaneId)) {
              selectedPaneId = vis[0]?.paneId ?? null;
              requestSelectedPreview(0);
            }
          }
          scheduleRender();
          return;
        case "z":
          showIdle = !showIdle;
          {
            const vis = getCurrentVisible();
            if (!vis.some((x) => x.paneId === selectedPaneId)) {
              selectedPaneId = vis[0]?.paneId ?? null;
              requestSelectedPreview(0);
            }
          }
          scheduleRender();
          return;
        case "y":
        case "Y":
        case "n":
        case "N":
        case "a":
        case "1":
        case "2":
        case "3":
        case "4": {
          const sel = getSelectedItem();
          if (!sel) return;
          if (sel.group === "needs_you") {
            await quickSendKeyToSelected(key.value, key.value);
          } else if (/^[1-4]$/.test(key.value)) {
            const vis = getCurrentVisible();
            const idx = Number(key.value) - 1;
            if (vis[idx]) {
              selectPaneById(vis[idx].paneId);
            }
          } else {
            setToast("当前 Agent 未处于阻塞审批态，按 [r] 回复或 [Enter] 进入终端", "info", 2400);
          }
          return;
        }
        default:
          break;
      }
    }
  };

  const handleReplyModeKey = async (key: ParsedKey) => {
    const chars = Array.from(replyDraft);
    const pos = Math.max(0, Math.min(chars.length, replyCursor));

    if (key.kind === "special") {
      if (key.name === "esc") {
        focusMode = "list";
        scheduleRender();
        return;
      }
      if (key.name === "enter") {
        await submitInlineReply();
        return;
      }
      if (key.name === "left") {
        replyCursor = Math.max(0, pos - 1);
        scheduleRender();
        return;
      }
      if (key.name === "right") {
        replyCursor = Math.min(chars.length, pos + 1);
        scheduleRender();
        return;
      }
      if (key.name === "home") {
        replyCursor = 0;
        scheduleRender();
        return;
      }
      if (key.name === "end") {
        replyCursor = chars.length;
        scheduleRender();
        return;
      }
      if (key.name === "backspace") {
        if (pos > 0) {
          chars.splice(pos - 1, 1);
          replyDraft = chars.join("");
          replyCursor = pos - 1;
          scheduleRender();
        }
        return;
      }
      if (key.name === "delete") {
        if (pos < chars.length) {
          chars.splice(pos, 1);
          replyDraft = chars.join("");
          scheduleRender();
        }
        return;
      }
      if (key.name === "space") {
        chars.splice(pos, 0, " ");
        replyDraft = chars.join("");
        replyCursor = pos + 1;
        scheduleRender();
        return;
      }
      return;
    }

    if (key.kind === "ctrl") {
      if (key.key === "c") {
        focusMode = "list";
        scheduleRender();
        return;
      }
      if (key.key === "a") {
        replyCursor = 0;
        scheduleRender();
        return;
      }
      if (key.key === "e") {
        replyCursor = chars.length;
        scheduleRender();
        return;
      }
      if (key.key === "u") {
        replyDraft = chars.slice(pos).join("");
        replyCursor = 0;
        scheduleRender();
        return;
      }
      if (key.key === "w") {
        const before = chars.slice(0, pos).join("");
        const after = chars.slice(pos).join("");
        const trimmedBefore = before.replace(/\S+\s*$/, "");
        replyDraft = trimmedBefore + after;
        replyCursor = Array.from(trimmedBefore).length;
        scheduleRender();
        return;
      }
      return;
    }

    if (key.kind === "char") {
      chars.splice(pos, 0, key.value);
      replyDraft = chars.join("");
      replyCursor = pos + 1;
      scheduleRender();
    }
  };

  // Enter alternate screen buffer + hide cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  process.stdin.on("data", (buf: Buffer) => {
    const keys = parseTerminalInput(buf);
    void (async () => {
      try {
        for (const k of keys) {
          if (exiting) break;
          if (focusMode === "reply") {
            await handleReplyModeKey(k);
          } else {
            await handleListModeKey(k);
          }
        }
      } catch (err) {
        if (!exiting) {
          setToast(`操作异常: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
    })();
  });

  process.stdout.on("resize", () => {
    scheduleRender(true);
  });

  process.on("SIGINT", () => void cleanupAndExit(0));
  process.on("SIGTERM", () => void cleanupAndExit(0));

  // Initial load & live subscription
  await refreshSnapshot(false);
  const initialAgentPaneIds = items.map((x) => x.paneId);
  startSubscriptions(initialAgentPaneIds);

  let knownSubSet = initialAgentPaneIds.join(",");

  // Heartbeat for live timers & active preview polling (skip redundant redraws when everything is static)
  previewRefreshTimer = setInterval(() => {
    if (exiting) return;

    const currentSet = items.map((x) => x.paneId).join(",");
    if (currentSet !== knownSubSet) {
      knownSubSet = currentSet;
      startSubscriptions(items.map((x) => x.paneId));
    }

    const hasActiveTimers = items.some(
      (x) => x.group === "working" || x.group === "needs_you" || x.group === "review",
    );
    const sel = getSelectedItem();
    const shouldPollPreview =
      !showHelp &&
      sel !== null &&
      (sel.group === "working" || sel.group === "needs_you");

    if (hasActiveTimers) {
      spinnerTick = (spinnerTick + 1) % 10;
    }

    if (shouldPollPreview) {
      requestSelectedPreview(0);
    } else if (hasActiveTimers && !showHelp) {
      scheduleRender();
    }
  }, 900);
}
