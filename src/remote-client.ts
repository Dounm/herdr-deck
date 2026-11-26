import { execFile } from "node:child_process";
import type { MachineProfile, PaneReadResult, SessionSnapshot } from "./types.ts";

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
          const detail = stderr.trim() || stdout.trim() || err.message;
          const code = /agent_blocked/i.test(detail) ? "agent_blocked" : "cli_error";
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
