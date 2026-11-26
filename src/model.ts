import type {
  AgentInfo,
  AgentStatus,
  AttentionGroup,
  DeckAgentItem,
  GitRepoInfo,
  PaneInfo,
  PersistedDeckState,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "./types.ts";

const GROUP_PRIORITY: Record<AttentionGroup, number> = {
  needs_you: 0,
  review: 1,
  working: 2,
  idle: 3,
};

export function classifyAttentionGroup(effectiveStatus: AgentStatus): AttentionGroup {
  switch (effectiveStatus) {
    case "blocked":
      return "needs_you";
    case "done":
      return "review";
    case "working":
      return "working";
    case "idle":
    case "unknown":
    default:
      return "idle";
  }
}

export function computeEffectiveStatus(
  agent: AgentInfo,
  state: PersistedDeckState,
): AgentStatus {
  const raw = agent.agent_status;
  if (raw !== "done") {
    return raw;
  }
  const timer = state.timers[agent.pane_id];
  if (!timer) {
    return "done";
  }
  if (
    typeof agent.completion_seq === "number" &&
    typeof timer.seenCompletionSeq === "number" &&
    timer.seenCompletionSeq >= agent.completion_seq
  ) {
    return "idle";
  }
  if (
    agent.completion_seq == null &&
    typeof timer.seenRevision === "number" &&
    timer.seenRevision >= agent.revision
  ) {
    return "idle";
  }
  return "done";
}

export function extractAgentSummary(
  agent: AgentInfo,
  pane: PaneInfo | undefined,
  detectionSnippet?: string,
): string {
  const tokens = { ...(pane?.tokens ?? {}), ...(agent.tokens ?? {}) };
  if (tokens.summary?.trim()) {
    return cleanSingleLine(tokens.summary);
  }

  const statusLabel =
    agent.state_labels?.[agent.agent_status] ??
    pane?.state_labels?.[agent.agent_status];
  if (statusLabel?.trim()) {
    return cleanSingleLine(statusLabel);
  }

  if (detectionSnippet) {
    const fromScreen = summarizeScreenLines(detectionSnippet, agent.agent_status);
    if (fromScreen) {
      return fromScreen;
    }
  }

  const strippedTitle = agent.terminal_title_stripped ?? pane?.terminal_title_stripped;
  if (strippedTitle?.trim() && !isGenericShellTitle(strippedTitle, agent)) {
    return cleanSingleLine(strippedTitle);
  }

  const metaTitle = agent.title ?? pane?.title;
  if (metaTitle?.trim() && !isGenericShellTitle(metaTitle, agent)) {
    return cleanSingleLine(metaTitle);
  }

  switch (agent.agent_status) {
    case "blocked":
      return "Waiting for approval or input";
    case "done":
      return "Turn finished — ready for review";
    case "working":
      return "Working on task...";
    case "unknown":
      return "Agent active (status unknown)";
    case "idle":
    default:
      return "Idle at prompt";
  }
}

function isGenericShellTitle(title: string, agent: AgentInfo): boolean {
  const lower = title.trim().toLowerCase();
  if (!lower) return true;
  const kind = (agent.agent ?? "").toLowerCase();
  if (
    lower === kind ||
    lower === "claude" ||
    lower === "claude code" ||
    lower === "codex" ||
    lower === "agy" ||
    lower === "zsh" ||
    lower === "bash"
  ) {
    return true;
  }
  // Ignore raw CLI invocation strings like `agy --dangerously-skip-permissions -c` or `claude --resume ...`
  if (/^(agy|claude|codex|gemini|opencode|pi|droid|cursor|kimi|qwen)(\s+-|\s+--)/.test(lower)) {
    return true;
  }
  return false;
}

export function summarizeScreenLines(rawText: string, status: AgentStatus): string | null {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0 && !isPureBoxBorder(line));

  if (lines.length === 0) return null;

  const tail = lines.slice(-16);

  if (status === "blocked") {
    // Prefer question / permission / command lines near the bottom
    for (let i = tail.length - 1; i >= 0; i--) {
      const candidate = cleanBoxSides(tail[i]!);
      if (!candidate) continue;
      if (isOptionNoise(candidate)) continue;
      if (
        /\?|allow|approve|permission|confirm|run|execute|bash|command|select|choose/i.test(candidate)
      ) {
        return cleanSingleLine(candidate);
      }
    }
  }

  // Otherwise pick the last meaningful non-prompt, non-ruler line
  for (let i = tail.length - 1; i >= 0; i--) {
    const candidate = cleanBoxSides(tail[i]!);
    if (!candidate) continue;
    if (isPromptChrome(candidate)) continue;
    return cleanSingleLine(candidate);
  }

  return null;
}

function isPureBoxBorder(line: string): boolean {
  return /^[╭╮╰╯┌┐└┘├┤┬┴┼─━═│┃▀▄█░▒▓\s·•-]+$/.test(line);
}

function cleanBoxSides(line: string): string {
  return line
    .replace(/^[│┃╭╰┌└├❯>•*+-]+\s*/, "")
    .replace(/\s*[│┃╮╯┐┘┤]+$/, "")
    .trim();
}

function isOptionNoise(line: string): boolean {
  return /^(1\.|2\.|3\.|\[y\/n\]|yes$|no$|esc to cancel|enter to confirm)/i.test(line);
}

function isPromptChrome(line: string): boolean {
  if (line.length <= 2) return true;
  if (/^(❯|>|\$|%\s*)$/.test(line)) return true;
  if (
    /^(tip:|esc to interrupt|esc to cancel|ctrl\+[a-z] to|shift\+tab|\? for shortcuts|context left|press shift\+tab|type your message)/i.test(
      line,
    )
  ) {
    return true;
  }
  // Agent CLI model/mode footer lines (e.g. "esc to cancel Gemini 4 Carbon · high", "Claude Opus · auto")
  if (
    /\b(gemini|claude|codex|gpt-\d|o[134]-|sonnet|opus|haiku)\b.*\b(high|medium|low|auto|fast|default|thinking)\b/i.test(
      line,
    )
  ) {
    return true;
  }
  // Starship / Powerlevel10k prompt lines with git/node versions and clock
  if (/[]|v\d+\.\d+\.\d+\s*$/.test(line) && line.includes("…/")) {
    return true;
  }
  return false;
}

export function resolvePrimaryTitle(
  agent: Pick<AgentInfo, "name" | "display_agent" | "agent">,
  pane: Pick<PaneInfo, "label"> | undefined,
  workspaceLabel: string,
  cwd?: string | null,
): string {
  const paneLabel = pane?.label?.trim();
  if (paneLabel && !/^\d+$/.test(paneLabel)) {
    return paneLabel;
  }

  const agentName = agent.name?.trim();
  if (agentName) {
    return agentName;
  }

  const baseDir = extractDirBasename(cwd);
  if (baseDir && baseDir !== workspaceLabel && !isGenericDirName(baseDir)) {
    return baseDir;
  }

  return workspaceLabel;
}

function extractDirBasename(cwd?: string | null): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return null;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function isGenericDirName(dir: string): boolean {
  const lower = dir.toLowerCase();
  return lower === "work" || lower === "personal" || lower === "workspace" || lower === "projects" || lower === "src";
}

function cleanSingleLine(input: string): string {
  return stripAnsi(input).replace(/\s+/g, " ").trim();
}

export function resolveAgentCwd(
  agent: Pick<AgentInfo, "foreground_cwd" | "cwd">,
  pane: Pick<PaneInfo, "foreground_cwd" | "cwd"> | undefined,
  workspace: Pick<WorkspaceInfo, "worktree"> | undefined,
): string | null {
  return (
    agent.foreground_cwd ??
    agent.cwd ??
    pane?.foreground_cwd ??
    pane?.cwd ??
    workspace?.worktree?.path ??
    null
  );
}

export function collectSnapshotGitCwds(
  snapshot: SessionSnapshot,
  excludePaneId?: string | null,
): string[] {
  const workspacesById = new Map<string, WorkspaceInfo>(
    snapshot.workspaces.map((w) => [w.workspace_id, w]),
  );
  const panesById = new Map<string, PaneInfo>(
    snapshot.panes.map((p) => [p.pane_id, p]),
  );

  const cwds = new Set<string>();
  for (const agent of snapshot.agents) {
    if (excludePaneId && agent.pane_id === excludePaneId) continue;
    const cwd = resolveAgentCwd(
      agent,
      panesById.get(agent.pane_id),
      workspacesById.get(agent.workspace_id),
    );
    if (cwd) {
      cwds.add(cwd);
    }
  }
  return [...cwds];
}

export function buildDeckAgentItems(
  snapshot: SessionSnapshot,
  state: PersistedDeckState,
  snippetsByPane: ReadonlyMap<string, string> = new Map(),
  excludePaneId?: string | null,
  nowMs = Date.now(),
  gitInfoByCwd?: ReadonlyMap<string, GitRepoInfo | null>,
): DeckAgentItem[] {
  const workspacesById = new Map<string, WorkspaceInfo>(
    snapshot.workspaces.map((w) => [w.workspace_id, w]),
  );
  const tabsById = new Map<string, TabInfo>(
    snapshot.tabs.map((t) => [t.tab_id, t]),
  );
  const panesById = new Map<string, PaneInfo>(
    snapshot.panes.map((p) => [p.pane_id, p]),
  );

  const items: DeckAgentItem[] = [];

  for (const agent of snapshot.agents) {
    if (excludePaneId && agent.pane_id === excludePaneId) {
      continue;
    }
    const ws = workspacesById.get(agent.workspace_id);
    const tab = tabsById.get(agent.tab_id);
    const pane = panesById.get(agent.pane_id);

    const effectiveStatus = computeEffectiveStatus(agent, state);
    const group = classifyAttentionGroup(effectiveStatus);
    const timer = state.timers[agent.pane_id];
    const sinceMs =
      effectiveStatus === "working"
        ? (timer?.workingStartedMs ?? timer?.sinceMs ?? nowMs)
        : (timer?.sinceMs ?? nowMs);

    const agentKind = agent.agent ?? pane?.agent ?? "agent";
    const agentDisplayName =
      agent.name ??
      agent.display_agent ??
      pane?.display_agent ??
      agentKind;

    const cwd = resolveAgentCwd(agent, pane, ws);
    const fallbackBranch = ws?.worktree?.branch ?? ws?.tokens?.branch ?? null;
    const hasProbed = Boolean(cwd && gitInfoByCwd?.has(cwd));
    const probedGit = hasProbed && cwd ? (gitInfoByCwd!.get(cwd) ?? null) : null;
    const gitInfo: GitRepoInfo | null =
      probedGit ??
      (!hasProbed && fallbackBranch
        ? { branch: fallbackBranch, dirtyFiles: 0, ahead: 0, behind: 0 }
        : null);
    const branch = gitInfo?.branch ?? null;
    const workspaceLabel = ws?.label ?? agent.workspace_id;
    const paneLabel = pane?.label?.trim() || null;
    const primaryTitle = resolvePrimaryTitle(agent, pane, workspaceLabel, cwd);

    items.push({
      paneId: agent.pane_id,
      workspaceId: agent.workspace_id,
      tabId: agent.tab_id,
      workspaceLabel,
      workspaceNumber: ws?.number ?? 999,
      tabLabel: tab?.label ?? agent.tab_id,
      paneLabel,
      primaryTitle,
      branch,
      gitInfo,
      cwd,
      agentKind,
      agentDisplayName,
      rawStatus: agent.agent_status,
      effectiveStatus,
      group,
      sinceMs,
      summary: extractAgentSummary(agent, pane, snippetsByPane.get(agent.pane_id)),
      completionSeq: agent.completion_seq ?? null,
      stateChangeSeq: agent.state_change_seq ?? 0,
      revision: agent.revision,
      focusedInHerdr: agent.focused,
    });
  }

  items.sort((a, b) => {
    const gp = GROUP_PRIORITY[a.group] - GROUP_PRIORITY[b.group];
    if (gp !== 0) return gp;

    if (a.group === "needs_you") {
      // Longest waiting blocked agent first (or highest stateChangeSeq fallback)
      if (a.sinceMs !== b.sinceMs) return a.sinceMs - b.sinceMs;
    } else if (a.group === "review") {
      // Most recently completed first
      if (b.stateChangeSeq !== a.stateChangeSeq) return b.stateChangeSeq - a.stateChangeSeq;
    } else if (a.group === "working") {
      // Longest running or most active
      if (a.sinceMs !== b.sinceMs) return a.sinceMs - b.sinceMs;
    }

    if (a.workspaceNumber !== b.workspaceNumber) {
      return a.workspaceNumber - b.workspaceNumber;
    }
    return a.paneId.localeCompare(b.paneId);
  });

  return items;
}

// Minimal ANSI stripper shared with model
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
