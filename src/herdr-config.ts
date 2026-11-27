// Zero-dependency Herdr v0.9.5 config.toml reader, theme resolver, appearance detector (COLORFGBG + OSC 11),
// and symlink-safe / atomic-write-safe debounced config watcher for Herdr Deck.

import { existsSync, readFileSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  compileTheme,
  DEFAULT_THEME_ID,
  getHerdrThemeSiblingPair,
  getThemeSignature,
  isHerdrPaletteKey,
  parseThemeColor,
  relativeLuminance,
  resolveBuiltinThemeId,
  type AppearanceMode,
  type DeckTheme,
  type PartialHerdrPalette,
  type RgbColor,
  type ThemeColor,
} from "./theme.ts";

export interface HerdrThemeConfig {
  /** Raw `[theme].name` if present and non-empty. */
  readonly name?: string;
  /** `[theme].auto_switch` (defaults to `false`). */
  readonly autoSwitch: boolean;
  /** Raw `[theme].dark_name` if present and non-empty. */
  readonly darkName?: string;
  /** Raw `[theme].light_name` if present and non-empty. */
  readonly lightName?: string;
  /** Parsed `[theme.custom]` overrides. */
  readonly custom: PartialHerdrPalette;
  /** Parsed `[theme.custom.dark]` overrides (applied only when `autoSwitch === true` in dark mode). */
  readonly customDark: PartialHerdrPalette;
  /** Parsed `[theme.custom.light]` overrides (applied only when `autoSwitch === true` in light mode). */
  readonly customLight: PartialHerdrPalette;
  /** Raw `[ui].accent` legacy field (applied only when != "cyan" and `[theme.custom].accent` is unset). */
  readonly legacyUiAccent?: string;
}

export interface LoadHerdrThemeOptions {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly appearance?: AppearanceMode;
}

export interface Osc11ParseResult {
  readonly rgb: RgbColor;
  readonly appearance: AppearanceMode;
}

export interface Osc11FilterResult {
  /** Clean stdin data with complete OSC 11 responses stripped (safe to pass to `parseTerminalInput`). */
  readonly passthrough: string;
  /** Detected appearance if an OSC 11 response completed in this chunk, else `null`. */
  readonly appearance: AppearanceMode | null;
  /** Parsed background RGB if an OSC 11 response completed in this chunk, else `null`. */
  readonly backgroundRgb: RgbColor | null;
  /** Any incomplete trailing `\x1b]11;...` prefix to feed into the next `extractOsc11FromInput` call. */
  readonly pending: string;
}

export interface WatchHerdrConfigOptions {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /** Debounce delay in milliseconds (default: 150). */
  readonly debounceMs?: number;
  /** Dynamic getter for current terminal appearance (e.g. updated asynchronously via OSC 11). */
  readonly getAppearance?: () => AppearanceMode;
  /** Optional non-fatal error callback. */
  readonly onError?: (err: unknown) => void;
}

export interface HerdrConfigWatcher {
  /** Stop all fs watchers and cancel any pending debounce timer. */
  close(): void;
  /** Immediately re-read config and fire `onChange` if the resolved theme changed. */
  reload(): DeckTheme;
  /** The logical config file path being watched. */
  readonly configPath: string;
}

/** Standard OSC 11 terminal background color query (BEL-terminated). */
export const OSC_11_QUERY = "\x1b]11;?\x07";

export function buildOsc11Query(): string {
  return OSC_11_QUERY;
}

function expandHome(rawPath: string, homeDir: string): string {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/")) return join(homeDir, rawPath.slice(2));
  return rawPath;
}

/**
 * Resolve Herdr's `config.toml` path:
 * 1. `$HERDR_CONFIG_PATH`
 * 2. `$HERDR_CONFIG_DIR/config.toml`
 * 3. `~/.config/herdr/config.toml`
 */
export function resolveHerdrConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  const effectiveHome = homeDir ?? env.HOME ?? homedir();
  const explicitPath = env.HERDR_CONFIG_PATH?.trim();
  if (explicitPath) {
    return resolve(expandHome(explicitPath, effectiveHome));
  }
  const configDir = env.HERDR_CONFIG_DIR?.trim();
  if (configDir) {
    return resolve(join(expandHome(configDir, effectiveHome), "config.toml"));
  }
  return resolve(join(effectiveHome, ".config", "herdr", "config.toml"));
}

// ============================================================================
// Appearance Polarity Detection (COLORFGBG + OSC 11)
// ============================================================================

function xterm256IndexToRgb(index: number): RgbColor | null {
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const rIdx = Math.floor(n / 36);
    const gIdx = Math.floor((n % 36) / 6);
    const bIdx = n % 6;
    const steps = [0, 95, 135, 175, 215, 255] as const;
    return { r: steps[rIdx]!, g: steps[gIdx]!, b: steps[bIdx]! };
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return { r: v, g: v, b: v };
  }
  return null;
}

/**
 * Synchronously detect host terminal dark/light polarity from `COLORFGBG` (defaults to `"dark"`).
 */
export function detectTerminalAppearanceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AppearanceMode {
  const raw = env.COLORFGBG?.trim();
  if (!raw) return "dark";

  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return "dark";

  const bgStr = parts[parts.length - 1]!;
  if (!/^\d{1,3}$/.test(bgStr)) return "dark";

  const bg = Number(bgStr);
  if (bg < 0 || bg > 255) return "dark";

  // Standard ANSI 16 palette: 0..6 and 8 (bright black/dark gray) are dark; 7 (light gray) and 15 (white) are light.
  if (bg <= 15) {
    return bg === 7 || bg === 15 ? "light" : "dark";
  }

  const rgb = xterm256IndexToRgb(bg);
  if (!rgb) return "dark";
  return relativeLuminance(rgb) >= 0.4 ? "light" : "dark";
}

function scaleX11HexChannel(hex: string): number {
  const maxVal = (1 << (4 * hex.length)) - 1;
  const val = parseInt(hex, 16);
  return Math.max(0, Math.min(255, Math.round((val / maxVal) * 255)));
}

/**
 * Parse a terminal OSC 11 response (e.g. `\x1b]11;rgb:RRRR/GGGG/BBBB\x07` or `\x1b\\`-terminated)
 * into RGB + dark/light appearance polarity.
 */
export function parseOsc11Response(input: string): Osc11ParseResult | null {
  // Match rgb:R/G/B (1..4 hex digits per channel, X11 XParseColor format)
  const rgbMatch = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i.exec(
    input,
  );
  if (rgbMatch) {
    const rgb: RgbColor = {
      r: scaleX11HexChannel(rgbMatch[1]!),
      g: scaleX11HexChannel(rgbMatch[2]!),
      b: scaleX11HexChannel(rgbMatch[3]!),
    };
    return {
      rgb,
      appearance: relativeLuminance(rgb) >= 0.4 ? "light" : "dark",
    };
  }

  // Fallback: #rrggbb or #rrrrggggbbbb
  const hashMatch = /\x1b\]11;#([0-9a-f]{6}|[0-9a-f]{12})(?:\x07|\x1b\\)/i.exec(input);
  if (hashMatch) {
    const h = hashMatch[1]!;
    const step = h.length / 3;
    const rgb: RgbColor = {
      r: scaleX11HexChannel(h.slice(0, step)),
      g: scaleX11HexChannel(h.slice(step, step * 2)),
      b: scaleX11HexChannel(h.slice(step * 2, step * 3)),
    };
    return {
      rgb,
      appearance: relativeLuminance(rgb) >= 0.4 ? "light" : "dark",
    };
  }

  return null;
}

const OSC11_PREFIX = "\x1b]11;";
const MAX_PENDING_OSC11_LEN = 64;

/**
 * Strip complete OSC 11 responses from raw stdin input and buffer any incomplete `\x1b]11;...`
 * suffix without EVER delaying standalone `Esc` (`\x1b`) or CSI key sequences (`\x1b[...`).
 */
export function extractOsc11FromInput(
  chunk: string,
  pendingBuffer = "",
): Osc11FilterResult {
  const combined = pendingBuffer + chunk;
  let passthrough = "";
  let appearance: AppearanceMode | null = null;
  let backgroundRgb: RgbColor | null = null;
  let pending = "";
  let i = 0;

  while (i < combined.length) {
    const escIdx = combined.indexOf("\x1b]", i);
    if (escIdx === -1) {
      passthrough += combined.slice(i);
      break;
    }

    // Emit any regular input preceding `\x1b]`
    if (escIdx > i) {
      passthrough += combined.slice(i, escIdx);
    }

    const tail = combined.slice(escIdx);

    // Check if tail is still a partial prefix of "\x1b]11;" (e.g. "\x1b]", "\x1b]1", "\x1b]11")
    if (tail.length < OSC11_PREFIX.length) {
      if (OSC11_PREFIX.startsWith(tail)) {
        pending = tail;
        break;
      }
      // Definitely not OSC 11 -> pass through `\x1b]` and continue
      passthrough += "\x1b]";
      i = escIdx + 2;
      continue;
    }

    if (!tail.startsWith(OSC11_PREFIX)) {
      passthrough += "\x1b]";
      i = escIdx + 2;
      continue;
    }

    // Locate terminator: BEL (\x07) or ST (\x1b\\)
    let termEnd = -1;
    for (let j = OSC11_PREFIX.length; j < tail.length; j++) {
      const ch = tail[j]!;
      if (ch === "\x07") {
        termEnd = j + 1;
        break;
      }
      if (ch === "\x1b") {
        if (j + 1 < tail.length) {
          if (tail[j + 1] === "\\") {
            termEnd = j + 2;
            break;
          }
          // Unexpected ESC inside OSC -> abort buffering so user input isn't eaten
          termEnd = -2;
          break;
        }
        // Trailing ESC right at chunk boundary could be start of ST (\x1b\\)
        if (tail.length <= MAX_PENDING_OSC11_LEN) {
          pending = tail;
          i = combined.length;
          termEnd = -3;
        } else {
          termEnd = -2;
        }
        break;
      }
    }

    if (termEnd === -3) {
      break;
    }

    if (termEnd > 0) {
      const seq = tail.slice(0, termEnd);
      const parsed = parseOsc11Response(seq);
      if (parsed) {
        appearance = parsed.appearance;
        backgroundRgb = parsed.rgb;
      }
      i = escIdx + termEnd;
      continue;
    }

    if (termEnd === -1 && tail.length <= MAX_PENDING_OSC11_LEN) {
      // Incomplete OSC 11 sequence at end of chunk -> wait for next chunk
      pending = tail;
      break;
    }

    // Malformed / oversized OSC 11 without terminator -> pass through safely
    passthrough += "\x1b]";
    i = escIdx + 2;
  }

  return { passthrough, appearance, backgroundRgb, pending };
}

// ============================================================================
// Zero-Dep Minimal TOML Parser for Herdr `[theme]` / `[theme.custom.*]` / `[ui]`
// ============================================================================

type TomlScalar = string | boolean | Record<string, string>;

function stripInlineComment(raw: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#") {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

function unescapeTomlBasicString(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== "\\" || i + 1 >= inner.length) {
      out += ch;
      continue;
    }
    const next = inner[++i]!;
    switch (next) {
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "u": {
        const hex = inner.slice(i + 1, i + 5);
        if (/^[0-9a-f]{4}$/i.test(hex)) {
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 4;
        } else {
          out += "\\u";
        }
        break;
      }
      case "U": {
        const hex = inner.slice(i + 1, i + 9);
        if (/^[0-9a-f]{8}$/i.test(hex)) {
          const cp = parseInt(hex, 16);
          out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
          i += 8;
        } else {
          out += "\\U";
        }
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

function splitDottedKeyPath(raw: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuote === '"') {
      if (escaped) {
        cur += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inQuote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (inQuote === "'") {
      if (ch === "'") {
        inQuote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ".") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

function splitTopLevelCommas(raw: string): string[] {
  const items: string[] = [];
  let cur = "";
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inDouble) {
      cur += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
    } else if (ch === "'") {
      inSingle = true;
      cur += ch;
    } else if (ch === "{") {
      braceDepth += 1;
      cur += ch;
    } else if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      cur += ch;
    } else if (ch === "[") {
      bracketDepth += 1;
      cur += ch;
    } else if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      cur += ch;
    } else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      if (cur.trim()) items.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function findUnquotedEquals(line: string): number {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "=") return i;
  }
  return -1;
}

function parseTomlValue(rawValue: string): TomlScalar | null {
  const val = rawValue.trim();
  if (!val) return null;

  if (val === "true") return true;
  if (val === "false") return false;

  // Single-line triple-quoted basic string `"""..."""`
  if (val.startsWith('"""') && val.endsWith('"""') && val.length >= 6) {
    return unescapeTomlBasicString(val.slice(3, -3));
  }

  // Single-line triple-quoted literal string `'''...'''`
  if (val.startsWith("'''") && val.endsWith("'''") && val.length >= 6) {
    return val.slice(3, -3);
  }

  // Double-quoted basic string
  if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
    return unescapeTomlBasicString(val.slice(1, -1));
  }

  // Single-quoted literal string
  if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
    return val.slice(1, -1);
  }

  // Single-line inline table `{ k = "v", ... }`
  if (val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    const table: Record<string, string> = {};
    if (!inner) return table;
    for (const entry of splitTopLevelCommas(inner)) {
      const eq = findUnquotedEquals(entry);
      if (eq === -1) continue;
      const k = entry.slice(0, eq).trim().replace(/^['"]|['"]$/g, "");
      const parsed = parseTomlValue(entry.slice(eq + 1));
      if (k && typeof parsed === "string") {
        table[k] = parsed;
      }
    }
    return table;
  }

  return null;
}

function countBracketDelta(line: string): number {
  let delta = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#") break;
    else if (ch === "[") delta += 1;
    else if (ch === "]") delta -= 1;
  }
  return delta;
}

function assignPaletteColor(
  target: Record<string, ThemeColor>,
  rawKey: string,
  rawColor: string,
): void {
  const normalizedKey = rawKey.trim().toLowerCase().replace(/-/g, "_");
  if (!isHerdrPaletteKey(normalizedKey)) return;
  const parsed = parseThemeColor(rawColor);
  if (parsed) {
    target[normalizedKey] = parsed;
  }
}

/**
 * Parse relevant theme sections (`[theme]`, `[theme.custom]`, `[theme.custom.dark]`,
 * `[theme.custom.light]`, `[ui]`) from Herdr's `config.toml` content.
 * Resilient to unrelated sections, inline comments, multi-line strings/arrays, and malformed entries.
 */
export function parseHerdrConfigToml(content: string): HerdrThemeConfig {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  let name: string | undefined;
  let autoSwitch = false;
  let darkName: string | undefined;
  let lightName: string | undefined;
  let legacyUiAccent: string | undefined;
  const custom: Record<string, ThemeColor> = {};
  const customDark: Record<string, ThemeColor> = {};
  const customLight: Record<string, ThemeColor> = {};

  let currentSection: string[] = [];
  let multilineDelimiter: '"""' | "'''" | null = null;
  let pendingBracketDepth = 0;

  const applyField = (fullPath: string[], value: TomlScalar) => {
    const joined = fullPath.join(".");

    if (joined === "theme.name" && typeof value === "string") {
      const v = value.trim();
      name = v || undefined;
      return;
    }
    if (joined === "theme.auto_switch" && typeof value === "boolean") {
      autoSwitch = value;
      return;
    }
    if (joined === "theme.dark_name" && typeof value === "string") {
      const v = value.trim();
      darkName = v || undefined;
      return;
    }
    if (joined === "theme.light_name" && typeof value === "string") {
      const v = value.trim();
      lightName = v || undefined;
      return;
    }
    if (joined === "ui.accent" && typeof value === "string") {
      const v = value.trim();
      legacyUiAccent = v || undefined;
      return;
    }

    // Inline table forms: `[theme]` -> `custom = { ... }` or `[theme.custom]` -> `dark = { ... }`
    if (joined === "theme.custom" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        assignPaletteColor(custom, k, v);
      }
      return;
    }
    if (joined === "theme.custom.dark" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        assignPaletteColor(customDark, k, v);
      }
      return;
    }
    if (joined === "theme.custom.light" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        assignPaletteColor(customLight, k, v);
      }
      return;
    }

    if (typeof value !== "string") return;

    if (fullPath.length === 3 && fullPath[0] === "theme" && fullPath[1] === "custom") {
      assignPaletteColor(custom, fullPath[2]!, value);
      return;
    }
    if (
      fullPath.length === 4 &&
      fullPath[0] === "theme" &&
      fullPath[1] === "custom" &&
      fullPath[2] === "dark"
    ) {
      assignPaletteColor(customDark, fullPath[3]!, value);
      return;
    }
    if (
      fullPath.length === 4 &&
      fullPath[0] === "theme" &&
      fullPath[1] === "custom" &&
      fullPath[2] === "light"
    ) {
      assignPaletteColor(customLight, fullPath[3]!, value);
    }
  };

  for (const rawLine of lines) {
    // Skip lines inside multi-line strings ("""...""" or '''...''')
    if (multilineDelimiter) {
      const closeIdx = rawLine.indexOf(multilineDelimiter);
      if (closeIdx !== -1) {
        multilineDelimiter = null;
      }
      continue;
    }

    // Skip lines inside multi-line arrays in other sections
    if (pendingBracketDepth > 0) {
      pendingBracketDepth = Math.max(0, pendingBracketDepth + countBracketDelta(rawLine));
      continue;
    }

    const clean = stripInlineComment(rawLine);
    if (!clean) continue;

    // Table header `[section]` or array-of-tables `[[section]]`
    if (clean.startsWith("[")) {
      if (clean.startsWith("[[") && clean.endsWith("]]")) {
        currentSection = splitDottedKeyPath(clean.slice(2, -2));
        continue;
      }
      if (clean.endsWith("]")) {
        currentSection = splitDottedKeyPath(clean.slice(1, -1));
        continue;
      }
    }

    const eqIdx = findUnquotedEquals(clean);
    if (eqIdx === -1) continue;

    const lhs = clean.slice(0, eqIdx).trim();
    const rhs = clean.slice(eqIdx + 1).trim();
    if (!lhs || !rhs) continue;

    // Detect opening of multi-line strings that do not close on the same line
    if (rhs.startsWith('"""') && rhs.indexOf('"""', 3) === -1) {
      multilineDelimiter = '"""';
      continue;
    }
    if (rhs.startsWith("'''") && rhs.indexOf("'''", 3) === -1) {
      multilineDelimiter = "'''";
      continue;
    }

    // Track multi-line arrays so bracketed items inside them aren't mistaken for table headers
    if (rhs.startsWith("[")) {
      const delta = countBracketDelta(rhs);
      if (delta > 0) {
        pendingBracketDepth = delta;
      }
      continue;
    }

    const parsedValue = parseTomlValue(rhs);
    if (parsedValue === null) continue;

    const keyParts = splitDottedKeyPath(lhs);
    if (keyParts.length === 0) continue;

    applyField([...currentSection, ...keyParts], parsedValue);
  }

  return {
    name,
    autoSwitch,
    darkName,
    lightName,
    custom: custom as PartialHerdrPalette,
    customDark: customDark as PartialHerdrPalette,
    customLight: customLight as PartialHerdrPalette,
    legacyUiAccent,
  };
}

/**
 * Synchronously read & parse Herdr's `config.toml` (returns safe empty defaults if missing/unreadable).
 */
export function loadHerdrThemeConfig(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): HerdrThemeConfig {
  const configPath = options.configPath ?? resolveHerdrConfigPath(options.env, options.homeDir);
  try {
    if (!existsSync(configPath)) {
      return {
        autoSwitch: false,
        custom: {},
        customDark: {},
        customLight: {},
      };
    }
    const content = readFileSync(configPath, "utf8");
    return parseHerdrConfigToml(content);
  } catch {
    return {
      autoSwitch: false,
      custom: {},
      customDark: {},
      customLight: {},
    };
  }
}

/**
 * Resolve a compiled `DeckTheme` from a parsed `HerdrThemeConfig` and appearance polarity.
 *
 * Precedence (matching Herdr v0.9.5):
 *   1. Base palette (resolved via `auto_switch` sibling pairs or `[theme].name`, fallback `catppuccin` / `catppuccin-latte`)
 *   2. `[theme.custom]`
 *   3. Legacy `[ui].accent` (only when != `"cyan"` and `[theme.custom].accent` is unset)
 *   4. Mode override (`[theme.custom.dark]` or `[theme.custom.light]`, only when `auto_switch = true`)
 */
export function resolveThemeFromHerdrConfig(
  config: HerdrThemeConfig,
  appearance: AppearanceMode = "dark",
): DeckTheme {
  const baseName = config.name ?? DEFAULT_THEME_ID;
  let selectedName: string;

  if (config.autoSwitch) {
    const pair = getHerdrThemeSiblingPair(baseName);
    selectedName =
      appearance === "light"
        ? (config.lightName ?? pair.light)
        : (config.darkName ?? pair.dark);
  } else {
    selectedName = baseName;
  }

  const themeId = resolveBuiltinThemeId(selectedName);
  const overrides: Record<string, ThemeColor> = { ...config.custom };

  // Legacy `[ui].accent`: applied only when != "cyan" and `[theme.custom].accent` is unset
  if (
    overrides.accent === undefined &&
    config.legacyUiAccent !== undefined &&
    config.legacyUiAccent.trim().toLowerCase() !== "cyan"
  ) {
    const parsedLegacy = parseThemeColor(config.legacyUiAccent);
    if (parsedLegacy) {
      overrides.accent = parsedLegacy;
    }
  }

  // Mode-specific overrides apply only when `auto_switch = true`
  if (config.autoSwitch) {
    const modeOverrides = appearance === "light" ? config.customLight : config.customDark;
    Object.assign(overrides, modeOverrides);
  }

  return compileTheme(themeId, {
    sourceName: selectedName,
    overrides: overrides as PartialHerdrPalette,
  });
}

/**
 * Convenience one-shot synchronous loader for startup (zero-FOUC frame 1).
 */
export function loadActiveHerdrTheme(options: LoadHerdrThemeOptions = {}): DeckTheme {
  const env = options.env ?? process.env;
  const appearance = options.appearance ?? detectTerminalAppearanceFromEnv(env);
  const config = loadHerdrThemeConfig({
    configPath: options.configPath,
    env,
    homeDir: options.homeDir,
  });
  return resolveThemeFromHerdrConfig(config, appearance);
}

// ============================================================================
// Symlink-Safe, Atomic-Write-Safe Debounced Config Watcher
// ============================================================================

function findNearestExistingDir(dirPath: string): string | null {
  let cur = resolve(dirPath);
  while (true) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function tryRealpath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Watch Herdr's `config.toml` for live theme updates.
 * - Watches parent directory (and realpath target directory when symlinked) so atomic renames
 *   and symlink target edits are reliably detected on macOS and Linux.
 * - Debounces bursts (`debounceMs`, default 150ms) and deduplicates unchanged themes.
 */
export function watchHerdrConfig(
  onChange: (theme: DeckTheme, config: HerdrThemeConfig) => void,
  options: WatchHerdrConfigOptions = {},
): HerdrConfigWatcher {
  const env = options.env ?? process.env;
  const configPath = resolve(
    options.configPath ?? resolveHerdrConfigPath(env, options.homeDir),
  );
  const debounceMs = Math.max(10, options.debounceMs ?? 150);
  const getAppearance =
    options.getAppearance ?? (() => detectTerminalAppearanceFromEnv(env));

  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  const watchers = new Map<string, FSWatcher>();
  const expectedBases = new Map<string, string | null>();

  const readCurrent = (): { theme: DeckTheme; config: HerdrThemeConfig; signature: string } => {
    const config = loadHerdrThemeConfig({ configPath, env, homeDir: options.homeDir });
    const theme = resolveThemeFromHerdrConfig(config, getAppearance());
    return { theme, config, signature: getThemeSignature(theme) };
  };

  const initial = readCurrent();
  let lastSignature = initial.signature;
  let lastAutoSwitch = initial.config.autoSwitch;

  const triggerReload = (emitIfChanged: boolean): DeckTheme => {
    const current = readCurrent();
    refreshWatchDirs();
    const changed =
      current.signature !== lastSignature ||
      current.config.autoSwitch !== lastAutoSwitch;
    lastSignature = current.signature;
    lastAutoSwitch = current.config.autoSwitch;
    if (emitIfChanged && changed) {
      onChange(current.theme, current.config);
    }
    return current.theme;
  };

  const scheduleCheck = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      try {
        triggerReload(true);
      } catch (err) {
        options.onError?.(err);
      }
    }, debounceMs);
    debounceTimer.unref();
  };

  const computeDesiredWatchDirs = (): Map<string, string | null> => {
    // Map of directory path -> expected basename filter (null means accept any event in dir)
    const dirs = new Map<string, string | null>();
    const logicalDir = dirname(configPath);
    const logicalBase = basename(configPath);

    if (existsSync(logicalDir)) {
      dirs.set(logicalDir, logicalBase);
    } else {
      const ancestor = findNearestExistingDir(logicalDir);
      if (ancestor) {
        // Watch ancestor until the config directory itself is created
        dirs.set(ancestor, null);
      }
    }

    const realFile = tryRealpath(configPath);
    if (realFile) {
      const realDir = dirname(realFile);
      const realBase = basename(realFile);
      if (!dirs.has(realDir)) {
        dirs.set(realDir, realBase);
      } else if (dirs.get(realDir) !== realBase) {
        // Same directory contains both symlink & target with different names
        dirs.set(realDir, null);
      }
    }

    return dirs;
  };

  const refreshWatchDirs = () => {
    if (closed) return;
    const desired = computeDesiredWatchDirs();

    // Close watchers no longer needed
    for (const [dir, w] of watchers) {
      if (!desired.has(dir)) {
        w.close();
        watchers.delete(dir);
        expectedBases.delete(dir);
      }
    }

    // Update expected basename filters and add missing directory watchers
    for (const [dir, expectedBase] of desired) {
      expectedBases.set(dir, expectedBase);
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, (_eventType, filename) => {
          if (closed) return;
          const activeExpectedBase = expectedBases.get(dir) ?? null;
          if (activeExpectedBase !== null && typeof filename === "string" && filename.length > 0) {
            // Accept exact config basename or temp-sibling prefixes during atomic renames
            const base = basename(filename);
            if (base !== activeExpectedBase && !base.startsWith(`${activeExpectedBase}.`)) {
              return;
            }
          }
          scheduleCheck();
        });
        w.on("error", (err) => {
          w.close();
          watchers.delete(dir);
          expectedBases.delete(dir);
          options.onError?.(err);
        });
        w.unref();
        watchers.set(dir, w);
      } catch (err) {
        options.onError?.(err);
      }
    }
  };

  refreshWatchDirs();

  return {
    configPath,
    reload: () => triggerReload(true),
    close: () => {
      if (closed) return;
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const w of watchers.values()) {
        w.close();
      }
      watchers.clear();
    },
  };
}
