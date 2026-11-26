import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaneReadResult, SessionSnapshot } from "./types.ts";

export function resolveSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) {
    return process.env.HERDR_SOCKET_PATH;
  }
  const session = process.env.HERDR_SESSION;
  const configDir = process.env.HERDR_CONFIG_DIR ?? join(homedir(), ".config", "herdr");
  if (session) {
    return join(configDir, "sessions", session, "herdr.sock");
  }
  return join(configDir, "herdr.sock");
}

export class HerdrRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrRpcError";
    this.code = code;
  }
}

interface RawRpcResponse {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface IncomingHerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export class HerdrSocketClient {
  private readonly socketPath: string;
  private reqCounter = 0;

  constructor(socketPath = resolveSocketPath()) {
    this.socketPath = socketPath;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 4000,
  ): Promise<T> {
    const reqId = `deck_${process.pid}_${++this.reqCounter}`;
    const payload = JSON.stringify({ id: reqId, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const sock = createConnection(this.socketPath);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error(`Herdr socket request timed out: ${method}`));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.end();
        fn();
      };

      sock.setEncoding("utf8");

      sock.on("connect", () => {
        sock.write(payload);
      });

      sock.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) return;
        const line = buffer.slice(0, newlineIdx).trim();
        if (!line) return;
        try {
          const parsed = JSON.parse(line) as RawRpcResponse;
          if (parsed.error) {
            finish(() => reject(new HerdrRpcError(parsed.error!.code, parsed.error!.message)));
            return;
          }
          finish(() => resolve((parsed.result ?? {}) as T));
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      });

      sock.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      sock.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Herdr socket closed before replying to ${method}`));
      });
    });
  }

  async getSnapshot(): Promise<SessionSnapshot> {
    const res = await this.request<{ snapshot?: SessionSnapshot } & Partial<SessionSnapshot>>(
      "session.snapshot",
      {},
    );
    return (res.snapshot ?? res) as SessionSnapshot;
  }

  async readPane(
    paneId: string,
    options: {
      source?: "visible" | "recent" | "recent_unwrapped" | "detection";
      format?: "text" | "ansi";
      stripAnsi?: boolean;
      lines?: number;
    } = {},
  ): Promise<PaneReadResult> {
    const format = options.format ?? "ansi";
    const strip_ansi = options.stripAnsi ?? (format === "text");
    const params: Record<string, unknown> = {
      pane_id: paneId,
      source: options.source ?? "visible",
      format,
      strip_ansi,
    };
    if (typeof options.lines === "number") {
      params.lines = options.lines;
    }
    const res = await this.request<{ read?: PaneReadResult } & Partial<PaneReadResult>>("pane.read", params);
    if (res.read) {
      return res.read;
    }
    return res as unknown as PaneReadResult;
  }

  async sendAgentKeys(target: string, keys: string[]): Promise<void> {
    await this.request("agent.send_keys", { target, keys });
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
  }

  async sendAgentPrompt(target: string, text: string): Promise<void> {
    await this.request("agent.prompt", { target, text });
  }

  async renamePane(paneId: string, label: string | null): Promise<void> {
    await this.request("pane.rename", { pane_id: paneId, label });
  }

  async focusAgent(target: string): Promise<void> {
    await this.request("agent.focus", { target });
  }

  async focusPane(paneId: string): Promise<void> {
    await this.request("pane.focus", { pane_id: paneId });
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.request("workspace.focus", { workspace_id: workspaceId });
  }

  async focusTab(tabId: string): Promise<void> {
    await this.request("tab.focus", { tab_id: tabId });
  }

  async focusPaneAcrossWorkspaces(paneId: string, workspaceId?: string | null, tabId?: string | null): Promise<void> {
    if (workspaceId) {
      await this.focusWorkspace(workspaceId);
    }
    if (tabId) {
      await this.focusTab(tabId);
    }
    await this.focusPane(paneId);
  }

  async closePopup(): Promise<void> {
    try {
      await this.request("popup.close", {});
    } catch {
      // Ignore if not running inside a popup
    }
  }

  async openPluginPane(params: {
    plugin_id: string;
    entrypoint: string;
    placement?: "popup" | "overlay" | "split" | "tab" | "zoomed";
    width?: string | number;
    height?: string | number;
    workspace_id?: string;
    target_pane_id?: string;
    focus?: boolean;
    env?: Record<string, string>;
  }): Promise<Record<string, unknown>> {
    return this.request("plugin.pane.open", params);
  }

  async focusPluginPane(paneId: string): Promise<Record<string, unknown>> {
    return this.request("plugin.pane.focus", { pane_id: paneId });
  }

  subscribe(
    subscriptions: Array<Record<string, unknown>>,
    handlers: {
      onStarted?: () => void;
      onEvent: (ev: IncomingHerdrEvent) => void;
      onEventsLost?: () => void;
      onClose?: (err?: Error) => void;
    },
  ): { close: () => void } {
    let closedByCaller = false;
    let ackReceived = false;
    let buffer = "";
    const reqId = `sub_${process.pid}_${++this.reqCounter}`;
    const sock: Socket = createConnection(this.socketPath);

    sock.setEncoding("utf8");

    sock.on("connect", () => {
      sock.write(
        JSON.stringify({
          id: reqId,
          method: "events.subscribe",
          params: { subscriptions },
        }) + "\n",
      );
    });

    sock.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (!ackReceived) {
            ackReceived = true;
            if (msg.error) {
              const errObj = msg.error as { code?: string; message?: string };
              sock.destroy();
              handlers.onClose?.(new HerdrRpcError(errObj.code ?? "subscribe_error", errObj.message ?? "Subscribe failed"));
              return;
            }
            handlers.onStarted?.();
            continue;
          }

          if (msg.error) {
            const errObj = msg.error as { code?: string; message?: string };
            if (errObj.code === "events_lost") {
              handlers.onEventsLost?.();
              sock.destroy();
              return;
            }
          }

          if (typeof msg.event === "string" && msg.data && typeof msg.data === "object") {
            handlers.onEvent({
              event: msg.event,
              data: msg.data as Record<string, unknown>,
            });
          }
        } catch {
          // Ignore malformed line
        }
      }
    });

    sock.on("error", (err) => {
      if (!closedByCaller) {
        handlers.onClose?.(err);
      }
    });

    sock.on("close", () => {
      if (!closedByCaller) {
        handlers.onClose?.();
      }
    });

    return {
      close: () => {
        closedByCaller = true;
        sock.destroy();
      },
    };
  }
}
