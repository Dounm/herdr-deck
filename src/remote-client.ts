import { execFile } from "node:child_process";
import type { AgentInfo, MachineProfile, PaneReadResult, SessionSnapshot } from "./types.ts";

const DEFAULT_CLI_TIMEOUT_MS = 6000;
const LIST_MACHINES_TIMEOUT_MS = 3000;

export function resolveHerdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export class HerdrCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrCliError";
    this.code = code;
  }
}

const EXCLUDED_AGENT_NOT_FOUND_RE =
  /\bcommand\s+not\s+found\b|\bssh[- ]?agent\b|\bauthentication\s+agent\b|\bmachine\b[^\n]*\bnot\s+found\b|\bsocket\b[^\n]*\bnot\s+found\b|:\s*not\s+found\b/i;

const POSITIVE_AGENT_NOT_FOUND_RE =
  /\bno\s+(?:active\s+)?agent\b|\bagent\s+target\s+\S+\s+not\s+found\b|(?:^|[\s:(\["'])(?:agent|pane)(?:\s+\S+)?\s+(?:not\s+found|does\s+not\s+exist|has\s+exited|already\s+exited)\b/i;

export function matchesAgentNotFoundText(text: string): boolean {
  if (!text) return false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\b(?:agent_not_found|pane_not_found)\b/i.test(line)) {
      return true;
    }
    if (EXCLUDED_AGENT_NOT_FOUND_RE.test(line)) {
      continue;
    }
    if (POSITIVE_AGENT_NOT_FOUND_RE.test(line)) {
      return true;
    }
  }
  return false;
}

function tryExtractCliJsonErrorCode(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line) as { error?: { code?: unknown } } | null;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.error &&
        typeof parsed.error === "object" &&
        !Array.isArray(parsed.error) &&
        typeof parsed.error.code === "string" &&
        parsed.error.code
      ) {
        return parsed.error.code;
      }
    } catch {
      // ignore non-JSON line
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { code?: unknown } } | null;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.error &&
        typeof parsed.error === "object" &&
        !Array.isArray(parsed.error) &&
        typeof parsed.error.code === "string" &&
        parsed.error.code
      ) {
        return parsed.error.code;
      }
    } catch {
      // ignore non-JSON output
    }
  }
  return null;
}

export function classifyHerdrCliErrorCode(detail: string, stdout = "", stderr = ""): string {
  if (/agent_blocked/i.test(detail)) {
    return "agent_blocked";
  }
  const structuredCode =
    tryExtractCliJsonErrorCode(stdout) ??
    tryExtractCliJsonErrorCode(stderr) ??
    tryExtractCliJsonErrorCode(detail);
  if (structuredCode) {
    return structuredCode;
  }
  if (/pane_not_found/i.test(detail)) {
    return "pane_not_found";
  }
  if (matchesAgentNotFoundText(detail)) {
    return "agent_not_found";
  }
  return "cli_error";
}

function runHerdrCli(args: string[], timeoutMs = DEFAULT_CLI_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveHerdrBin(),
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const out = stdout.trim();
          const errOut = stderr.trim();
          const detail =
            errOut && out && errOut !== out
              ? `${errOut}\n${out}`
              : errOut || out || err.message;
          const code = classifyHerdrCliErrorCode(detail, out, errOut);
          reject(new HerdrCliError(code, detail));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function parseMachineListJson(stdout: string): MachineProfile[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) return [];

  const result: MachineProfile[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id) continue;
    const label =
      typeof obj.label === "string" && obj.label.trim()
        ? obj.label.trim()
        : typeof obj.target === "string" && obj.target.trim()
          ? obj.target.trim()
          : obj.id;
    result.push({
      id: obj.id,
      label,
      target: typeof obj.target === "string" ? obj.target : label,
      session: typeof obj.session === "string" ? obj.session : "default",
      enabled: obj.enabled !== false,
      selected: Boolean(obj.selected),
    });
  }
  return result;
}

export function parseSnapshotCliJson(stdout: string): SessionSnapshot {
  const parsed = JSON.parse(stdout) as {
    result?: { snapshot?: SessionSnapshot } & Partial<SessionSnapshot>;
    snapshot?: SessionSnapshot;
  } & Partial<SessionSnapshot>;

  const snap = parsed.result?.snapshot ?? parsed.snapshot ?? parsed.result ?? parsed;
  return {
    version: typeof snap.version === "string" ? snap.version : "0.0.0",
    protocol: typeof snap.protocol === "number" ? snap.protocol : 0,
    focused_workspace_id: snap.focused_workspace_id ?? null,
    focused_tab_id: snap.focused_tab_id ?? null,
    focused_pane_id: snap.focused_pane_id ?? null,
    workspaces: Array.isArray(snap.workspaces) ? snap.workspaces : [],
    tabs: Array.isArray(snap.tabs) ? snap.tabs : [],
    panes: Array.isArray(snap.panes) ? snap.panes : [],
    agents: Array.isArray(snap.agents) ? snap.agents : [],
  };
}

export function parseAgentGetCliJson(stdout: string): AgentInfo {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid agent.get CLI JSON output");
  }

  const obj = parsed as {
    error?: unknown;
    result?: unknown;
    agent?: unknown;
  } & Partial<AgentInfo>;

  if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
    const errObj = obj.error as { code?: unknown; message?: unknown };
    throw new HerdrCliError(
      typeof errObj.code === "string" && errObj.code ? errObj.code : "cli_error",
      typeof errObj.message === "string" && errObj.message
        ? errObj.message
        : "Herdr CLI error",
    );
  }

  const resultObj =
    obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)
      ? (obj.result as { agent?: unknown } & Partial<AgentInfo>)
      : undefined;
  const resultAgent =
    resultObj?.agent && typeof resultObj.agent === "object" && !Array.isArray(resultObj.agent)
      ? resultObj.agent
      : undefined;
  const topAgent =
    obj.agent && typeof obj.agent === "object" && !Array.isArray(obj.agent)
      ? obj.agent
      : undefined;
  const resultDirect =
    resultObj && "agent_status" in resultObj
      ? resultObj
      : undefined;
  const candidate = resultAgent ?? topAgent ?? resultDirect ?? obj;

  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    typeof (candidate as Partial<AgentInfo>).agent_status !== "string"
  ) {
    throw new Error("Invalid agent.get CLI JSON output");
  }

  return candidate as AgentInfo;
}

export class HerdrMachineCliClient {
  async listEnabledMachines(): Promise<MachineProfile[]> {
    try {
      const stdout = await runHerdrCli(["machine", "list", "--json"], LIST_MACHINES_TIMEOUT_MS);
      return parseMachineListJson(stdout).filter((m) => m.enabled);
    } catch {
      return [];
    }
  }

  async getSnapshot(machineId: string): Promise<SessionSnapshot> {
    const stdout = await runHerdrCli(["--machine", machineId, "api", "snapshot"], 7000);
    return parseSnapshotCliJson(stdout);
  }

  async readPane(
    machineId: string,
    paneId: string,
    options: {
      source?: "visible" | "recent" | "recent_unwrapped" | "detection";
      format?: "text" | "ansi";
      lines?: number;
      revision?: number;
    } = {},
  ): Promise<PaneReadResult> {
    const source = options.source ?? "recent_unwrapped";
    const cliSource = source === "recent_unwrapped" ? "recent-unwrapped" : source;
    const format = options.format ?? "ansi";

    const args = [
      "--machine",
      machineId,
      "pane",
      "read",
      paneId,
      "--source",
      cliSource,
      "--format",
      format,
    ];
    if (typeof options.lines === "number") {
      args.push("--lines", String(options.lines));
    }

    const text = await runHerdrCli(args, 7000);
    return {
      pane_id: paneId,
      workspace_id: "",
      tab_id: "",
      source,
      format,
      text,
      revision: options.revision ?? 0,
      truncated: false,
    };
  }

  async getAgent(machineId: string, target: string): Promise<AgentInfo> {
    const stdout = await runHerdrCli(["--machine", machineId, "agent", "get", target], 6000);
    return parseAgentGetCliJson(stdout);
  }

  async sendAgentKeys(machineId: string, target: string, keys: string[]): Promise<void> {
    await runHerdrCli(["--machine", machineId, "agent", "send-keys", target, ...keys], 6000);
  }

  async sendPaneKeys(machineId: string, paneId: string, keys: string[]): Promise<void> {
    await runHerdrCli(["--machine", machineId, "pane", "send-keys", paneId, ...keys], 6000);
  }

  async sendAgentPrompt(machineId: string, target: string, text: string): Promise<void> {
    await runHerdrCli(["--machine", machineId, "agent", "prompt", target, text], 8000);
  }

  async renamePane(machineId: string, paneId: string, label: string | null): Promise<void> {
    if (label && label.trim()) {
      await runHerdrCli(["--machine", machineId, "pane", "rename", paneId, label.trim()], 6000);
    } else {
      await runHerdrCli(["--machine", machineId, "pane", "rename", paneId, "--clear"], 6000);
    }
  }
}
