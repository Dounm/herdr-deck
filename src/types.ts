export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

export interface WorkspaceWorktreeInfo {
  branch?: string | null;
  path?: string | null;
  primary_workspace_id?: string | null;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  tokens?: Record<string, string>;
  worktree?: WorkspaceWorktreeInfo | null;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  revision: number;
  agent?: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionInfo | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  scroll?: PaneScrollInfo | null;
}

export interface AgentInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  revision: number;
  agent?: string | null;
  display_agent?: string | null;
  name?: string | null;
  agent_status: AgentStatus;
  completion_seq?: number | null;
  state_change_seq?: number;
  cwd?: string | null;
  foreground_cwd?: string | null;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  screen_detection_skipped?: boolean;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: "visible" | "recent" | "recent_unwrapped" | "detection";
  format: "text" | "ansi";
  text: string;
  revision: number;
  truncated: boolean;
}

export interface TimerEntry {
  status: AgentStatus;
  sinceMs: number;
  workingStartedMs?: number;
  seenCompletionSeq?: number;
  seenRevision?: number;
}

export interface PersistedDeckState {
  version: 1;
  timers: Record<string, TimerEntry>;
}

export type AttentionGroup = "needs_you" | "review" | "working" | "idle";

export interface MachineProfile {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
  selected: boolean;
}

export interface GitRepoInfo {
  branch: string;
  dirtyFiles: number;
  ahead: number;
  behind: number;
  detached?: boolean;
}

export interface DeckAgentItem {
  /** Globally unique key across local and remote machines: `paneId` for local, `${machineId}::${paneId}` for remote */
  itemKey: string;
  /** null/undefined for local machine; saved machine profile ID for remote machines */
  machineId?: string | null;
  /** null/undefined for local machine; display label (e.g. `soltokyo`) for remote machines */
  machineLabel?: string | null;
  paneId: string;
  workspaceId: string;
  tabId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabLabel: string;
  paneLabel?: string | null;
  primaryTitle: string;
  branch?: string | null;
  gitInfo?: GitRepoInfo | null;
  cwd?: string | null;
  agentKind: string;
  agentDisplayName: string;
  rawStatus: AgentStatus;
  effectiveStatus: AgentStatus;
  group: AttentionGroup;
  sinceMs: number;
  summary: string;
  completionSeq?: number | null;
  stateChangeSeq: number;
  revision: number;
  focusedInHerdr: boolean;
}
