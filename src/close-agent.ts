import { HerdrCliError, matchesAgentNotFoundText } from "./remote-client.ts";
import { HerdrRpcError } from "./socket-client.ts";
import type { AgentInfo, AgentStatus, DeckAgentItem } from "./types.ts";

export const CLOSE_AGENT_KEY = "ctrl+d";

export function canCloseIdleAgent(item: Pick<DeckAgentItem, "group" | "rawStatus">): boolean {
  return (
    (item.group === "idle" || item.group === "sleeping") &&
    item.rawStatus !== "working" &&
    item.rawStatus !== "blocked"
  );
}

export function getCloseAgentBlockedMessage(item: Pick<DeckAgentItem, "group" | "rawStatus">): string {
  if (item.group === "working" || item.rawStatus === "working") {
    return "运行中的 Agent 不可一键关闭";
  }
  if (item.group === "needs_you" || item.rawStatus === "blocked") {
    return "阻塞待审批的 Agent 不可一键关闭";
  }
  if (item.group === "review") {
    return "待审阅的 Agent 请先按 [m] 标为已阅后再按 [X] 关闭";
  }
  return "仅空闲或休眠中的 Agent 支持 [X] 一键关闭";
}

export function resolveSelectionAfterRemoval(
  prevVisibleKeys: readonly string[],
  removedKey: string,
  nextVisibleKeys: readonly string[],
): string | null {
  if (nextVisibleKeys.length === 0) {
    return null;
  }
  if (nextVisibleKeys.includes(removedKey)) {
    return removedKey;
  }
  const prevIdx = prevVisibleKeys.indexOf(removedKey);
  if (prevIdx !== -1) {
    return nextVisibleKeys[Math.min(prevIdx, nextVisibleKeys.length - 1)]!;
  }
  return nextVisibleKeys[0]!;
}

function extractErrorDetails(err: unknown): { code: string | null; message: string } {
  if (err instanceof HerdrRpcError || err instanceof HerdrCliError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    const rawCode = (err as { code?: unknown }).code;
    return {
      code: typeof rawCode === "string" ? rawCode : null,
      message: err.message,
    };
  }
  if (err && typeof err === "object") {
    const obj = err as { code?: unknown; message?: unknown };
    return {
      code: typeof obj.code === "string" ? obj.code : null,
      message: typeof obj.message === "string" ? obj.message : String(err),
    };
  }
  return { code: null, message: typeof err === "string" ? err : String(err) };
}

export function isAgentNotFoundError(err: unknown): boolean {
  const { code, message } = extractErrorDetails(err);
  if (code === "agent_not_found" || code === "pane_not_found" || code === "not_found") {
    return true;
  }
  return matchesAgentNotFoundText(message);
}

export type LiveAgentPrecheckInfo = Pick<AgentInfo, "agent_status" | "completion_seq"> & {
  revision?: number;
};

export interface CloseIdleAgentDeps {
  closingKeys: Set<string>;
  getAgent: (item: DeckAgentItem) => Promise<LiveAgentPrecheckInfo>;
  sendAgentKeys: (item: DeckAgentItem, keys: string[]) => Promise<void>;
  onSent?: (item: DeckAgentItem) => void;
}

export type CloseIdleAgentResult =
  | { outcome: "blocked_by_state"; message: string }
  | { outcome: "in_flight" }
  | { outcome: "already_exited" }
  | { outcome: "status_changed"; liveStatus: AgentStatus }
  | { outcome: "sent" }
  | { outcome: "error"; message: string };

export async function closeIdleAgent(
  item: DeckAgentItem,
  deps: CloseIdleAgentDeps,
): Promise<CloseIdleAgentResult> {
  if (!canCloseIdleAgent(item)) {
    return {
      outcome: "blocked_by_state",
      message: getCloseAgentBlockedMessage(item),
    };
  }

  if (deps.closingKeys.has(item.itemKey)) {
    return { outcome: "in_flight" };
  }

  deps.closingKeys.add(item.itemKey);
  try {
    let live: LiveAgentPrecheckInfo;
    try {
      live = await deps.getAgent(item);
    } catch (err) {
      if (isAgentNotFoundError(err)) {
        return { outcome: "already_exited" };
      }
      return {
        outcome: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (live.agent_status === "working" || live.agent_status === "blocked") {
      return {
        outcome: "status_changed",
        liveStatus: live.agent_status,
      };
    }

    if (
      live.agent_status !== "idle" &&
      live.agent_status !== "unknown" &&
      live.agent_status !== "done"
    ) {
      return {
        outcome: "error",
        message: `未识别的实时状态: ${String(live.agent_status ?? "unknown")}`,
      };
    }

    if (live.agent_status === "done") {
      const becameDoneFromNonDone = item.rawStatus !== "done";
      const hasNewCompletionSeq =
        typeof live.completion_seq === "number" &&
        (item.completionSeq == null || live.completion_seq > item.completionSeq);
      const unseqDoneChanged =
        live.completion_seq == null &&
        (item.completionSeq != null ||
          (typeof live.revision === "number" && live.revision > item.revision));

      if (becameDoneFromNonDone || hasNewCompletionSeq || unseqDoneChanged) {
        return {
          outcome: "status_changed",
          liveStatus: "done",
        };
      }
    }

    try {
      await deps.sendAgentKeys(item, [CLOSE_AGENT_KEY]);
      deps.onSent?.(item);
      return { outcome: "sent" };
    } catch (err) {
      if (isAgentNotFoundError(err)) {
        return { outcome: "already_exited" };
      }
      return {
        outcome: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  } finally {
    deps.closingKeys.delete(item.itemKey);
  }
}
