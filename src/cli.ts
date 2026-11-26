import { HerdrSocketClient } from "./socket-client.ts";
import {
  reconcileTimersWithSnapshot,
  recordAgentStatusTransition,
  updateDeckState,
} from "./state.ts";
import { runTuiApp } from "./app.ts";
import type { AgentStatus } from "./types.ts";

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "karllooki.herdr-deck";

async function handleStartup(): Promise<void> {
  const client = new HerdrSocketClient();
  try {
    const snapshot = await client.getSnapshot();
    updateDeckState((state) => {
      reconcileTimersWithSnapshot(state, snapshot);
    });
  } catch {
    // Server might still be warming up or empty
  }
}

async function handleEvent(): Promise<void> {
  const eventName = process.env.HERDR_PLUGIN_EVENT ?? "";
  const rawJson = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!rawJson) return;

  try {
    const parsed = JSON.parse(rawJson) as {
      event?: string;
      data?: Record<string, unknown>;
    } & Record<string, unknown>;

    const data =
      parsed.data && typeof parsed.data === "object"
        ? parsed.data
        : parsed;

    const kind = parsed.event ?? eventName;
    const paneId = typeof data.pane_id === "string" ? data.pane_id : null;
    if (!paneId) return;

    updateDeckState((state) => {
      if (kind === "pane_closed" || kind === "pane.closed") {
        delete state.timers[paneId];
        return;
      }

      if (kind === "pane_agent_status_changed" || kind === "pane.agent_status_changed") {
        const status = data.agent_status as AgentStatus | undefined;
        if (status) {
          recordAgentStatusTransition(state, paneId, status);
        }
        return;
      }

      if (kind === "pane_agent_detected" || kind === "pane.agent_detected") {
        if (data.released === true) {
          delete state.timers[paneId];
        } else if (typeof data.final_status === "string") {
          recordAgentStatusTransition(state, paneId, data.final_status as AgentStatus);
        }
      }
    });
  } catch {
    // Never fail Herdr event hook loudly on malformed payload
  }
}

async function handleActionInbox(): Promise<void> {
  const client = new HerdrSocketClient();
  await client.openPluginPane({
    plugin_id: PLUGIN_ID,
    entrypoint: "inbox",
    placement: "popup",
    width: "92%",
    height: "88%",
    focus: true,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? "ui";

  switch (subcommand) {
    case "startup":
      await handleStartup();
      return;
    case "event":
      await handleEvent();
      return;
    case "action":
      await handleActionInbox();
      return;
    case "ui":
      await runTuiApp();
      return;
    default:
      process.stderr.write(`Unknown herdr-deck subcommand: ${subcommand}\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(
    `herdr-deck error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(1);
});
