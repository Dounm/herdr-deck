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
    if (nextStatus === "working") {
      delete prev.sleeping;
      delete prev.sleepingSinceMs;
      prev.wokeAtMs = nowMs;
    }
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
    lastStateChangeSeq: prev?.lastStateChangeSeq,
    lastCompletionSeq: prev?.lastCompletionSeq,
  };
  if (nextStatus === "working") {
    nextEntry.wokeAtMs = nowMs;
  } else {
    if (prev?.sleeping !== undefined) {
      nextEntry.sleeping = prev.sleeping;
    }
    if (prev?.sleepingSinceMs !== undefined) {
      nextEntry.sleepingSinceMs = prev.sleepingSinceMs;
    }
    if (prev?.wokeAtMs !== undefined) {
      nextEntry.wokeAtMs = prev.wokeAtMs;
    }
  }
  state.timers[paneId] = nextEntry;
  return nextEntry;
}

function normalizeLifecycleStatus(status: AgentStatus): "working" | "blocked" | "settled" | "unknown" {
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  if (status === "done" || status === "idle") return "settled";
  return "unknown";
}

export function makeAgentTimerKey(paneId: string, machineId?: string | null): string {
  return machineId ? `${machineId}::${paneId}` : paneId;
}

export function isRemoteTimerKey(key: string): boolean {
  return key.includes("::");
}

export function reconcileTimersWithSnapshot(
  state: PersistedDeckState,
  snapshot: SessionSnapshot,
  nowMs = Date.now(),
  machineId?: string | null,
): boolean {
  let dirty = false;
  const liveKeys = new Set(snapshot.panes.map((p) => makeAgentTimerKey(p.pane_id, machineId)));
  const prefix = machineId ? `${machineId}::` : null;

  for (const key of Object.keys(state.timers)) {
    const belongsToThisMachine = prefix ? key.startsWith(prefix) : !isRemoteTimerKey(key);
    if (belongsToThisMachine && !liveKeys.has(key)) {
      delete state.timers[key];
      dirty = true;
    }
  }

  for (const agent of snapshot.agents) {
    const key = makeAgentTimerKey(agent.pane_id, machineId);
    const existing = state.timers[key];
    if (!existing) {
      const entry = recordAgentStatusTransition(state, key, agent.agent_status, nowMs);
      if (typeof agent.state_change_seq === "number") {
        entry.lastStateChangeSeq = agent.state_change_seq;
      }
      if (typeof agent.completion_seq === "number") {
        entry.lastCompletionSeq = agent.completion_seq;
      }
      dirty = true;
      continue;
    }

    const completionAdvanced =
      typeof agent.completion_seq === "number" &&
      typeof existing.lastCompletionSeq === "number" &&
      agent.completion_seq > existing.lastCompletionSeq;
    const stateChangeAdvanced =
      typeof agent.state_change_seq === "number" &&
      typeof existing.lastStateChangeSeq === "number" &&
      agent.state_change_seq > existing.lastStateChangeSeq;

    let entry = existing;
    let statusTransitioned = false;
    if (normalizeLifecycleStatus(existing.status) !== normalizeLifecycleStatus(agent.agent_status)) {
      entry = recordAgentStatusTransition(state, key, agent.agent_status, nowMs);
      statusTransitioned = true;
      dirty = true;
    } else if (existing.status !== agent.agent_status) {
      existing.status = agent.agent_status;
      dirty = true;
    }

    if (agent.agent_status === "working") {
      if (
        entry.sleeping !== undefined ||
        entry.sleepingSinceMs !== undefined ||
        entry.wokeAtMs !== nowMs
      ) {
        delete entry.sleeping;
        delete entry.sleepingSinceMs;
        entry.wokeAtMs = nowMs;
        dirty = true;
      }
    }

    if (completionAdvanced || stateChangeAdvanced) {
      delete entry.sleeping;
      delete entry.sleepingSinceMs;
      entry.wokeAtMs = nowMs;
      if (!statusTransitioned && entry.sinceMs < nowMs) {
        entry.sinceMs = nowMs;
      }
      dirty = true;
    }

    if (
      typeof agent.state_change_seq === "number" &&
      entry.lastStateChangeSeq !== agent.state_change_seq
    ) {
      entry.lastStateChangeSeq = agent.state_change_seq;
      dirty = true;
    }
    if (
      typeof agent.completion_seq === "number" &&
      entry.lastCompletionSeq !== agent.completion_seq
    ) {
      entry.lastCompletionSeq = agent.completion_seq;
      dirty = true;
    }
  }

  return dirty;
}

export function setAgentSleepingInDeck(
  state: PersistedDeckState,
  agent: Pick<AgentInfo, "pane_id" | "agent_status" | "completion_seq" | "state_change_seq" | "revision">,
  nowMs = Date.now(),
  machineId?: string | null,
): TimerEntry {
  const key = makeAgentTimerKey(agent.pane_id, machineId);
  const entry = state.timers[key] ?? {
    status: agent.agent_status,
    sinceMs: nowMs,
  };
  entry.sleeping = true;
  entry.sleepingSinceMs = nowMs;
  if (agent.agent_status === "done") {
    if (typeof agent.completion_seq === "number") {
      entry.seenCompletionSeq = agent.completion_seq;
    }
    entry.seenRevision = agent.revision;
  }
  if (typeof agent.state_change_seq === "number") {
    entry.lastStateChangeSeq = agent.state_change_seq;
  }
  if (typeof agent.completion_seq === "number") {
    entry.lastCompletionSeq = agent.completion_seq;
  }
  state.timers[key] = entry;
  return entry;
}

export function wakeAgentInDeck(
  state: PersistedDeckState,
  paneId: string,
  nowMs = Date.now(),
  machineId?: string | null,
): TimerEntry {
  const key = makeAgentTimerKey(paneId, machineId);
  const entry = state.timers[key] ?? {
    status: "idle",
    sinceMs: nowMs,
  };
  delete entry.sleeping;
  delete entry.sleepingSinceMs;
  entry.wokeAtMs = nowMs;
  state.timers[key] = entry;
  return entry;
}

export function markAgentSeenInDeck(
  state: PersistedDeckState,
  agent: Pick<AgentInfo, "pane_id" | "agent_status" | "completion_seq" | "revision">,
  nowMs = Date.now(),
  machineId?: string | null,
): void {
  const key = makeAgentTimerKey(agent.pane_id, machineId);
  const entry = state.timers[key] ?? {
    status: agent.agent_status,
    sinceMs: nowMs,
  };
  if (typeof agent.completion_seq === "number") {
    entry.seenCompletionSeq = agent.completion_seq;
  }
  entry.seenRevision = agent.revision;
  state.timers[key] = entry;
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

export function formatCompactAge(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return "<1m";
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
