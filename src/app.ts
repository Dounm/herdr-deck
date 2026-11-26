import { parseTerminalInput, toHerdrKeySpec, type ParsedKey } from "./keys.ts";
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

export async function runTuiApp(): Promise<void> {
  const client = new HerdrSocketClient();
  const selfPaneId = process.env.HERDR_PANE_ID ?? null;

  let persisted: PersistedDeckState = loadDeckState();

  let snapshot: SessionSnapshot | null = null;
  const snippetsByPane = new Map<string, string>();
  const lastFetchedRevision = new Map<string, number>();

  let items: DeckAgentItem[] = [];
  let selectedPaneId: string | null = null;
  let focusMode: UiFocusMode = "list";
  let filterTab: FilterTab = "all";
  let showIdle = true;
  let previewText = "";
  let previewPaneId: string | null = null;
  let previewScrollOffset = 0;
  let replyDraft = "";
  let toastMessage: string | null = null;
  let toastKind: "info" | "ok" | "warn" | "error" = "info";
  let toastTimer: NodeJS.Timeout | null = null;
  let spinnerTick = 0;

  let exiting = false;
  let renderScheduled = false;
  let refreshInFlight = false;
  let refreshQueued = false;
  let previewRefreshTimer: NodeJS.Timeout | null = null;
  let subHandle: { close: () => void } | null = null;

  const setToast = (msg: string, kind: "info" | "ok" | "warn" | "error" = "info", durationMs = 3200) => {
    toastMessage = msg;
    toastKind = kind;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastMessage = null;
      scheduleRender();
    }, durationMs);
    scheduleRender();
  };

  const getCurrentVisible = (): DeckAgentItem[] =>
    getVisibleItems({
      cols: process.stdout.columns || 100,
      rows: process.stdout.rows || 30,
      items,
      selectedPaneId,
      focusMode,
      filterTab,
      showIdle,
      previewText,
      previewScrollOffset,
      replyDraft,
      toastMessage,
      toastKind,
      spinnerTick,
      nowMs: Date.now(),
    });

  const getSelectedItem = (): DeckAgentItem | null => {
    const vis = getCurrentVisible();
    return vis.find((x) => x.paneId === selectedPaneId) ?? vis[0] ?? null;
  };

  const scheduleRender = () => {
    if (exiting || renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      if (exiting) return;
      const state: RenderState = {
        cols: process.stdout.columns || 100,
        rows: process.stdout.rows || 30,
        items,
        selectedPaneId,
        focusMode,
        filterTab,
        showIdle,
        previewText,
        previewScrollOffset,
        replyDraft,
        toastMessage,
        toastKind,
        spinnerTick,
        nowMs: Date.now(),
      };
      const frame = renderScreen(state);
      process.stdout.write(frame);
    });
  };

  const refreshSelectedPreview = async (force = false) => {
    const sel = getSelectedItem();
    if (!sel) {
      previewPaneId = null;
      previewText = "";
      scheduleRender();
      return;
    }

    const paneChanged = previewPaneId !== sel.paneId;
    if (paneChanged) {
      previewScrollOffset = 0;
    }

    try {
      const readRes = await client.readPane(sel.paneId, {
        source: "recent",
        format: "ansi",
        stripAnsi: false,
        lines: 120,
      });
      if (exiting) return;
      // Only apply if still selected (or cache snippet)
      snippetsByPane.set(sel.paneId, readRes.text);
      lastFetchedRevision.set(sel.paneId, readRes.revision);

      const currentSel = getSelectedItem();
      if (currentSel?.paneId === sel.paneId || force) {
        previewPaneId = sel.paneId;
        previewText = readRes.text;
      }

      if (snapshot) {
        items = buildDeckAgentItems(snapshot, persisted, snippetsByPane, selfPaneId);
      }
      scheduleRender();
    } catch {
      // Ignore transient read error if pane just closed
    }
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

      scheduleRender();
      await refreshSelectedPreview();
    } catch (err) {
      setToast(
        `Unable to query Herdr: ${err instanceof Error ? err.message : String(err)}`,
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
    // Restore cursor + leave alternate screen buffer
    process.stdout.write("\x1b[?25h\x1b[?1049l");

    await client.closePopup();
    process.exit(code);
  };

  const moveSelection = (delta: number) => {
    const vis = getCurrentVisible();
    if (vis.length === 0) return;
    const idx = vis.findIndex((x) => x.paneId === selectedPaneId);
    const cur = idx === -1 ? 0 : idx;
    const nextIdx = (cur + delta + vis.length) % vis.length;
    selectedPaneId = vis[nextIdx]!.paneId;
    previewScrollOffset = 0;
    scheduleRender();
    void refreshSelectedPreview(true);
  };

  const advanceToNextAttentionItem = (previousPaneId: string) => {
    const vis = getCurrentVisible();
    const nextUrgent = vis.find(
      (x) =>
        x.paneId !== previousPaneId &&
        (x.group === "needs_you" || x.group === "review"),
    );
    if (nextUrgent) {
      selectedPaneId = nextUrgent.paneId;
      previewScrollOffset = 0;
      void refreshSelectedPreview(true);
    }
  };

  const diveIntoSelectedAgent = async () => {
    const sel = getSelectedItem();
    if (!sel) return;

    // Mark seen in Deck state
    markAgentSeenInDeck(persisted, {
      pane_id: sel.paneId,
      agent_status: sel.rawStatus,
      completion_seq: sel.completionSeq,
      revision: sel.revision,
    });
    saveDeckState(persisted);

    // IMPORTANT: Focus target FIRST before closing popup!
    // Sending popup.close kills this process immediately via SIGHUP, so any code after closePopup() never runs!
    await client.focusWorkspace(sel.workspaceId);
    try {
      await client.focusAgent(sel.paneId);
    } catch {
      await client.focusPaneAcrossWorkspaces(sel.paneId, sel.workspaceId, sel.tabId);
    }
    await client.closePopup();
    await cleanupAndExit(0);
  };

  const quickSendKeyToSelected = async (herdrKey: string, label?: string) => {
    const sel = getSelectedItem();
    if (!sel) return;
    const wasUrgent = sel.group === "needs_you";
    try {
      await client.sendAgentKeys(sel.paneId, [herdrKey]);
      setToast(
        `Sent [${label ?? herdrKey}] → ${sel.workspaceLabel}/${sel.agentDisplayName}`,
        "ok",
        2000,
      );
      setTimeout(() => {
        void refreshSelectedPreview(true);
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
      // Fallback to raw pane.send_keys if agent authority rejected
      try {
        await client.sendPaneKeys(sel.paneId, [herdrKey]);
        setToast(`Sent [${label ?? herdrKey}] to pane ${sel.paneId}`, "ok", 2000);
        setTimeout(() => void refreshSelectedPreview(true), 140);
      } catch (err2) {
        setToast(
          `Key failed: ${err2 instanceof Error ? err2.message : String(err)}`,
          "error",
        );
      }
    }
  };

  const submitInlineReply = async () => {
    const sel = getSelectedItem();
    const text = replyDraft.trim();
    if (!sel) {
      focusMode = "list";
      scheduleRender();
      return;
    }
    if (!text) {
      focusMode = "list";
      scheduleRender();
      return;
    }

    try {
      await client.sendAgentPrompt(sel.paneId, text);
      replyDraft = "";
      focusMode = "list";
      markAgentSeenInDeck(persisted, {
        pane_id: sel.paneId,
        agent_status: sel.rawStatus,
        completion_seq: sel.completionSeq,
        revision: sel.revision,
      });
      saveDeckState(persisted);
      setToast(`Prompt sent → ${sel.workspaceLabel}/${sel.agentDisplayName}`, "ok");
      setTimeout(() => {
        void refreshSnapshot(true);
        void refreshSelectedPreview(true);
      }, 180);
    } catch (err) {
      if (err instanceof HerdrRpcError && err.code === "agent_blocked") {
        setToast(
          "Agent is blocked on an approval dialog! Approve with [y/n/1-4] or [Tab] first.",
          "warn",
          4500,
        );
        focusMode = "list";
        scheduleRender();
        return;
      }
      setToast(
        `Prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  const handleListModeKey = async (key: ParsedKey) => {
    if (key.kind === "ctrl" && key.key === "c") {
      await cleanupAndExit(0);
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
        case "tab":
          if (getSelectedItem()) {
            focusMode = "interact";
            setToast("Live Key Passthrough active — keys go directly to right-side agent (Esc/Tab to exit)", "info", 2800);
          }
          return;
        case "pageup":
          previewScrollOffset += 10;
          scheduleRender();
          return;
        case "pagedown":
          previewScrollOffset = Math.max(0, previewScrollOffset - 10);
          scheduleRender();
          return;
        case "space":
          // Toggle mark reviewed
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
      if (key.key === "u") {
        previewScrollOffset += 10;
        scheduleRender();
        return;
      }
      if (key.key === "d") {
        previewScrollOffset = Math.max(0, previewScrollOffset - 10);
        scheduleRender();
        return;
      }
      if (key.key === "r") {
        await refreshSnapshot(true);
        setToast("Refreshed snapshot", "info", 1400);
        return;
      }
    }

    if (key.kind === "char") {
      switch (key.value) {
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
            selectedPaneId = vis[0].paneId;
            previewScrollOffset = 0;
            scheduleRender();
            void refreshSelectedPreview(true);
          }
          return;
        }
        case "G": {
          const vis = getCurrentVisible();
          if (vis.length > 0) {
            selectedPaneId = vis[vis.length - 1]!.paneId;
            previewScrollOffset = 0;
            scheduleRender();
            void refreshSelectedPreview(true);
          }
          return;
        }
        case "r":
        case "/":
          if (getSelectedItem()) {
            focusMode = "reply";
            scheduleRender();
          }
          return;
        case "i":
          if (getSelectedItem()) {
            focusMode = "interact";
            setToast("Live Key Passthrough active (Esc/Tab to exit)", "info", 2400);
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
              void refreshSelectedPreview(true);
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
              void refreshSelectedPreview(true);
            }
          }
          scheduleRender();
          return;
        case "[":
          previewScrollOffset += 6;
          scheduleRender();
          return;
        case "]":
          previewScrollOffset = Math.max(0, previewScrollOffset - 6);
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
            // Jump to Nth visible item when not on a blocked agent
            const vis = getCurrentVisible();
            const idx = Number(key.value) - 1;
            if (vis[idx]) {
              selectedPaneId = vis[idx].paneId;
              previewScrollOffset = 0;
              scheduleRender();
              void refreshSelectedPreview(true);
            }
          } else {
            setToast(
              `Selected agent isn't blocked. Press [Tab] for live keys or [r] to reply.`,
              "info",
              2400,
            );
          }
          return;
        }
        default:
          break;
      }
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
    setToast(`Marked ${sel.workspaceLabel}/${sel.agentDisplayName} reviewed`, "ok", 1800);
    advanceToNextAttentionItem(sel.paneId);
    scheduleRender();
  };

  const handleInteractModeKey = async (key: ParsedKey) => {
    if (key.kind === "ctrl" && key.key === "c") {
      focusMode = "list";
      scheduleRender();
      return;
    }
    if (key.kind === "special" && (key.name === "esc" || key.name === "tab")) {
      focusMode = "list";
      setToast("Returned to Agent List", "info", 1400);
      return;
    }
    // Ctrl+E sends literal Escape into the agent dialog while staying in interact mode
    if (key.kind === "ctrl" && key.key === "e") {
      await quickSendKeyToSelected("esc", "Esc");
      return;
    }

    const spec = toHerdrKeySpec(key);
    if (spec) {
      await quickSendKeyToSelected(spec);
    }
  };

  const handleReplyModeKey = async (key: ParsedKey) => {
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
      if (key.name === "backspace") {
        const chars = Array.from(replyDraft);
        chars.pop();
        replyDraft = chars.join("");
        scheduleRender();
        return;
      }
      if (key.name === "space") {
        replyDraft += " ";
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
      if (key.key === "u") {
        replyDraft = "";
        scheduleRender();
        return;
      }
      if (key.key === "w") {
        replyDraft = replyDraft.replace(/\S+\s*$/, "");
        scheduleRender();
        return;
      }
      return;
    }

    if (key.kind === "char") {
      replyDraft += key.value;
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
      for (const k of keys) {
        if (exiting) break;
        if (focusMode === "reply") {
          await handleReplyModeKey(k);
        } else if (focusMode === "interact") {
          await handleInteractModeKey(k);
        } else {
          await handleListModeKey(k);
        }
      }
    })();
  });

  process.stdout.on("resize", () => {
    scheduleRender();
  });

  process.on("SIGINT", () => void cleanupAndExit(0));
  process.on("SIGTERM", () => void cleanupAndExit(0));

  // Initial load & live subscription
  await refreshSnapshot(false);
  const initialAgentPaneIds = items.map((x) => x.paneId);
  startSubscriptions(initialAgentPaneIds);

  let knownSubSet = initialAgentPaneIds.join(",");

  // 1-second heartbeat for live working/blocked timers, spinner animation, and active preview polling
  previewRefreshTimer = setInterval(() => {
    if (exiting) return;
    spinnerTick = (spinnerTick + 1) % 10;

    // Resubscribe if live agent pane list changed
    const currentSet = items.map((x) => x.paneId).join(",");
    if (currentSet !== knownSubSet) {
      knownSubSet = currentSet;
      startSubscriptions(items.map((x) => x.paneId));
    }

    const sel = getSelectedItem();
    if (
      sel &&
      (sel.group === "working" || sel.group === "needs_you" || focusMode === "interact")
    ) {
      void refreshSelectedPreview();
    } else {
      scheduleRender();
    }
  }, 900);
}
