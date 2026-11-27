import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fitAnsiColumns, pickNameColor, visibleWidth } from "../src/ansi.ts";
import {
  buildOsc11Query,
  detectTerminalAppearanceFromEnv,
  extractOsc11FromInput,
  loadActiveHerdrTheme,
  parseHerdrConfigToml,
  parseOsc11Response,
  resolveHerdrConfigPath,
  resolveThemeFromHerdrConfig,
  watchHerdrConfig,
} from "../src/herdr-config.ts";
import { parseTerminalInput } from "../src/keys.ts";
import { stripAnsi } from "../src/model.ts";
import { renderScreen, type RenderState } from "../src/render.ts";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  compileTheme,
  contrastRatio,
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  getBuiltinTheme,
  getHerdrThemeSiblingPair,
  getThemeSignature,
  parseThemeColor,
  resolveBuiltinThemeId,
  type AppearanceMode,
  type DeckTheme,
  type RgbColor,
} from "../src/theme.ts";
import type { DeckAgentItem } from "../src/types.ts";

const TRUECOLOR_SGR_RE = /\x1b\[(?:38|48);2;/;

function extractRenderedRows(frame: string): string[] {
  return [...frame.matchAll(/\x1b\[(\d+);1H([\s\S]*?)\x1b\[K/g)].map((m) => m[2]!);
}

function makeRichItems(now: number): DeckAgentItem[] {
  return [
    {
      itemKey: "w1:p1",
      machineId: null,
      machineLabel: null,
      paneId: "w1:p1",
      workspaceId: "w1",
      tabId: "w1:t1",
      workspaceLabel: "backend-api",
      workspaceNumber: 1,
      tabLabel: "main",
      paneLabel: "very-long-blocked-agent-title-for-truncation-check",
      primaryTitle: "very-long-blocked-agent-title-for-truncation-check",
      branch: "feat/very-long-branch-name-for-ellipsis-testing",
      gitInfo: {
        branch: "feat/very-long-branch-name-for-ellipsis-testing",
        dirtyFiles: 4,
        ahead: 2,
        behind: 1,
      },
      cwd: "/Users/dev/workspace/backend-api",
      agentKind: "claude",
      agentDisplayName: "claude",
      rawStatus: "blocked",
      effectiveStatus: "blocked",
      group: "needs_you",
      sinceMs: now - 125_000,
      summary: "Allow Bash(pnpm --filter db migrate --force --verbose)?",
      completionSeq: null,
      stateChangeSeq: 5,
      revision: 12,
      focusedInHerdr: true,
    },
    {
      itemKey: "m-tokyo::w1:p9",
      machineId: "m-tokyo",
      machineLabel: "soltokyo",
      paneId: "w1:p9",
      workspaceId: "w1",
      tabId: "w1:t1",
      workspaceLabel: "remote-repo",
      workspaceNumber: 1,
      tabLabel: "1",
      paneLabel: "remote-blocked",
      primaryTitle: "remote-blocked",
      branch: "main",
      gitInfo: null,
      cwd: "/home/dev/remote-repo",
      agentKind: "agy",
      agentDisplayName: "agy",
      rawStatus: "blocked",
      effectiveStatus: "blocked",
      group: "needs_you",
      sinceMs: now - 45_000,
      summary: "Confirm remote deployment to staging cluster?",
      completionSeq: null,
      stateChangeSeq: 4,
      revision: 9,
      focusedInHerdr: false,
    },
    {
      itemKey: "w2:p1",
      machineId: null,
      machineLabel: null,
      paneId: "w2:p1",
      workspaceId: "w2",
      tabId: "w2:t1",
      workspaceLabel: "web-ui",
      workspaceNumber: 2,
      tabLabel: "dev",
      paneLabel: "frontend-polish",
      primaryTitle: "frontend-polish",
      branch: "main",
      gitInfo: { branch: "main", dirtyFiles: 0, ahead: 1, behind: 0 },
      cwd: "/Users/dev/workspace/web-ui",
      agentKind: "codex",
      agentDisplayName: "codex",
      rawStatus: "done",
      effectiveStatus: "done",
      group: "review",
      sinceMs: now - 180_000,
      summary: "Finished responsive card layout & verified all tests pass",
      completionSeq: 3,
      stateChangeSeq: 3,
      revision: 8,
      focusedInHerdr: false,
    },
    {
      itemKey: "w3:p1",
      machineId: null,
      machineLabel: null,
      paneId: "w3:p1",
      workspaceId: "w3",
      tabId: "w3:t1",
      workspaceLabel: "herdr-deck",
      workspaceNumber: 3,
      tabLabel: "1",
      paneLabel: "theme-builder",
      primaryTitle: "theme-builder",
      branch: "feat/themes",
      gitInfo: { branch: "feat/themes", dirtyFiles: 2, ahead: 0, behind: 0 },
      cwd: "/Users/dev/workspace/herdr-deck",
      agentKind: "agy",
      agentDisplayName: "agy",
      rawStatus: "working",
      effectiveStatus: "working",
      group: "working",
      sinceMs: now - 62_000,
      summary: "Running typecheck and bundling single-file artifact...",
      completionSeq: null,
      stateChangeSeq: 2,
      revision: 7,
      focusedInHerdr: false,
    },
    {
      itemKey: "w4:p1",
      machineId: null,
      machineLabel: null,
      paneId: "w4:p1",
      workspaceId: "w4",
      tabId: "w4:t1",
      workspaceLabel: "dotfiles",
      workspaceNumber: 4,
      tabLabel: "shell",
      paneLabel: "dotfiles",
      primaryTitle: "dotfiles",
      branch: "feat/shell-config-with-a-very-long-name",
      gitInfo: {
        branch: "feat/shell-config-with-a-very-long-name",
        dirtyFiles: 3,
        ahead: 2,
        behind: 1,
      },
      cwd: "/Users/dev/dotfiles",
      agentKind: "claude",
      agentDisplayName: "claude",
      rawStatus: "idle",
      effectiveStatus: "idle",
      group: "idle",
      sinceMs: now - 600_000,
      summary: "Idle at prompt waiting for next instruction",
      completionSeq: null,
      stateChangeSeq: 1,
      revision: 3,
      focusedInHerdr: false,
    },
  ];
}

test("all 8 built-in themes, aliases, unified light fallback, and unknown dark fallback", () => {
  assert.deepEqual(BUILTIN_THEME_IDS, [
    "catppuccin",
    "dracula",
    "tokyo-night",
    "gruvbox",
    "nord",
    "one-dark",
    "catppuccin-latte",
    "terminal",
  ]);
  assert.equal(DEFAULT_THEME_ID, "catppuccin");
  assert.equal(DEFAULT_THEME.id, "catppuccin");

  for (const id of BUILTIN_THEME_IDS) {
    const t = getBuiltinTheme(id);
    assert.equal(t.id, id);
    assert.equal(t.bgCanvas, "", `expected transparent bgCanvas for ${id}`);
    assert.equal(t.namePalette.length, 6, `expected 6 namePalette colors for ${id}`);
  }

  assert.equal(BUILTIN_THEMES["catppuccin-latte"].isLight, true);
  assert.equal(BUILTIN_THEMES["catppuccin-latte"].polarity, "light");
  assert.equal(BUILTIN_THEMES.terminal.isTerminal, true);
  assert.equal(BUILTIN_THEMES.terminal.polarity, "terminal");

  // Dark aliases
  assert.equal(resolveBuiltinThemeId("catppuccin-mocha"), "catppuccin");
  assert.equal(resolveBuiltinThemeId("MOCHA"), "catppuccin");
  assert.equal(resolveBuiltinThemeId("tokyonight"), "tokyo-night");
  assert.equal(resolveBuiltinThemeId("Tokyo_Night"), "tokyo-night");
  assert.equal(resolveBuiltinThemeId("gruvbox_dark"), "gruvbox");
  assert.equal(resolveBuiltinThemeId("onedark"), "one-dark");
  assert.equal(resolveBuiltinThemeId("terminal"), "terminal");

  // Unified light fallback: all Herdr light themes map to catppuccin-latte
  const lightAliases = [
    "catppuccin-latte",
    "latte",
    "light",
    "tokyo-night-day",
    "tokyo-day",
    "tokyonight-day",
    "gruvbox-light",
    "one-light",
    "onelight",
    "solarized-light",
    "kanagawa-lotus",
    "lotus",
    "rose-pine-dawn",
    "rosepine-dawn",
    "dawn",
  ];
  for (const alias of lightAliases) {
    assert.equal(
      resolveBuiltinThemeId(alias),
      "catppuccin-latte",
      `expected light alias "${alias}" -> catppuccin-latte`,
    );
  }

  // Unknown / unsupported dark names fall back to catppuccin
  for (const unknown of ["kanagawa", "rose-pine", "solarized", "solarized-dark", "nonexistent", "", undefined]) {
    assert.equal(
      resolveBuiltinThemeId(unknown),
      "catppuccin",
      `expected dark/unknown "${String(unknown)}" -> catppuccin`,
    );
  }

  // Strict zero TrueColor on compiled terminal theme tokens + pickNameColor + fitAnsiColumns
  const term = BUILTIN_THEMES.terminal;
  for (const [key, val] of Object.entries(term)) {
    if (typeof val === "string") {
      assert.ok(!TRUECOLOR_SGR_RE.test(val), `terminal.${key} must not emit TrueColor: ${JSON.stringify(val)}`);
    }
  }
  for (const color of term.namePalette) {
    assert.ok(!TRUECOLOR_SGR_RE.test(color), `terminal.namePalette entry must not emit TrueColor`);
  }
  assert.ok(term.fgUrgentTitleOverride.length > 0, "expected high-contrast fgUrgentTitleOverride in terminal theme");
  assert.ok(!TRUECOLOR_SGR_RE.test(pickNameColor("", term.namePalette)));
  assert.ok(!TRUECOLOR_SGR_RE.test(pickNameColor("agent-alpha", term.namePalette)));

  const truncatedTerminal = fitAnsiColumns("\x1b[32mhello world long text\x1b[0m", 10, term.fgMuted);
  assert.equal(visibleWidth(truncatedTerminal), 10);
  assert.ok(!TRUECOLOR_SGR_RE.test(truncatedTerminal), "fitAnsiColumns with string ellipsisColor must not emit TrueColor");
});

test("TOML parser handles [theme], [theme.custom], dark/light overrides, legacy [ui].accent, and all color formats", () => {
  // Color format parsing
  assert.deepEqual(parseThemeColor("#1e66f5"), { kind: "rgb", r: 30, g: 102, b: 245 });
  assert.deepEqual(parseThemeColor("#0f8"), { kind: "rgb", r: 0, g: 255, b: 136 });
  assert.deepEqual(parseThemeColor("rgb(12, 34, 56)"), { kind: "rgb", r: 12, g: 34, b: 56 });
  assert.deepEqual(parseThemeColor("reset"), { kind: "reset" });
  assert.deepEqual(parseThemeColor("default"), { kind: "reset" });
  assert.deepEqual(parseThemeColor("light_red"), { kind: "ansi16", name: "light_red" });
  assert.deepEqual(parseThemeColor("bright-cyan"), { kind: "ansi16", name: "light_cyan" });
  assert.deepEqual(parseThemeColor("208"), { kind: "indexed", index: 208 });
  assert.equal(parseThemeColor("rgb(300, 0, 0)"), null);
  assert.equal(parseThemeColor("999"), null);
  assert.equal(parseThemeColor("not-a-color"), null);

  const toml = `
# Leading comment
[general]
notes = """
[theme]
name = "should-be-ignored-inside-multiline-string"
"""
list = [
  "item1",
  "[theme]",
]

[ui]
accent = "#ff00aa" # legacy accent

[theme]
name = "tokyo-night" # inline comment after string
auto_switch = true
dark_name = "dracula"
light_name = 'gruvbox-light'

[theme.custom]
green = '#0f0'
yellow = "rgb(250, 200, 10)"
blue = "208"
teal = "light_cyan"
sidebar_bg = "reset"

[theme.custom.dark]
accent = "#112233"

[theme.custom.light]
accent = "#445566"
red = "#aa0000"
`;

  const cfg = parseHerdrConfigToml(toml);
  assert.equal(cfg.name, "tokyo-night");
  assert.equal(cfg.autoSwitch, true);
  assert.equal(cfg.darkName, "dracula");
  assert.equal(cfg.lightName, "gruvbox-light");
  assert.equal(cfg.legacyUiAccent, "#ff00aa");
  assert.deepEqual(cfg.custom.green, { kind: "rgb", r: 0, g: 255, b: 0 });
  assert.deepEqual(cfg.custom.yellow, { kind: "rgb", r: 250, g: 200, b: 10 });
  assert.deepEqual(cfg.custom.blue, { kind: "indexed", index: 208 });
  assert.deepEqual(cfg.custom.teal, { kind: "ansi16", name: "light_cyan" });
  assert.deepEqual(cfg.custom.sidebar_bg, { kind: "reset" });
  assert.deepEqual(cfg.customDark.accent, { kind: "rgb", r: 17, g: 34, b: 51 });
  assert.deepEqual(cfg.customLight.accent, { kind: "rgb", r: 68, g: 85, b: 102 });

  // Precedence when auto_switch = true:
  // dark mode -> dark_name ("dracula") + custom + custom.dark (beats legacy [ui].accent)
  const darkTheme = resolveThemeFromHerdrConfig(cfg, "dark");
  assert.equal(darkTheme.id, "dracula");
  assert.deepEqual(darkTheme.palette.accent, { kind: "rgb", r: 17, g: 34, b: 51 });
  assert.deepEqual(darkTheme.palette.green, { kind: "rgb", r: 0, g: 255, b: 0 });

  // light mode -> light_name ("gruvbox-light" -> unified "catppuccin-latte") + custom + custom.light
  const lightTheme = resolveThemeFromHerdrConfig(cfg, "light");
  assert.equal(lightTheme.id, "catppuccin-latte");
  assert.equal(lightTheme.sourceName, "gruvbox-light");
  assert.deepEqual(lightTheme.palette.accent, { kind: "rgb", r: 68, g: 85, b: 102 });
  assert.deepEqual(lightTheme.palette.red, { kind: "rgb", r: 170, g: 0, b: 0 });

  // Precedence when auto_switch = false: mode overrides are ignored, legacy [ui].accent applies if custom.accent unset
  const staticLegacyCfg = parseHerdrConfigToml(`
[ui]
accent = "#ff00aa"
[theme]
name = "nord"
auto_switch = false
[theme.custom.dark]
accent = "#010203"
`);
  const staticLegacyTheme = resolveThemeFromHerdrConfig(staticLegacyCfg, "dark");
  assert.equal(staticLegacyTheme.id, "nord");
  assert.deepEqual(staticLegacyTheme.palette.accent, { kind: "rgb", r: 255, g: 0, b: 170 });

  // Legacy [ui].accent == "cyan" is ignored (Herdr default)
  const cyanLegacyCfg = parseHerdrConfigToml(`
[ui]
accent = "cyan"
[theme]
name = "nord"
`);
  const cyanLegacyTheme = resolveThemeFromHerdrConfig(cyanLegacyCfg, "dark");
  assert.deepEqual(cyanLegacyTheme.palette.accent, BUILTIN_THEMES.nord.palette.accent);

  // [theme.custom].accent beats legacy [ui].accent
  const customBeatsLegacyCfg = parseHerdrConfigToml(`
[ui]
accent = "#ff00aa"
[theme]
name = "nord"
custom = { accent = "#00aaff" }
`);
  const customBeatsLegacyTheme = resolveThemeFromHerdrConfig(customBeatsLegacyCfg, "dark");
  assert.deepEqual(customBeatsLegacyTheme.palette.accent, { kind: "rgb", r: 0, g: 170, b: 255 });

  // Single-line triple-quoted TOML strings
  const tripleQuotedCfg = parseHerdrConfigToml(`
[theme]
name = """dracula"""
light_name = '''gruvbox-light'''
`);
  assert.equal(tripleQuotedCfg.name, "dracula");
  assert.equal(tripleQuotedCfg.lightName, "gruvbox-light");

  // Config path resolution priority
  assert.equal(
    resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "/tmp/custom.toml", HERDR_CONFIG_DIR: "/tmp/dir" }, "/home/u"),
    "/tmp/custom.toml",
  );
  assert.equal(
    resolveHerdrConfigPath({ HERDR_CONFIG_DIR: "~/my-herdr" }, "/home/u"),
    "/home/u/my-herdr/config.toml",
  );
  assert.equal(
    resolveHerdrConfigPath({}, "/home/u"),
    "/home/u/.config/herdr/config.toml",
  );
});

test("auto_switch sibling pairs, COLORFGBG detection, and chunked OSC 11 input filtering", () => {
  // Sibling pairs
  assert.deepEqual(getHerdrThemeSiblingPair("catppuccin"), {
    dark: "catppuccin",
    light: "catppuccin-latte",
  });
  assert.deepEqual(getHerdrThemeSiblingPair("gruvbox-light"), {
    dark: "gruvbox",
    light: "gruvbox-light",
  });
  assert.deepEqual(getHerdrThemeSiblingPair("tokyo-night"), {
    dark: "tokyo-night",
    light: "tokyo-night-day",
  });
  assert.deepEqual(getHerdrThemeSiblingPair("one-dark"), {
    dark: "one-dark",
    light: "one-light",
  });
  assert.deepEqual(getHerdrThemeSiblingPair("dracula"), {
    dark: "dracula",
    light: "dracula",
  });

  // auto_switch using sibling pairs without explicit dark_name/light_name
  const autoCfg = parseHerdrConfigToml(`
[theme]
name = "gruvbox"
auto_switch = true
`);
  assert.equal(resolveThemeFromHerdrConfig(autoCfg, "dark").id, "gruvbox");
  assert.equal(resolveThemeFromHerdrConfig(autoCfg, "light").id, "catppuccin-latte");

  // COLORFGBG detection
  assert.equal(detectTerminalAppearanceFromEnv({}), "dark");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "15;0" }), "dark");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "7;8" }), "dark");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "0;7" }), "light");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "15;default;0" }), "dark");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "0;231" }), "light");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "15;234" }), "dark");
  assert.equal(detectTerminalAppearanceFromEnv({ COLORFGBG: "malformed" }), "dark");

  // OSC 11 query & response parsing
  assert.equal(buildOsc11Query(), "\x1b]11;?\x07");
  assert.equal(parseOsc11Response("\x1b]11;rgb:1818/1818/2525\x07")?.appearance, "dark");
  assert.equal(parseOsc11Response("\x1b]11;rgb:efef/f1f1/f5f5\x1b\\")?.appearance, "light");
  assert.equal(parseOsc11Response("\x1b]11;#eff1f5\x07")?.appearance, "light");

  // Standalone Esc MUST pass through immediately with ZERO buffering/delay
  const escRes = extractOsc11FromInput("\x1b");
  assert.equal(escRes.passthrough, "\x1b");
  assert.equal(escRes.pending, "");
  assert.equal(escRes.appearance, null);

  // CSI arrow key passes through immediately
  const arrowRes = extractOsc11FromInput("\x1b[A");
  assert.equal(arrowRes.passthrough, "\x1b[A");
  assert.equal(arrowRes.pending, "");
  assert.equal(arrowRes.appearance, null);

  // Chunked OSC 11 response split across 4 stdin chunks with user keys before & after
  const c1 = extractOsc11FromInput("k\x1b]");
  assert.equal(c1.passthrough, "k");
  assert.equal(c1.pending, "\x1b]");
  assert.equal(c1.appearance, null);

  const c2 = extractOsc11FromInput("11;rgb:efef/", c1.pending);
  assert.equal(c2.passthrough, "");
  assert.equal(c2.pending, "\x1b]11;rgb:efef/");
  assert.equal(c2.appearance, null);

  const c3 = extractOsc11FromInput("f1f1/f5f5\x1b", c2.pending);
  assert.equal(c3.passthrough, "");
  assert.equal(c3.pending, "\x1b]11;rgb:efef/f1f1/f5f5\x1b");
  assert.equal(c3.appearance, null);

  const c4 = extractOsc11FromInput("\\j", c3.pending);
  assert.equal(c4.passthrough, "j");
  assert.equal(c4.pending, "");
  assert.equal(c4.appearance, "light");
  assert.deepEqual(c4.backgroundRgb, { r: 239, g: 241, b: 245 });

  // Non-OSC-11 sequence passes through without sticking in pending
  const otherOsc = extractOsc11FromInput("\x1b]0;window title\x07x");
  assert.equal(otherOsc.passthrough, "\x1b]0;window title\x07x");
  assert.equal(otherOsc.pending, "");
  assert.equal(otherOsc.appearance, null);

  // Alt+a passes through immediately with zero buffering and parses cleanly
  const altA = extractOsc11FromInput("\x1ba");
  assert.equal(altA.passthrough, "\x1ba");
  assert.equal(altA.pending, "");
  assert.deepEqual(parseTerminalInput(Buffer.from(altA.passthrough, "utf8")), [
    { kind: "special", name: "esc" },
    { kind: "char", value: "a" },
  ]);

  // Alt+] ("\x1b]") buffers as pending while OSC 11 filtering is active; timeout flush preserves it (!startsWith("\x1b]11;"))
  const altBracket = extractOsc11FromInput("\x1b]");
  assert.equal(altBracket.passthrough, "");
  assert.equal(altBracket.pending, "\x1b]");
  assert.equal(altBracket.pending.startsWith("\x1b]11;"), false);
  assert.deepEqual(parseTerminalInput(Buffer.from(altBracket.pending, "utf8")), [
    { kind: "special", name: "esc" },
    { kind: "char", value: "]" },
  ]);

  // Truncated OSC 11 payload starts with "\x1b]11;" so timeout safely drops it instead of injecting garbage keys
  const truncatedOsc11 = extractOsc11FromInput("\x1b]11;rgb:1e1e/");
  assert.equal(truncatedOsc11.passthrough, "");
  assert.equal(truncatedOsc11.pending.startsWith("\x1b]11;"), true);

  // Bracketed paste & UTF-8/CJK + emoji pass through extractOsc11FromInput untouched with zero buffering
  const bracketedPaste = extractOsc11FromInput("\x1b[200~hello 世界\x1b[201~");
  assert.equal(bracketedPaste.passthrough, "\x1b[200~hello 世界\x1b[201~");
  assert.equal(bracketedPaste.pending, "");
  assert.deepEqual(parseTerminalInput(Buffer.from(bracketedPaste.passthrough, "utf8")), [
    { kind: "char", value: "h" },
    { kind: "char", value: "e" },
    { kind: "char", value: "l" },
    { kind: "char", value: "l" },
    { kind: "char", value: "o" },
    { kind: "special", name: "space" },
    { kind: "char", value: "世" },
    { kind: "char", value: "界" },
  ]);

  const cjkUtf8 = extractOsc11FromInput("你好世界🚀");
  assert.equal(cjkUtf8.passthrough, "你好世界🚀");
  assert.equal(cjkUtf8.pending, "");
  assert.deepEqual(parseTerminalInput(Buffer.from(cjkUtf8.passthrough, "utf8")), [
    { kind: "char", value: "你" },
    { kind: "char", value: "好" },
    { kind: "char", value: "世" },
    { kind: "char", value: "界" },
    { kind: "char", value: "🚀" },
  ]);
});

test("watchHerdrConfig hot-reloads on atomic rename, symlinked dotfiles target, and appearance reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-deck-watch-"));
  try {
    const targetDir = join(root, "dotfiles");
    const configDir = join(root, "config");
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const realTarget = join(targetDir, "herdr.toml");
    const symlinkConfig = join(configDir, "config.toml");

    writeFileSync(
      realTarget,
      `[theme]\nname = "gruvbox"\nauto_switch = true\n`,
      "utf8",
    );
    symlinkSync(realTarget, symlinkConfig);

    // Sync startup load via symlink
    const initialTheme = loadActiveHerdrTheme({ configPath: symlinkConfig, appearance: "dark" });
    assert.equal(initialTheme.id, "gruvbox");

    let appearance: AppearanceMode = "dark";
    const events: DeckTheme[] = [];
    let nextChangeResolve: ((t: DeckTheme) => void) | null = null;

    const waitForThemeChange = (timeoutMs = 2500): Promise<DeckTheme> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for watchHerdrConfig onChange")),
          timeoutMs,
        );
        nextChangeResolve = (theme) => {
          clearTimeout(timer);
          nextChangeResolve = null;
          resolve(theme);
        };
      });

    const watcher = watchHerdrConfig(
      (theme) => {
        events.push(theme);
        nextChangeResolve?.(theme);
      },
      {
        configPath: symlinkConfig,
        debounceMs: 30,
        getAppearance: () => appearance,
      },
    );

    try {
      // 1. Atomic rename of the symlink target file -> switches gruvbox -> tokyo-night
      const wait1 = waitForThemeChange();
      const tmpTarget = `${realTarget}.tmp`;
      writeFileSync(tmpTarget, `[theme]\nname = "tokyo-night"\nauto_switch = true\n`, "utf8");
      renameSync(tmpTarget, realTarget);
      const updated1 = await wait1;
      assert.equal(updated1.id, "tokyo-night");

      // 2. Dynamic OSC 11 appearance change + reload() -> switches tokyo-night -> catppuccin-latte
      appearance = "light";
      const reloadedLight = watcher.reload();
      assert.equal(reloadedLight.id, "catppuccin-latte");
      assert.equal(events[events.length - 1]!.id, "catppuccin-latte");

      // 3. Atomic rename directly replacing configPath itself (non-symlink) -> switches to nord
      const wait2 = waitForThemeChange();
      const tmpLink = `${symlinkConfig}.tmp`;
      writeFileSync(tmpLink, `[theme]\nname = "nord"\nauto_switch = false\n`, "utf8");
      renameSync(tmpLink, symlinkConfig);
      const updated2 = await wait2;
      assert.equal(updated2.id, "nord");

      // 4. Reload with unchanged file does not fire duplicate onChange
      const countBefore = events.length;
      const sameSigBefore = getThemeSignature(updated2);
      const sameTheme = watcher.reload();
      assert.equal(getThemeSignature(sameTheme), sameSigBefore);
      assert.equal(events.length, countBefore);

      // 5. Toggling auto_switch: false -> true with UNCHANGED dark theme name MUST fire onChange (so app can send OSC 11)
      const waitAutoOn = waitForThemeChange();
      const tmpAutoOn = `${symlinkConfig}.auto-on.tmp`;
      writeFileSync(tmpAutoOn, `[theme]\nname = "nord"\nauto_switch = true\n`, "utf8");
      renameSync(tmpAutoOn, symlinkConfig);
      const afterAutoOn = await waitAutoOn;
      assert.equal(afterAutoOn.id, "nord");

      // Reload again without changes remains deduplicated
      const countAfterAutoOn = events.length;
      watcher.reload();
      assert.equal(events.length, countAfterAutoOn);
    } finally {
      watcher.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function parseSgrRgb(sgr: string): RgbColor | null {
  const m = /\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(sgr);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

test("all 7 RGB built-in themes maintain >= 3.0 WCAG contrast on bgSelected and bgUrgent surfaces", () => {
  const rgbThemes = BUILTIN_THEME_IDS.filter((id) => id !== "terminal").map((id) =>
    getBuiltinTheme(id),
  );

  for (const theme of rgbThemes) {
    const bgSelected = parseSgrRgb(theme.bgSelected);
    const bgUrgent = parseSgrRgb(theme.bgUrgent);
    assert.ok(bgSelected, `${theme.id}: expected RGB bgSelected`);
    assert.ok(bgUrgent, `${theme.id}: expected RGB bgUrgent`);

    const onSelectedTokens: Array<[string, string]> = [
      ["fgOnSelected", theme.fgOnSelected],
      ["fgOnSelectedMuted", theme.fgOnSelectedMuted],
      ["fgOnSelectedDivider", theme.fgOnSelectedDivider],
      ["borderReply", theme.borderReply],
      ["borderRename", theme.borderRename],
      ["statusReview", theme.statusReview],
      ["statusWorking", theme.statusWorking],
      ["gitBranch", theme.gitBranch],
      ["gitDirty", theme.gitDirty],
      ["gitAhead", theme.gitAhead],
      ["gitBehind", theme.gitBehind],
      ["accentRemote", theme.accentRemote],
      ...theme.namePalette.map((sgr, idx): [string, string] => [`namePalette[${idx}]`, sgr]),
    ];

    for (const [tokenName, sgr] of onSelectedTokens) {
      const fg = parseSgrRgb(sgr);
      assert.ok(fg, `${theme.id}.${tokenName}: expected RGB fg`);
      const ratio = contrastRatio(fg, bgSelected);
      assert.ok(
        ratio >= 3.0,
        `${theme.id}.${tokenName} contrast on bgSelected too low: ${ratio.toFixed(2)} (< 3.0)`,
      );
    }

    const onUrgentTokens: Array<[string, string]> = [
      ["fgUrgentBadge", theme.fgUrgentBadge],
      ["fgOnUrgent", theme.fgOnUrgent],
      ["fgUrgentAccent", theme.fgUrgentAccent],
      ["fgOnUrgentMuted", theme.fgOnUrgentMuted],
      ["accentRemote", theme.accentRemote],
      ...theme.namePalette.map((sgr, idx): [string, string] => [`namePalette[${idx}]`, sgr]),
    ];

    for (const [tokenName, sgr] of onUrgentTokens) {
      const fg = parseSgrRgb(sgr);
      assert.ok(fg, `${theme.id}.${tokenName}: expected RGB fg`);
      const ratio = contrastRatio(fg, bgUrgent);
      assert.ok(
        ratio >= 3.0,
        `${theme.id}.${tokenName} contrast on bgUrgent too low: ${ratio.toFixed(2)} (< 3.0)`,
      );
    }
  }
});

test("renderScreen preserves exact widths, transparent interiors across all 8 themes, and ZERO TrueColor in terminal mode across all UI modes", () => {
  const now = 1_700_000_000_000;
  const items = makeRichItems(now);
  // Preview uses ANSI-16 codes only so we can strictly assert zero TrueColor in terminal mode
  const ansi16Preview =
    "\x1b[33m╭─ Permission Required ─╮\x1b[0m\n" +
    "\x1b[36m│ Bash(pnpm db:migrate) │\x1b[0m\n" +
    "╰───────────────────────╯";

  const makeBaseState = (theme: DeckTheme, overrides: Partial<RenderState> = {}): RenderState => ({
    cols: 112,
    rows: 26,
    items,
    selectedItemKey: "w3:p1",
    focusMode: "list",
    filterTab: "all",
    showIdle: true,
    showHelp: false,
    previewText: ansi16Preview,
    replyDraft: "",
    replyCursor: 0,
    renameDraft: "",
    renameCursor: 0,
    toastMessage: null,
    toastKind: "info",
    spinnerTick: 3,
    nowMs: now,
    theme,
    ...overrides,
  });

  const buildModeScenarios = (theme: DeckTheme): Array<{ label: string; state: RenderState }> => [
    {
      label: "normal-working-selected-wide",
      state: makeBaseState(theme, { selectedItemKey: "w3:p1" }),
    },
    {
      label: "normal-idle-selected-git-badge",
      state: makeBaseState(theme, { selectedItemKey: "w4:p1" }),
    },
    {
      label: "blocked-local-selected",
      state: makeBaseState(theme, { selectedItemKey: "w1:p1" }),
    },
    {
      label: "blocked-remote-selected",
      state: makeBaseState(theme, { selectedItemKey: "m-tokyo::w1:p9" }),
    },
    {
      label: "stacked-narrow-truncation",
      state: makeBaseState(theme, { cols: 52, rows: 22, selectedItemKey: "w1:p1" }),
    },
    {
      label: "reply-mode-cjk",
      state: makeBaseState(theme, {
        selectedItemKey: "w3:p1",
        focusMode: "reply",
        replyDraft: "继续跑测试并修复所有 lint 报错",
        replyCursor: 6,
      }),
    },
    {
      label: "rename-mode",
      state: makeBaseState(theme, {
        selectedItemKey: "w2:p1",
        focusMode: "rename",
        renameDraft: "auth-refactor",
        renameCursor: 13,
      }),
    },
    {
      label: "toast-info",
      state: makeBaseState(theme, { toastMessage: "已刷新全部状态", toastKind: "info" }),
    },
    {
      label: "toast-ok",
      state: makeBaseState(theme, { toastMessage: "已发送回复 → theme-builder", toastKind: "ok" }),
    },
    {
      label: "toast-warn",
      state: makeBaseState(theme, { toastMessage: "远端机器不支持直接跳转", toastKind: "warn" }),
    },
    {
      label: "toast-error",
      state: makeBaseState(theme, { toastMessage: "发送按键失败: socket timeout", toastKind: "error" }),
    },
    {
      label: "cheatsheet-modal",
      state: makeBaseState(theme, { showHelp: true }),
    },
    {
      label: "cheatsheet-modal-narrow",
      state: makeBaseState(theme, { cols: 48, rows: 24, showHelp: true }),
    },
    {
      label: "empty-inbox-zero",
      state: makeBaseState(theme, { items: [], selectedItemKey: null, previewText: "" }),
    },
    {
      label: "empty-filtered-attention",
      state: makeBaseState(theme, {
        items: [items[4]!],
        selectedItemKey: null,
        filterTab: "attention",
        showIdle: false,
        previewText: "",
      }),
    },
    {
      label: "preview-loading-no-dim",
      state: makeBaseState(theme, { selectedItemKey: "w2:p1", previewText: "" }),
    },
  ];

  for (const id of BUILTIN_THEME_IDS) {
    const theme = getBuiltinTheme(id);
    for (const { label, state } of buildModeScenarios(theme)) {
      const frame = renderScreen(state);
      assert.ok(frame.startsWith("\x1b[?2026h\x1b[?7l"), `${id}/${label}: missing DEC 2026 prefix`);
      assert.ok(frame.endsWith("\x1b[?2026l"), `${id}/${label}: missing DEC 2026 suffix`);

      const rawRows = extractRenderedRows(frame);
      assert.equal(rawRows.length, state.rows, `${id}/${label}: row count mismatch`);

      for (const [rowIdx, rawRow] of rawRows.entries()) {
        const plain = stripAnsi(rawRow);
        assert.equal(
          visibleWidth(plain),
          state.cols,
          `${id}/${label} row ${rowIdx} width mismatch: "${plain}"`,
        );
      }

      // Loading placeholder must not rely on DIM (\x1b[2m) for light-theme crispness
      if (label === "preview-loading-no-dim") {
        assert.ok(
          !frame.includes("\x1b[2m"),
          `${id}/${label}: expected no DIM (\\x1b[2m) in rendered frame`,
        );
      }

      // Transparent card interiors: empty inbox-zero body rows should contain NO background SGR
      if (label === "empty-inbox-zero") {
        // Row index 2 is an interior blank row inside both left list card and right preview card
        const interiorRow = rawRows[2]!;
        assert.ok(
          !/\x1b\[(?:48;|4[0-7]|10[0-7])/.test(interiorRow),
          `${id}/${label}: card interior should be transparent (no bg SGR), got ${JSON.stringify(interiorRow)}`,
        );
      }

      // Strict ZERO TrueColor assertion across EVERY UI mode in terminal theme
      if (id === "terminal") {
        assert.ok(
          !TRUECOLOR_SGR_RE.test(frame),
          `terminal/${label} MUST NOT contain any 38;2; or 48;2; TrueColor escape sequences!`,
        );
      }
    }
  }

  // Distinct themes actually produce distinct ANSI frames (theme wiring is live end-to-end)
  const catppuccinFrame = renderScreen(makeBaseState(BUILTIN_THEMES.catppuccin));
  const gruvboxFrame = renderScreen(makeBaseState(BUILTIN_THEMES.gruvbox));
  const latteFrame = renderScreen(makeBaseState(BUILTIN_THEMES["catppuccin-latte"]));
  const terminalFrame = renderScreen(makeBaseState(BUILTIN_THEMES.terminal));
  assert.notEqual(catppuccinFrame, gruvboxFrame);
  assert.notEqual(catppuccinFrame, latteFrame);
  assert.notEqual(catppuccinFrame, terminalFrame);

  // Custom theme compiled with overrides produces distinct frame from base
  const customNord = compileTheme("nord", {
    overrides: { accent: { kind: "rgb", r: 255, g: 100, b: 50 } },
  });
  assert.notEqual(
    renderScreen(makeBaseState(BUILTIN_THEMES.nord)),
    renderScreen(makeBaseState(customNord)),
  );
});
