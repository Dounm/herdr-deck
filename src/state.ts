import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentInfo, AgentStatus, PersistedDeckState, SessionSnapshot, TimerEntry } from "./types.ts";

const PLUGIN_ID = "karllooki.herdr-deck";

export function resolveStateDir(): string {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  return join(homedir(), ".config", "herdr", "plugins", "state", PLUGIN_ID);
}

export function resolveStateFilePath(stateDir = resolveStateDir()): string {
  return join(stateDir, "deck-state.json");
}

export function createEmptyState(): PersistedDeckState {
  return {
    version: 1,
    timers: {},
  };
}

export function loadDeckState(stateFile = resolveStateFilePath()): PersistedDeckState {
  try {
    if (!existsSync(stateFile)) {
      return createEmptyState();
    }
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedDeckState>;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyState();
    }
    return {
      version: 1,
      timers: parsed.timers && typeof parsed.timers === "object" ? parsed.timers : {},
    };
  } catch {
    return createEmptyState();
  }
}

export function saveDeckState(state: PersistedDeckState, stateFile = resolveStateFilePath()): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpFile, stateFile);
}

export function updateDeckState(
  mutator: (draft: PersistedDeckState) => void,
  stateFile = resolveStateFilePath(),
): PersistedDeckState {
  const state = loadDeckState(stateFile);
  mutator(state);
  saveDeckState(state, stateFile);
  return state;
}

export function recordAgentStatusTransition(
  state: PersistedDeckState,
  paneId: string,
  nextStatus: AgentStatus,
  nowMs = Date.now(),
): TimerEntry {
  const prev = state.timers[paneId];
  const normalizedPrev = prev ? normalizeLifecycleStatus(prev.status) : null;
  const normalizedNext = normalizeLifecycleStatus(nextStatus);

  if (prev && normalizedPrev === normalizedNext) {
    prev.status = nextStatus;
    return prev;
  }

  const nextEntry: TimerEntry = {
    status: nextStatus,
    sinceMs: nowMs,
    workingStartedMs:
      normalizedNext === "working"
        ? nowMs
        : prev?.workingStartedMs,
    seenCompletionSeq: prev?.seenCompletionSeq,
    seenRevision: prev?.seenRevision,
  };
  state.timers[paneId] = nextEntry;
  return nextEntry;
}

function normalizeLifecycleStatus(status: AgentStatus): "working" | "blocked" | "settled" | "unknown" {
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  if (status === "done" || status === "idle") return "settled";
  return "unknown";
}

export function reconcileTimersWithSnapshot(
  state: PersistedDeckState,
  snapshot: SessionSnapshot,
  nowMs = Date.now(),
): boolean {
  let dirty = false;
  const livePaneIds = new Set(snapshot.panes.map((p) => p.pane_id));

  for (const paneId of Object.keys(state.timers)) {
    if (!livePaneIds.has(paneId)) {
      delete state.timers[paneId];
      dirty = true;
    }
  }

  for (const agent of snapshot.agents) {
    const existing = state.timers[agent.pane_id];
    if (!existing) {
      recordAgentStatusTransition(state, agent.pane_id, agent.agent_status, nowMs);
      dirty = true;
      continue;
    }
    if (normalizeLifecycleStatus(existing.status) !== normalizeLifecycleStatus(agent.agent_status)) {
      recordAgentStatusTransition(state, agent.pane_id, agent.agent_status, nowMs);
      dirty = true;
    } else if (existing.status !== agent.agent_status) {
      existing.status = agent.agent_status;
      dirty = true;
    }
  }

  return dirty;
}

export function markAgentSeenInDeck(
  state: PersistedDeckState,
  agent: Pick<AgentInfo, "pane_id" | "agent_status" | "completion_seq" | "revision">,
  nowMs = Date.now(),
): void {
  const entry = state.timers[agent.pane_id] ?? {
    status: agent.agent_status,
    sinceMs: nowMs,
  };
  if (typeof agent.completion_seq === "number") {
    entry.seenCompletionSeq = agent.completion_seq;
  }
  entry.seenRevision = agent.revision;
  state.timers[agent.pane_id] = entry;
}

export function formatDurationCompact(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) {
    return `00:${String(totalSec).padStart(2, "0")}`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${String(remMins).padStart(2, "0")}m`;
}

export function formatRelativeAge(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 10) return "just now";
  if (totalSec < 60) return `${totalSec}s ago`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
