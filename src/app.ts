import { refreshGitInfoForCwds, type GitCacheEntry } from "./git.ts";
import { parseTerminalInput, type ParsedKey } from "./keys.ts";
import {
  buildMultiMachineDeckItems,
  collectSnapshotGitCwds,
  type MachineSnapshotSource,
} from "./model.ts";
import { HerdrCliError, HerdrMachineCliClient } from "./remote-client.ts";
import { getVisibleItems, renderScreen, type FilterTab, type RenderState, type UiFocusMode } from "./render.ts";
import { HerdrRpcError, HerdrSocketClient } from "./socket-client.ts";
import {
  loadDeckState,
  makeAgentTimerKey,
  markAgentSeenInDeck,
  reconcileTimersWithSnapshot,
  recordAgentStatusTransition,
  saveDeckState,
} from "./state.ts";
import type {
  AgentStatus,
  DeckAgentItem,
  GitRepoInfo,
  MachineProfile,
  PersistedDeckState,
  SessionSnapshot,
} from "./types.ts";

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

const REMOTE_SNAPSHOT_INTERVAL_MS = 4500;
const REMOTE_MACHINE_LIST_TTL_MS = 30000;
const REMOTE_PREVIEW_POLL_INTERVAL_MS = 3600;

export async function runTuiApp(): Promise<void> {
  const client = new HerdrSocketClient();
  const remoteClient = new HerdrMachineCliClient();
  const selfPaneId = process.env.HERDR_PANE_ID ?? null;
  let originFocusedPaneId: string | null = readOriginFocusedPaneId();

  let persisted: PersistedDeckState = loadDeckState();

  let snapshot: SessionSnapshot | null = null;
  let remoteMachines: MachineProfile[] = [];
  let lastMachineListFetchMs = 0;
  let lastRemoteSnapshotFetchMs = 0;
  let lastRemotePreviewPollMs = 0;
  let remoteRefreshInFlight = false;
  const remoteSnapshots = new Map<string, SessionSnapshot>();

  const snippetsByKey = new Map<string, string>();
  const previewCache = new Map<string, string>();
  const lastFetchedRevision = new Map<string, number>();
  const gitCache = new Map<string, GitCacheEntry>();
  const gitInfoByCwd = new Map<string, GitRepoInfo | null>();
  let gitRefreshInFlight = false;

  let items: DeckAgentItem[] = [];
  let selectedItemKey: string | null = null;
  let focusMode: UiFocusMode = "list";
  let filterTab: FilterTab = "all";
  let showIdle = true;
  let showHelp = false;
  let previewText = "";
  let replyDraft = "";
  let replyCursor = 0;
  let renameDraft = "";
  let renameCursor = 0;
  let renameTargetItem: { itemKey: string; paneId: string; machineId: string | null } | null = null;
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
    selectedItemKey,
    focusMode,
    filterTab,
    showIdle,
    showHelp,
    previewText,
    replyDraft,
    replyCursor,
    renameDraft,
    renameCursor,
    toastMessage,
    toastKind,
    spinnerTick,
    nowMs: Date.now(),
  });

  const getCurrentVisible = (): DeckAgentItem[] => getVisibleItems(buildRenderState());

  const getSelectedItem = (): DeckAgentItem | null => {
    const vis = getCurrentVisible();
    return vis.find((x) => x.itemKey === selectedItemKey) ?? vis[0] ?? null;
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

  const rebuildItemsFromSnapshot = () => {
    const sources: MachineSnapshotSource[] = [];
    if (snapshot) {
      sources.push({
        snapshot,
        excludePaneId: selfPaneId,
        gitInfoByCwd,
      });
    }
    for (const machine of remoteMachines) {
      const rSnap = remoteSnapshots.get(machine.id);
      if (!rSnap) continue;
      sources.push({
        machineId: machine.id,
        machineLabel: machine.label,
        snapshot: rSnap,
      });
    }
    items = buildMultiMachineDeckItems(sources, persisted, snippetsByKey, Date.now());
  };

  const triggerGitRefresh = (force = false) => {
    if (!snapshot || gitRefreshInFlight || exiting) return;
    const cwds = collectSnapshotGitCwds(snapshot, selfPaneId);
    if (cwds.length === 0) return;

    gitRefreshInFlight = true;
    void refreshGitInfoForCwds(cwds, gitCache, { force })
      .then(({ changed }) => {
        if (exiting) return;
        for (const [cwd, entry] of gitCache) {
          gitInfoByCwd.set(cwd, entry.info);
        }
        if (changed && snapshot) {
          rebuildItemsFromSnapshot();
          scheduleRender();
        }
      })
      .finally(() => {
        gitRefreshInFlight = false;
      });
  };

  const fetchPreviewForItem = async (target: DeckAgentItem, seq: number) => {
    try {
      const readRes = target.machineId
        ? await remoteClient.readPane(target.machineId, target.paneId, {
            source: "recent_unwrapped",
            format: "ansi",
            lines: 80,
            revision: target.revision,
          })
        : await client.readPane(target.paneId, {
            source: "recent_unwrapped",
            format: "ansi",
            stripAnsi: false,
            lines: 80,
          });
      if (exiting) return;

      previewCache.set(target.itemKey, readRes.text);
      snippetsByKey.set(target.itemKey, readRes.text);
      lastFetchedRevision.set(target.itemKey, readRes.revision || target.revision);

      // Strict generation & selection guard: never let a stale response overwrite a newer selection
      const currentSel = getSelectedItem();
      if (seq !== previewRequestSeq || currentSel?.itemKey !== target.itemKey) {
        return;
      }

      const previewChanged = previewText !== readRes.text;
      previewText = readRes.text;

      rebuildItemsFromSnapshot();
      if (previewChanged) {
        scheduleRender();
      }
    } catch {
      // Ignore transient read error if pane closed or remote machine disconnected
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
    const targetSnapshot = { ...sel };

    // Immediately show cached preview for this pane so rapid j/k navigation never flashes blank or old pane
    const cached = previewCache.get(targetSnapshot.itemKey);
    if (cached !== undefined) {
      previewText = cached;
    } else {
      previewText = "";
    }

    if (debounceMs <= 0) {
      void fetchPreviewForItem(targetSnapshot, seq);
      return;
    }

    previewDebounceTimer = setTimeout(() => {
      previewDebounceTimer = null;
      if (exiting || seq !== previewRequestSeq) return;
      void fetchPreviewForItem(targetSnapshot, seq);
    }, debounceMs);
  };

  const refreshSnippetsForPriorityAgents = async (
    snap: SessionSnapshot,
    machineId: string | null = null,
  ) => {
    const candidates = snap.agents.filter(
      (a) =>
        (machineId !== null || a.pane_id !== selfPaneId) &&
        (a.agent_status === "blocked" || a.agent_status === "done" || a.agent_status === "working"),
    );

    const limit = machineId ? 6 : 12;
    await Promise.all(
      candidates.slice(0, limit).map(async (agent) => {
        const key = makeAgentTimerKey(agent.pane_id, machineId);
        const prevRev = lastFetchedRevision.get(key);
        if (prevRev !== undefined && prevRev === agent.revision && snippetsByKey.has(key)) {
          return;
        }
        try {
          const res = machineId
            ? await remoteClient.readPane(machineId, agent.pane_id, {
                source: "detection",
                format: "text",
                revision: agent.revision,
              })
            : await client.readPane(agent.pane_id, {
                source: "detection",
                format: "text",
                stripAnsi: true,
              });
          snippetsByKey.set(key, res.text);
          lastFetchedRevision.set(key, res.revision || agent.revision);
        } catch {
          // ignore
        }
      }),
    );
  };

  const refreshRemoteSnapshots = async (forceMachineList = false) => {
    if (remoteRefreshInFlight || exiting) return;
    remoteRefreshInFlight = true;
    const nowMs = Date.now();
    lastRemoteSnapshotFetchMs = nowMs;

    try {
      if (forceMachineList || nowMs - lastMachineListFetchMs >= REMOTE_MACHINE_LIST_TTL_MS) {
        remoteMachines = await remoteClient.listEnabledMachines();
        lastMachineListFetchMs = Date.now();
        const activeIds = new Set(remoteMachines.map((m) => m.id));
        for (const cachedId of [...remoteSnapshots.keys()]) {
          if (!activeIds.has(cachedId)) {
            remoteSnapshots.delete(cachedId);
          }
        }
      }

      if (remoteMachines.length === 0 || exiting) {
        return;
      }

      let stateDirty = false;
      await Promise.all(
        remoteMachines.map(async (machine) => {
          try {
            const rSnap = await remoteClient.getSnapshot(machine.id);
            if (exiting) return;
            remoteSnapshots.set(machine.id, rSnap);
            if (reconcileTimersWithSnapshot(persisted, rSnap, Date.now(), machine.id)) {
              stateDirty = true;
            }
            await refreshSnippetsForPriorityAgents(rSnap, machine.id);
          } catch {
            // Machine might be temporarily unreachable; keep last known snapshot or skip silently
          }
        }),
      );

      if (exiting) return;
      if (stateDirty) {
        saveDeckState(persisted);
      }

      const prevSelectedKey = selectedItemKey;
      rebuildItemsFromSnapshot();
      const vis = getCurrentVisible();
      if (!selectedItemKey || !vis.some((x) => x.itemKey === selectedItemKey)) {
        selectedItemKey = vis[0]?.itemKey ?? null;
      }

      const sel = getSelectedItem();
      if (sel && sel.itemKey !== prevSelectedKey) {
        requestSelectedPreview(0);
      }
      scheduleRender();
    } finally {
      remoteRefreshInFlight = false;
    }
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

      await refreshSnippetsForPriorityAgents(snap, null);

      rebuildItemsFromSnapshot();

      const vis = getCurrentVisible();
      if (!preserveSelection || !selectedItemKey || !vis.some((x) => x.itemKey === selectedItemKey)) {
        selectedItemKey = vis[0]?.itemKey ?? null;
      }

      const sel = getSelectedItem();
      if (sel && previewCache.has(sel.itemKey)) {
        previewText = previewCache.get(sel.itemKey)!;
      }

      scheduleRender();
      requestSelectedPreview(0);
      triggerGitRefresh(false);
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

  const getLocalAgentPaneIds = (): string[] =>
    items.filter((x) => !x.machineId).map((x) => x.paneId);

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
          startSubscriptions(getLocalAgentPaneIds());
        });
      },
      onClose: () => {
        if (!exiting) {
          setTimeout(() => {
            if (!exiting) {
              startSubscriptions(getLocalAgentPaneIds());
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

  const selectItemByKey = (nextItemKey: string) => {
    if (selectedItemKey === nextItemKey) return;
    selectedItemKey = nextItemKey;
    const cached = previewCache.get(nextItemKey);
    previewText = cached ?? "";
    scheduleRender();
    const target = items.find((x) => x.itemKey === nextItemKey);
    requestSelectedPreview(target?.machineId ? 140 : 55);
  };

  const moveSelection = (delta: number) => {
    const vis = getCurrentVisible();
    if (vis.length === 0) return;
    const idx = vis.findIndex((x) => x.itemKey === selectedItemKey);
    const cur = idx === -1 ? 0 : idx;
    const nextIdx = (cur + delta + vis.length) % vis.length;
    selectItemByKey(vis[nextIdx]!.itemKey);
  };

  const advanceToNextAttentionItem = (previousItemKey: string) => {
    const vis = getCurrentVisible();
    const nextUrgent = vis.find(
      (x) =>
        x.itemKey !== previousItemKey &&
        (x.group === "needs_you" || x.group === "review"),
    );
    if (nextUrgent) {
      selectItemByKey(nextUrgent.itemKey);
    }
  };

  const diveIntoSelectedAgent = async () => {
    const sel = getSelectedItem();
    if (!sel || exiting) return;

    // Remote machines cannot be switched to directly by local Herdr client API;
    // keep the popup open and show an inline toast so Enter gives clear feedback instead of silent no-op.
    if (sel.machineId) {
      setToast(
        `暂不支持直接跳转到远端 @${sel.machineLabel ?? sel.machineId}，请原地按 [r] 回复或 [y/n/1-4] 审批`,
        "warn",
        2800,
      );
      return;
    }

    markAgentSeenInDeck(
      persisted,
      {
        pane_id: sel.paneId,
        agent_status: sel.rawStatus,
        completion_seq: sel.completionSeq,
        revision: sel.revision,
      },
      Date.now(),
      null,
    );
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
    const machineTag = sel.machineLabel ? `@${sel.machineLabel} ` : "";
    try {
      if (sel.machineId) {
        await remoteClient.sendAgentKeys(sel.machineId, sel.paneId, [herdrKey]);
      } else {
        await client.sendAgentKeys(sel.paneId, [herdrKey]);
      }
      setToast(`已发送 [${label ?? herdrKey}] → ${machineTag}${sel.primaryTitle}`, "ok", 2000);
      setTimeout(() => {
        requestSelectedPreview(0);
        const refreshPromise = sel.machineId
          ? refreshRemoteSnapshots(false)
          : refreshSnapshot(true);
        void refreshPromise.then(() => {
          if (wasUrgent && focusMode === "list") {
            const updated = items.find((x) => x.itemKey === sel.itemKey);
            if (updated && updated.group !== "needs_you") {
              advanceToNextAttentionItem(sel.itemKey);
            }
          }
        });
      }, sel.machineId ? 300 : 140);
    } catch (err) {
      try {
        if (sel.machineId) {
          await remoteClient.sendPaneKeys(sel.machineId, sel.paneId, [herdrKey]);
        } else {
          await client.sendPaneKeys(sel.paneId, [herdrKey]);
        }
        setToast(`已发送 [${label ?? herdrKey}] → ${machineTag}${sel.primaryTitle}`, "ok", 2000);
        setTimeout(() => requestSelectedPreview(0), sel.machineId ? 300 : 140);
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

    const machineTag = sel.machineLabel ? `@${sel.machineLabel} ` : "";
    try {
      if (sel.machineId) {
        await remoteClient.sendAgentPrompt(sel.machineId, sel.paneId, text);
      } else {
        await client.sendAgentPrompt(sel.paneId, text);
      }
      replyDraft = "";
      replyCursor = 0;
      focusMode = "list";
      markAgentSeenInDeck(
        persisted,
        {
          pane_id: sel.paneId,
          agent_status: sel.rawStatus,
          completion_seq: sel.completionSeq,
          revision: sel.revision,
        },
        Date.now(),
        sel.machineId,
      );
      saveDeckState(persisted);
      setToast(`已发送回复 → ${machineTag}${sel.primaryTitle}`, "ok");
      setTimeout(() => {
        if (sel.machineId) {
          void refreshRemoteSnapshots(false);
        } else {
          void refreshSnapshot(true);
        }
      }, sel.machineId ? 350 : 180);
    } catch (err) {
      if (
        (err instanceof HerdrRpcError || err instanceof HerdrCliError) &&
        err.code === "agent_blocked"
      ) {
        setToast(
          "该 Agent 正卡在审批弹窗，请先用 [y/n/1-4] 审批或按 [Enter] 处理",
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

  const submitPaneRename = async () => {
    const sel = getSelectedItem();
    const target = renameTargetItem ?? (sel ? { itemKey: sel.itemKey, paneId: sel.paneId, machineId: sel.machineId ?? null } : null);
    const nextLabel = renameDraft.trim() || null;
    focusMode = "list";
    renameTargetItem = null;

    if (!target) {
      scheduleRender();
      return;
    }

    try {
      if (target.machineId) {
        await remoteClient.renamePane(target.machineId, target.paneId, nextLabel);
        const rSnap = remoteSnapshots.get(target.machineId);
        const targetPane = rSnap?.panes.find((p) => p.pane_id === target.paneId);
        if (targetPane) {
          targetPane.label = nextLabel;
        }
        rebuildItemsFromSnapshot();
      } else {
        await client.renamePane(target.paneId, nextLabel);
        // Optimistically update local snapshot so card title and color refresh immediately
        if (snapshot) {
          const targetPane = snapshot.panes.find((p) => p.pane_id === target.paneId);
          if (targetPane) {
            targetPane.label = nextLabel;
          }
          rebuildItemsFromSnapshot();
        }
      }
      setToast(
        nextLabel ? `已重命名为「${nextLabel}」` : "已清除自定义 Pane 名称",
        "ok",
        2200,
      );
      if (target.machineId) {
        void refreshRemoteSnapshots(false);
      } else {
        void refreshSnapshot(true);
      }
    } catch (err) {
      setToast(
        `重命名失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  const markSelectedReviewed = () => {
    const sel = getSelectedItem();
    if (!sel) return;
    markAgentSeenInDeck(
      persisted,
      {
        pane_id: sel.paneId,
        agent_status: sel.rawStatus,
        completion_seq: sel.completionSeq,
        revision: sel.revision,
      },
      Date.now(),
      sel.machineId,
    );
    saveDeckState(persisted);
    rebuildItemsFromSnapshot();
    setToast(`已将 ${sel.primaryTitle} 标记为已审阅`, "ok", 1800);
    advanceToNextAttentionItem(sel.itemKey);
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
        triggerGitRefresh(true);
        void refreshRemoteSnapshots(true);
        setToast("已刷新全部本地及远端 Agent 状态", "info", 1400);
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
            selectItemByKey(vis[0].itemKey);
          }
          return;
        }
        case "G": {
          const vis = getCurrentVisible();
          if (vis.length > 0) {
            selectItemByKey(vis[vis.length - 1]!.itemKey);
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
        case "R": {
          const sel = getSelectedItem();
          if (sel) {
            focusMode = "rename";
            renameTargetItem = {
              itemKey: sel.itemKey,
              paneId: sel.paneId,
              machineId: sel.machineId ?? null,
            };
            renameDraft = sel.paneLabel ?? "";
            renameCursor = Array.from(renameDraft).length;
            scheduleRender();
          }
          return;
        }
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
            if (!vis.some((x) => x.itemKey === selectedItemKey)) {
              selectedItemKey = vis[0]?.itemKey ?? null;
              requestSelectedPreview(0);
            }
          }
          scheduleRender();
          return;
        case "z":
          showIdle = !showIdle;
          {
            const vis = getCurrentVisible();
            if (!vis.some((x) => x.itemKey === selectedItemKey)) {
              selectedItemKey = vis[0]?.itemKey ?? null;
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
              selectItemByKey(vis[idx].itemKey);
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

  const applyLineEditKey = (
    draft: string,
    cursor: number,
    key: ParsedKey,
  ): { draft: string; cursor: number; changed: boolean } => {
    const chars = Array.from(draft);
    const pos = Math.max(0, Math.min(chars.length, cursor));

    if (key.kind === "special") {
      switch (key.name) {
        case "left":
          return { draft, cursor: Math.max(0, pos - 1), changed: true };
        case "right":
          return { draft, cursor: Math.min(chars.length, pos + 1), changed: true };
        case "home":
          return { draft, cursor: 0, changed: true };
        case "end":
          return { draft, cursor: chars.length, changed: true };
        case "backspace":
          if (pos > 0) {
            chars.splice(pos - 1, 1);
            return { draft: chars.join(""), cursor: pos - 1, changed: true };
          }
          return { draft, cursor: pos, changed: false };
        case "delete":
          if (pos < chars.length) {
            chars.splice(pos, 1);
            return { draft: chars.join(""), cursor: pos, changed: true };
          }
          return { draft, cursor: pos, changed: false };
        case "space":
          chars.splice(pos, 0, " ");
          return { draft: chars.join(""), cursor: pos + 1, changed: true };
        default:
          return { draft, cursor: pos, changed: false };
      }
    }

    if (key.kind === "ctrl") {
      if (key.key === "a") return { draft, cursor: 0, changed: true };
      if (key.key === "e") return { draft, cursor: chars.length, changed: true };
      if (key.key === "u") {
        return { draft: chars.slice(pos).join(""), cursor: 0, changed: true };
      }
      if (key.key === "w") {
        const before = chars.slice(0, pos).join("");
        const after = chars.slice(pos).join("");
        const trimmedBefore = before.replace(/\S+\s*$/, "");
        return {
          draft: trimmedBefore + after,
          cursor: Array.from(trimmedBefore).length,
          changed: true,
        };
      }
      return { draft, cursor: pos, changed: false };
    }

    if (key.kind === "char") {
      chars.splice(pos, 0, key.value);
      return { draft: chars.join(""), cursor: pos + 1, changed: true };
    }

    return { draft, cursor: pos, changed: false };
  };

  const handleReplyModeKey = async (key: ParsedKey) => {
    if (
      (key.kind === "special" && key.name === "esc") ||
      (key.kind === "ctrl" && key.key === "c")
    ) {
      focusMode = "list";
      scheduleRender();
      return;
    }
    if (key.kind === "special" && key.name === "enter") {
      await submitInlineReply();
      return;
    }

    const next = applyLineEditKey(replyDraft, replyCursor, key);
    if (next.changed) {
      replyDraft = next.draft;
      replyCursor = next.cursor;
      scheduleRender();
    }
  };

  const handleRenameModeKey = async (key: ParsedKey) => {
    if (
      (key.kind === "special" && key.name === "esc") ||
      (key.kind === "ctrl" && key.key === "c")
    ) {
      focusMode = "list";
      renameTargetItem = null;
      scheduleRender();
      return;
    }
    if (key.kind === "special" && key.name === "enter") {
      await submitPaneRename();
      return;
    }

    const next = applyLineEditKey(renameDraft, renameCursor, key);
    if (next.changed) {
      renameDraft = next.draft;
      renameCursor = next.cursor;
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
          } else if (focusMode === "rename") {
            await handleRenameModeKey(k);
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

  // Initial load & live subscription (local renders immediately; remote machines load asynchronously)
  await refreshSnapshot(false);
  const initialLocalPaneIds = getLocalAgentPaneIds();
  startSubscriptions(initialLocalPaneIds);
  void refreshRemoteSnapshots(true);

  let knownSubSet = initialLocalPaneIds.join(",");

  // Heartbeat for live timers, local/remote preview polling, and remote machine snapshots
  previewRefreshTimer = setInterval(() => {
    if (exiting) return;

    const localPaneIds = getLocalAgentPaneIds();
    const currentSet = localPaneIds.join(",");
    if (currentSet !== knownSubSet) {
      knownSubSet = currentSet;
      startSubscriptions(localPaneIds);
    }

    const nowMs = Date.now();
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
      if (sel.machineId) {
        if (nowMs - lastRemotePreviewPollMs >= REMOTE_PREVIEW_POLL_INTERVAL_MS) {
          lastRemotePreviewPollMs = nowMs;
          requestSelectedPreview(0);
        } else if (hasActiveTimers) {
          scheduleRender();
        }
      } else {
        requestSelectedPreview(0);
      }
    } else if (hasActiveTimers && !showHelp) {
      scheduleRender();
    }

    triggerGitRefresh(false);
    if (nowMs - lastRemoteSnapshotFetchMs >= REMOTE_SNAPSHOT_INTERVAL_MS) {
      void refreshRemoteSnapshots(false);
    }
  }, 900);
}
