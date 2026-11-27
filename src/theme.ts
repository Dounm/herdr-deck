// Core multi-theme palette definitions, color parsing, contrast safety, and precompiled SGR tokens for Herdr Deck.
// Zero runtime dependencies; aligned strictly to Herdr v0.9.5's 19-token palette model.

const ESC = "\x1b[";
const DEFAULT_FG_SGR = `${ESC}39m`;

export type Ansi16Name =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "gray"
  | "dark_gray"
  | "light_red"
  | "light_green"
  | "light_yellow"
  | "light_blue"
  | "light_magenta"
  | "light_cyan"
  | "white";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type ThemeColor =
  | { readonly kind: "reset" }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number }
  | { readonly kind: "ansi16"; readonly name: Ansi16Name }
  | { readonly kind: "indexed"; readonly index: number };

export type BuiltinThemeId =
  | "catppuccin"
  | "dracula"
  | "tokyo-night"
  | "gruvbox"
  | "nord"
  | "one-dark"
  | "catppuccin-latte"
  | "terminal";

export type ThemePolarity = "dark" | "light" | "terminal";
export type AppearanceMode = "dark" | "light";

export type HerdrPaletteKey =
  | "accent"
  | "panel_bg"
  | "sidebar_bg"
  | "active_row_bg"
  | "selection_bg"
  | "surface0"
  | "surface1"
  | "surface_dim"
  | "overlay0"
  | "overlay1"
  | "text"
  | "subtext0"
  | "mauve"
  | "green"
  | "yellow"
  | "red"
  | "blue"
  | "teal"
  | "peach";

export type HerdrPalette = Record<HerdrPaletteKey, ThemeColor>;
export type PartialHerdrPalette = Partial<Record<HerdrPaletteKey, ThemeColor>>;

export interface BuiltinThemeDefinition {
  readonly id: BuiltinThemeId;
  readonly displayName: string;
  readonly polarity: ThemePolarity;
  readonly palette: Readonly<HerdrPalette>;
}

export interface CompileThemeOptions {
  readonly sourceName?: string;
  readonly overrides?: PartialHerdrPalette;
}

export interface DeckTheme {
  /** Canonical built-in theme ID (one of the 8 built-in themes). */
  readonly id: BuiltinThemeId;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Original theme name requested from Herdr config before fallback mapping. */
  readonly sourceName: string;
  /** Polarity: "dark", "light", or "terminal" (native ANSI 16). */
  readonly polarity: ThemePolarity;
  /** True when the active theme is a light theme (e.g. catppuccin-latte). */
  readonly isLight: boolean;
  /** True when the base theme is the native ANSI-16 `terminal` theme. */
  readonly isTerminal: boolean;
  /** Effective resolved 19-token Herdr palette (after custom/legacy overrides). */
  readonly palette: Readonly<HerdrPalette>;

  // --- Backgrounds (transparent canvas = ""; emphasis layers precompiled) ---
  /** Empty canvas & card interiors — always "" (inherit Herdr terminal background). */
  readonly bgCanvas: string;
  /** Top bar gap, footer bar, and cheatsheet modal backdrop. */
  readonly bgBar: string;
  /** Top bar status & filter pills. */
  readonly bgPill: string;
  /** Top-left brand badge `◈ HERDR DECK` background. */
  readonly bgBrand: string;
  /** Selected non-urgent agent card row & active inline reply/rename input row. */
  readonly bgSelected: string;
  /** Urgent top pill, preview `! 待审批` badge, selected `needs_you` row, blocked inline prompt. */
  readonly bgUrgent: string;
  /** Cheatsheet modal overlay card surface. */
  readonly bgModal: string;

  // --- Foregrounds (on transparent canvas) ---
  /** Primary text (active input fallback, pickNameColor fallback, general primary body). */
  readonly fgPrimary: string;
  /** Secondary text (unfocused card titles, breadcrumbs, focus dot `•`, inline key hints). */
  readonly fgSecondary: string;
  /** Muted text (counts, hints, unselected summary, cwd, loading, ellipsis `…`). */
  readonly fgMuted: string;
  /** Subtle text (unselected meta). */
  readonly fgSubtle: string;

  // --- Surface-specific High-Contrast Foregrounds ---
  /** Brand badge text on `bgBrand` (auto-contrasting). */
  readonly fgBrand: string;
  /** Footer shortcut `[key]` fg on `bgBar`. */
  readonly fgBarKey: string;
  /** Footer description fg on `bgBar`. */
  readonly fgBarDesc: string;
  /** Active filter pill fg on `bgPill` (`[f] 全部`). */
  readonly fgPill: string;
  /** Muted status pill fg on `bgPill` (`· 0 阻塞`, `○ N 空闲`). */
  readonly fgPillMuted: string;
  /** Review status pill fg on `bgPill` (`✓ N 待审阅`). */
  readonly fgPillReview: string;
  /** Working status pill fg on `bgPill` (`⠋ N 运行中`). */
  readonly fgPillWorking: string;
  /** Primary text on `bgSelected` (active input text, selected summary). */
  readonly fgOnSelected: string;
  /** Secondary/meta text on `bgSelected` (selected card meta, focus dot). */
  readonly fgOnSelectedMuted: string;
  /** Divider `│` on `bgSelected`. */
  readonly fgOnSelectedDivider: string;
  /** Urgent badge/headline fg on `bgUrgent` (`! N 待审批`, `!` icon on selected urgent row). */
  readonly fgUrgentBadge: string;
  /** Body text on `bgUrgent` (blocked quick-approval prompt, selected urgent summary). */
  readonly fgOnUrgent: string;
  /** Accent/timer/prompt glyph on `bgUrgent` (`⚑ 3m`, `❯`, selected urgent `▌` bar). */
  readonly fgUrgentAccent: string;
  /** Secondary/meta/divider text on `bgUrgent` (selected urgent row meta & `│`). */
  readonly fgOnUrgentMuted: string;
  /** Optional title/machine fg override on `bgUrgent` in `terminal` mode ("" on TrueColor themes). */
  readonly fgUrgentTitleOverride: string;
  /** Modal section heading on `bgModal` (`▸ 导航与跳转`). */
  readonly fgModalHeading: string;
  /** Modal shortcut key column on `bgModal`. */
  readonly fgModalKey: string;
  /** Modal description text on `bgModal`. */
  readonly fgModalText: string;
  /** Modal muted hint (`? / Esc 关闭`) on `bgModal`. */
  readonly fgModalMuted: string;

  // --- Borders & Structural Chrome ---
  /** Unfocused card borders, group horizontal rules `───`, unselected `│` divider. */
  readonly borderDefault: string;
  /** Focused list card border/title, cheatsheet modal border/title. */
  readonly borderFocus: string;
  /** Blocked preview card border. */
  readonly borderUrgent: string;
  /** Reply mode border/title/prompt `❯`. */
  readonly borderReply: string;
  /** Rename mode border/title/prompt `❯`. */
  readonly borderRename: string;
  /** Blocked inline-reply card border/title. */
  readonly borderBlockedAction: string;

  // --- Attention Status Colors (on transparent canvas) ---
  /** `NEEDS YOU` group header, `!` icon (unselected). */
  readonly statusUrgent: string;
  /** `READY FOR REVIEW` group header, `✓` icon, review age, Inbox Zero. */
  readonly statusReview: string;
  /** `WORKING` group header, spinner icon, working timer, preview agent name. */
  readonly statusWorking: string;
  /** `IDLE` group header, `○` icon. */
  readonly statusIdle: string;

  // --- Accents, Remote & Git ---
  /** Primary theme accent (selection `▌` cursor bar on non-urgent rows, focused highlights). */
  readonly accent: string;
  /** Secondary warm accent (unselected blocked timer `⚑`). */
  readonly accentWarm: string;
  /** Remote `@machine` badge color (`mauve`). */
  readonly accentRemote: string;
  /** Git branch `⎇` color (`teal`). */
  readonly gitBranch: string;
  /** Git dirty files `*N` color (`yellow`). */
  readonly gitDirty: string;
  /** Git ahead `↑N` color (`green`). */
  readonly gitAhead: string;
  /** Git behind `↓N` color (`red`). */
  readonly gitBehind: string;

  // --- Toast Feedback ---
  readonly toastInfo: string;
  readonly toastOk: string;
  readonly toastWarn: string;
  readonly toastError: string;

  // --- Deterministic Agent Name Hash Palette (6 colors) ---
  /** 6-color FNV-1a palette for `pickNameColor(name, theme)` (blue, teal, mauve, yellow, green, peach). */
  readonly namePalette: readonly [string, string, string, string, string, string];
}

export const HERDR_PALETTE_KEYS: readonly HerdrPaletteKey[] = [
  "accent",
  "panel_bg",
  "sidebar_bg",
  "active_row_bg",
  "selection_bg",
  "surface0",
  "surface1",
  "surface_dim",
  "overlay0",
  "overlay1",
  "text",
  "subtext0",
  "mauve",
  "green",
  "yellow",
  "red",
  "blue",
  "teal",
  "peach",
] as const;

const PALETTE_KEY_SET: ReadonlySet<string> = new Set(HERDR_PALETTE_KEYS);

export function isHerdrPaletteKey(key: string): key is HerdrPaletteKey {
  return PALETTE_KEY_SET.has(key);
}

export const BUILTIN_THEME_IDS: readonly BuiltinThemeId[] = [
  "catppuccin",
  "dracula",
  "tokyo-night",
  "gruvbox",
  "nord",
  "one-dark",
  "catppuccin-latte",
  "terminal",
] as const;

export const DEFAULT_THEME_ID: BuiltinThemeId = "catppuccin";

// Standard ANSI 16 SGR codes matching ratatui::style::Color
const ANSI16_FG_CODES: Readonly<Record<Ansi16Name, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 37,
  dark_gray: 90,
  light_red: 91,
  light_green: 92,
  light_yellow: 93,
  light_blue: 94,
  light_magenta: 95,
  light_cyan: 96,
  white: 97,
};

const ANSI16_BG_CODES: Readonly<Record<Ansi16Name, number>> = {
  black: 40,
  red: 41,
  green: 42,
  yellow: 43,
  blue: 44,
  magenta: 45,
  cyan: 46,
  gray: 47,
  dark_gray: 100,
  light_red: 101,
  light_green: 102,
  light_yellow: 103,
  light_blue: 104,
  light_magenta: 105,
  light_cyan: 106,
  white: 107,
};

const ANSI16_NAME_ALIASES: Readonly<Record<string, Ansi16Name>> = {
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  purple: "magenta",
  cyan: "cyan",
  aqua: "cyan",
  gray: "gray",
  grey: "gray",
  lightgray: "gray",
  lightgrey: "gray",
  silver: "gray",
  darkgray: "dark_gray",
  darkgrey: "dark_gray",
  brightblack: "dark_gray",
  lightblack: "dark_gray",
  lightred: "light_red",
  brightred: "light_red",
  lightgreen: "light_green",
  brightgreen: "light_green",
  lightyellow: "light_yellow",
  brightyellow: "light_yellow",
  lightblue: "light_blue",
  brightblue: "light_blue",
  lightmagenta: "light_magenta",
  brightmagenta: "light_magenta",
  lightpurple: "light_magenta",
  brightpurple: "light_magenta",
  lightcyan: "light_cyan",
  brightcyan: "light_cyan",
  white: "white",
  brightwhite: "white",
  lightwhite: "white",
};

const RESET_COLOR: ThemeColor = Object.freeze({ kind: "reset" });

function rgb(hex: string): ThemeColor {
  const parsed = parseThemeColor(hex);
  if (!parsed || parsed.kind !== "rgb") {
    throw new Error(`Invalid built-in hex color: ${hex}`);
  }
  return parsed;
}

function ansi16(name: Ansi16Name): ThemeColor {
  return Object.freeze({ kind: "ansi16", name });
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Parse a Herdr/ratatui color string into a structured `ThemeColor`.
 * Supports `#rrggbb`, `#rgb`, `rgb(r, g, b)`, `reset`, standard ANSI 16 color names
 * (case-insensitive, `_` / `-` / space tolerant), and `0..255` indexed colors.
 */
export function parseThemeColor(raw: string): ThemeColor | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "reset" || lower === "default") {
    return RESET_COLOR;
  }

  // #rrggbb
  const hex6 = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex6) {
    const h = hex6[1]!;
    return {
      kind: "rgb",
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  // #rgb shorthand
  const hex3 = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (hex3) {
    const h = hex3[1]!;
    return {
      kind: "rgb",
      r: parseInt(h[0]! + h[0]!, 16),
      g: parseInt(h[1]! + h[1]!, 16),
      b: parseInt(h[2]! + h[2]!, 16),
    };
  }

  // rgb(r, g, b)
  const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    if (r <= 255 && g <= 255 && b <= 255) {
      return { kind: "rgb", r, g, b };
    }
    return null;
  }

  // Bare 0..255 indexed ANSI color
  if (/^\d{1,3}$/.test(trimmed)) {
    const idx = Number(trimmed);
    if (idx >= 0 && idx <= 255) {
      return { kind: "indexed", index: idx };
    }
    return null;
  }

  // Standard ANSI 16 color names (tolerant of _, -, and whitespace)
  const normalizedName = lower.replace(/[_\-\s]+/g, "");
  const mappedAnsi = ANSI16_NAME_ALIASES[normalizedName];
  if (mappedAnsi) {
    return { kind: "ansi16", name: mappedAnsi };
  }

  return null;
}

/**
 * Compile a `ThemeColor` to a foreground SGR escape string.
 * `reset` emits `\x1b[39m` (default fg) so mid-span fg transitions restore default foreground cleanly
 * without clobbering active background or bold attributes.
 */
export function colorToFgSgr(color: ThemeColor): string {
  switch (color.kind) {
    case "reset":
      return DEFAULT_FG_SGR;
    case "rgb":
      return `${ESC}38;2;${color.r};${color.g};${color.b}m`;
    case "ansi16":
      return `${ESC}${ANSI16_FG_CODES[color.name]}m`;
    case "indexed":
      return `${ESC}38;5;${color.index}m`;
  }
}

/**
 * Compile a `ThemeColor` to a background SGR escape string.
 * `reset` emits `""` (transparent — inherits host Herdr terminal background).
 */
export function colorToBgSgr(color: ThemeColor): string {
  switch (color.kind) {
    case "reset":
      return "";
    case "rgb":
      return `${ESC}48;2;${color.r};${color.g};${color.b}m`;
    case "ansi16":
      return `${ESC}${ANSI16_BG_CODES[color.name]}m`;
    case "indexed":
      return `${ESC}48;5;${color.index}m`;
  }
}

function linearizeChannel(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Compute WCAG 2.1 relative luminance in `[0, 1]`. */
export function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * linearizeChannel(color.r) +
    0.7152 * linearizeChannel(color.g) +
    0.0722 * linearizeChannel(color.b)
  );
}

/** Compute WCAG 2.1 contrast ratio in `[1, 21]`. */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Alpha-blend `overlay` onto `base` (`alpha` in `[0, 1]`). */
export function blendRgb(base: RgbColor, overlay: RgbColor, alpha: number): RgbColor {
  const t = Math.max(0, Math.min(1, alpha));
  return {
    r: clampByte(base.r * (1 - t) + overlay.r * t),
    g: clampByte(base.g * (1 - t) + overlay.g * t),
    b: clampByte(base.b * (1 - t) + overlay.b * t),
  };
}

/**
 * If `fg` already satisfies `contrastRatio(fg, bg) >= minRatio`, returns `fg` untouched.
 * Otherwise applies the minimal lightness shift toward black (on light bg) or white (on dark bg)
 * while preserving hue until `minRatio` is met.
 */
export function ensureRgbContrast(fg: RgbColor, bg: RgbColor, minRatio: number): RgbColor {
  if (contrastRatio(fg, bg) >= minRatio) {
    return fg;
  }
  const bgLum = relativeLuminance(bg);
  const target: RgbColor = bgLum > 0.35 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  if (contrastRatio(target, bg) < minRatio) {
    // Fallback to whichever extreme maximizes contrast
    const black: RgbColor = { r: 0, g: 0, b: 0 };
    const white: RgbColor = { r: 255, g: 255, b: 255 };
    return contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const candidate = blendRgb(fg, target, mid);
    if (contrastRatio(candidate, bg) >= minRatio) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return blendRgb(fg, target, hi);
}

function asRgb(color: ThemeColor): RgbColor | null {
  return color.kind === "rgb" ? { r: color.r, g: color.g, b: color.b } : null;
}

function rgbColor(c: RgbColor): ThemeColor {
  return { kind: "rgb", r: c.r, g: c.g, b: c.b };
}

function ensureThemeColorContrast(
  fg: ThemeColor,
  bg: ThemeColor,
  minRatio: number,
): ThemeColor {
  const fgRgb = asRgb(fg);
  const bgRgb = asRgb(bg);
  if (!fgRgb || !bgRgb) return fg;
  return rgbColor(ensureRgbContrast(fgRgb, bgRgb, minRatio));
}

function ensureThemeColorContrastAcross(
  fg: ThemeColor,
  backgrounds: readonly ThemeColor[],
  minRatio: number,
): ThemeColor {
  let current = fg;
  for (let pass = 0; pass < 2; pass++) {
    let adjusted = false;
    for (const bg of backgrounds) {
      const fgRgb = asRgb(current);
      const bgRgb = asRgb(bg);
      if (!fgRgb || !bgRgb) continue;
      if (contrastRatio(fgRgb, bgRgb) < minRatio) {
        current = rgbColor(ensureRgbContrast(fgRgb, bgRgb, minRatio));
        adjusted = true;
      }
    }
    if (!adjusted) break;
  }
  return current;
}

function pickContrastingBrandFg(
  bgColor: ThemeColor,
  panelBg: ThemeColor,
  text: ThemeColor,
  isTerminal: boolean,
): ThemeColor {
  const bgRgb = asRgb(bgColor);
  if (!bgRgb) {
    // ANSI / terminal fallback: bright white contrasts sharply with ANSI Blue / colored brand pills
    if (bgColor.kind === "ansi16") {
      if (bgColor.name === "white" || bgColor.name === "light_yellow" || bgColor.name === "yellow" || bgColor.name === "gray" || bgColor.name === "light_cyan") {
        return ansi16("black");
      }
      return ansi16("white");
    }
    return isTerminal ? ansi16("white") : text;
  }

  const candidates: RgbColor[] = [];
  const panelRgb = asRgb(panelBg);
  const textRgb = asRgb(text);
  if (panelRgb) candidates.push(panelRgb);
  if (textRgb) candidates.push(textRgb);

  let best: RgbColor | null = null;
  let bestRatio = 0;
  for (const c of candidates) {
    const ratio = contrastRatio(c, bgRgb);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }

  if (best && bestRatio >= 4.5) {
    return rgbColor(best);
  }

  const white: RgbColor = { r: 255, g: 255, b: 255 };
  const dark: RgbColor = { r: 17, g: 17, b: 27 };
  return rgbColor(contrastRatio(white, bgRgb) >= contrastRatio(dark, bgRgb) ? white : dark);
}

// ============================================================================
// Herdr v0.9.5 Verified 8 Built-in 19-Token Palettes
// ============================================================================

export const BUILTIN_THEME_DEFINITIONS: Readonly<Record<BuiltinThemeId, BuiltinThemeDefinition>> =
  Object.freeze({
    catppuccin: Object.freeze({
      id: "catppuccin",
      displayName: "Catppuccin Mocha",
      polarity: "dark",
      palette: Object.freeze({
        accent: rgb("#89b4fa"),
        panel_bg: rgb("#181825"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#1e1e2e"),
        selection_bg: rgb("#313244"),
        surface0: rgb("#313244"),
        surface1: rgb("#45475a"),
        surface_dim: rgb("#1e1e2e"),
        overlay0: rgb("#6c7086"),
        overlay1: rgb("#7f849c"),
        text: rgb("#cdd6f4"),
        subtext0: rgb("#a6adc8"),
        mauve: rgb("#cba6f7"),
        green: rgb("#a6e3a1"),
        yellow: rgb("#f9e2af"),
        red: rgb("#f38ba8"),
        blue: rgb("#89b4fa"),
        teal: rgb("#94e2d5"),
        peach: rgb("#fab387"),
      }),
    }),
    dracula: Object.freeze({
      id: "dracula",
      displayName: "Dracula",
      polarity: "dark",
      palette: Object.freeze({
        accent: rgb("#bd93f9"),
        panel_bg: rgb("#282a36"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#373c52"),
        selection_bg: rgb("#463f5d"),
        surface0: rgb("#44475a"),
        surface1: rgb("#6272a4"),
        surface_dim: rgb("#282a36"),
        overlay0: rgb("#6272a4"),
        overlay1: rgb("#828cb4"),
        text: rgb("#f8f8f2"),
        subtext0: rgb("#d2d2dc"),
        mauve: rgb("#ff79c6"),
        green: rgb("#50fa7b"),
        yellow: rgb("#f1fa8c"),
        red: rgb("#ff5555"),
        blue: rgb("#8be9fd"),
        teal: rgb("#8be9fd"),
        peach: rgb("#ffb86c"),
      }),
    }),
    "tokyo-night": Object.freeze({
      id: "tokyo-night",
      displayName: "Tokyo Night",
      polarity: "dark",
      palette: Object.freeze({
        accent: rgb("#7aa2f7"),
        panel_bg: rgb("#1a1b26"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#232636"),
        selection_bg: rgb("#2d3650"),
        surface0: rgb("#24283b"),
        surface1: rgb("#414868"),
        surface_dim: rgb("#1a1b26"),
        overlay0: rgb("#565f89"),
        overlay1: rgb("#697196"),
        text: rgb("#c0caf5"),
        subtext0: rgb("#a9b1d6"),
        mauve: rgb("#bb9af7"),
        green: rgb("#9ece6a"),
        yellow: rgb("#e0af68"),
        red: rgb("#f7768e"),
        blue: rgb("#7aa2f7"),
        teal: rgb("#7dcfff"),
        peach: rgb("#ff9e64"),
      }),
    }),
    gruvbox: Object.freeze({
      id: "gruvbox",
      displayName: "Gruvbox Dark",
      polarity: "dark",
      palette: Object.freeze({
        accent: rgb("#d79921"),
        panel_bg: rgb("#282828"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#323130"),
        selection_bg: rgb("#4b3f27"),
        surface0: rgb("#3c3836"),
        surface1: rgb("#504945"),
        surface_dim: rgb("#282828"),
        overlay0: rgb("#928374"),
        overlay1: rgb("#a89984"),
        text: rgb("#ebdbb2"),
        subtext0: rgb("#d5c4a1"),
        mauve: rgb("#d3869b"),
        green: rgb("#b8bb26"),
        yellow: rgb("#fabd2f"),
        red: rgb("#fb4934"),
        blue: rgb("#83a598"),
        teal: rgb("#8ec07c"),
        peach: rgb("#fe8019"),
      }),
    }),
    nord: Object.freeze({
      id: "nord",
      displayName: "Nord",
      polarity: "dark",
      palette: Object.freeze({
        accent: rgb("#88c0d0"),
        panel_bg: rgb("#2e3440"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#434c5e"),
        selection_bg: rgb("#40505d"),
        surface0: rgb("#3b4252"),
        surface1: rgb("#434c5e"),
        surface_dim: rgb("#2e3440"),
        overlay0: rgb("#4c566a"),
        overlay1: rgb("#646e82"),
        text: rgb("#eceff4"),
        subtext0: rgb("#d8dee9"),
        mauve: rgb("#b48ead"),
        green: rgb("#a3be8c"),
        yellow: rgb("#ebcb8b"),
        red: rgb("#bf616a"),
        blue: rgb("#81a1c1"),
        teal: rgb("#8fbcbb"),
        peach: rgb("#d08770"),
      }),
    }),
    "one-dark": Object.freeze({
      id: "one-dark",
      displayName: "One Dark",
      polarity: "dark",
      palette: Object.freeze({
        accent: rgb("#61afef"),
        panel_bg: rgb("#282c34"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#313640"),
        selection_bg: rgb("#334659"),
        surface0: rgb("#2c313a"),
        surface1: rgb("#3e4451"),
        surface_dim: rgb("#282c34"),
        overlay0: rgb("#5c6370"),
        overlay1: rgb("#737a87"),
        text: rgb("#abb2bf"),
        subtext0: rgb("#969ca8"),
        mauve: rgb("#c678dd"),
        green: rgb("#98c379"),
        yellow: rgb("#e5c07b"),
        red: rgb("#e06c75"),
        blue: rgb("#61afef"),
        teal: rgb("#56b6c2"),
        peach: rgb("#d19a66"),
      }),
    }),
    "catppuccin-latte": Object.freeze({
      id: "catppuccin-latte",
      displayName: "Catppuccin Latte",
      polarity: "light",
      palette: Object.freeze({
        accent: rgb("#1e66f5"),
        panel_bg: rgb("#eff1f5"),
        sidebar_bg: RESET_COLOR,
        active_row_bg: rgb("#e6e9ef"),
        selection_bg: rgb("#bdd0f5"),
        surface0: rgb("#ccd0da"),
        surface1: rgb("#bcc0cc"),
        surface_dim: rgb("#e6e9ef"),
        overlay0: rgb("#9ca0b0"),
        overlay1: rgb("#8c8fa1"),
        text: rgb("#4c4f69"),
        subtext0: rgb("#6c6f85"),
        mauve: rgb("#8839ef"),
        green: rgb("#40a02b"),
        yellow: rgb("#df8e1d"),
        red: rgb("#d20f39"),
        blue: rgb("#1e66f5"),
        teal: rgb("#179299"),
        peach: rgb("#fe640b"),
      }),
    }),
    terminal: Object.freeze({
      id: "terminal",
      displayName: "Terminal",
      polarity: "terminal",
      palette: Object.freeze({
        accent: ansi16("blue"),
        panel_bg: RESET_COLOR,
        sidebar_bg: RESET_COLOR,
        active_row_bg: ansi16("dark_gray"),
        selection_bg: RESET_COLOR,
        surface0: RESET_COLOR,
        surface1: ansi16("dark_gray"),
        surface_dim: ansi16("dark_gray"),
        overlay0: ansi16("gray"),
        overlay1: ansi16("white"),
        text: RESET_COLOR,
        subtext0: ansi16("gray"),
        mauve: ansi16("gray"),
        green: ansi16("green"),
        yellow: ansi16("yellow"),
        red: ansi16("light_red"),
        blue: ansi16("blue"),
        teal: ansi16("cyan"),
        peach: ansi16("yellow"),
      }),
    }),
  });

// ============================================================================
// Theme Name Normalization, Aliases, Fallbacks & Herdr v0.9.5 Sibling Pairs
// ============================================================================

const THEME_NAME_ALIASES: Readonly<Record<string, BuiltinThemeId>> = {
  // 6 dark built-ins & aliases
  catppuccin: "catppuccin",
  "catppuccin-mocha": "catppuccin",
  mocha: "catppuccin",
  dracula: "dracula",
  "tokyo-night": "tokyo-night",
  tokyonight: "tokyo-night",
  gruvbox: "gruvbox",
  "gruvbox-dark": "gruvbox",
  nord: "nord",
  "one-dark": "one-dark",
  onedark: "one-dark",

  // Unified light built-in & ALL Herdr v0.9.5 light themes
  "catppuccin-latte": "catppuccin-latte",
  latte: "catppuccin-latte",
  light: "catppuccin-latte",
  "tokyo-night-day": "catppuccin-latte",
  "tokyo-day": "catppuccin-latte",
  "tokyonight-day": "catppuccin-latte",
  "gruvbox-light": "catppuccin-latte",
  "one-light": "catppuccin-latte",
  onelight: "catppuccin-latte",
  "solarized-light": "catppuccin-latte",
  "kanagawa-lotus": "catppuccin-latte",
  lotus: "catppuccin-latte",
  "rose-pine-dawn": "catppuccin-latte",
  "rosepine-dawn": "catppuccin-latte",
  dawn: "catppuccin-latte",

  // Pure ANSI 16 native terminal theme
  terminal: "terminal",
};

const HERDR_SIBLING_PAIRS: Readonly<Record<string, { readonly dark: string; readonly light: string }>> = {
  // Catppuccin
  catppuccin: { dark: "catppuccin", light: "catppuccin-latte" },
  "catppuccin-mocha": { dark: "catppuccin", light: "catppuccin-latte" },
  mocha: { dark: "catppuccin", light: "catppuccin-latte" },
  "catppuccin-latte": { dark: "catppuccin", light: "catppuccin-latte" },
  latte: { dark: "catppuccin", light: "catppuccin-latte" },

  // Tokyo Night
  "tokyo-night": { dark: "tokyo-night", light: "tokyo-night-day" },
  tokyonight: { dark: "tokyo-night", light: "tokyo-night-day" },
  "tokyo-night-day": { dark: "tokyo-night", light: "tokyo-night-day" },
  "tokyo-day": { dark: "tokyo-night", light: "tokyo-night-day" },
  "tokyonight-day": { dark: "tokyo-night", light: "tokyo-night-day" },

  // Gruvbox
  gruvbox: { dark: "gruvbox", light: "gruvbox-light" },
  "gruvbox-dark": { dark: "gruvbox", light: "gruvbox-light" },
  "gruvbox-light": { dark: "gruvbox", light: "gruvbox-light" },

  // One Dark / Light
  "one-dark": { dark: "one-dark", light: "one-light" },
  onedark: { dark: "one-dark", light: "one-light" },
  "one-light": { dark: "one-dark", light: "one-light" },
  onelight: { dark: "one-dark", light: "one-light" },

  // Solarized (dark falls back to catppuccin; light falls back to catppuccin-latte)
  solarized: { dark: "solarized", light: "solarized-light" },
  "solarized-dark": { dark: "solarized", light: "solarized-light" },
  "solarized-light": { dark: "solarized", light: "solarized-light" },

  // Kanagawa
  kanagawa: { dark: "kanagawa", light: "kanagawa-lotus" },
  "kanagawa-lotus": { dark: "kanagawa", light: "kanagawa-lotus" },
  lotus: { dark: "kanagawa", light: "kanagawa-lotus" },

  // Rosé Pine
  "rose-pine": { dark: "rose-pine", light: "rose-pine-dawn" },
  rosepine: { dark: "rose-pine", light: "rose-pine-dawn" },
  "rose-pine-dawn": { dark: "rose-pine", light: "rose-pine-dawn" },
  "rosepine-dawn": { dark: "rose-pine", light: "rose-pine-dawn" },
  dawn: { dark: "rose-pine", light: "rose-pine-dawn" },
};

export function normalizeThemeName(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

/**
 * Map any Herdr theme name (or alias) to one of the 8 built-in `BuiltinThemeId`s.
 * All Herdr light themes map to `catppuccin-latte`; unsupported dark/unknown names fall back to `catppuccin`.
 */
export function resolveBuiltinThemeId(rawName: string | undefined | null): BuiltinThemeId {
  const normalized = normalizeThemeName(rawName);
  if (!normalized) return DEFAULT_THEME_ID;
  return THEME_NAME_ALIASES[normalized] ?? DEFAULT_THEME_ID;
}

/**
 * Return Herdr v0.9.5's `(dark, light)` sibling pair for `auto_switch = true` when
 * `dark_name` / `light_name` are omitted.
 */
export function getHerdrThemeSiblingPair(
  rawName: string | undefined | null,
): { dark: string; light: string } {
  const normalized = normalizeThemeName(rawName) || DEFAULT_THEME_ID;
  const pair = HERDR_SIBLING_PAIRS[normalized];
  if (pair) {
    return { dark: pair.dark, light: pair.light };
  }
  return { dark: normalized, light: normalized };
}

// ============================================================================
// Theme Compiler (Precompiled SGR Escape Strings + Contrast Verification)
// ============================================================================

/**
 * Compile a built-in theme (with optional `[theme.custom]` / `[ui].accent` overrides) into
 * precompiled semantic ANSI SGR strings for zero-allocation hot-path rendering.
 */
export function compileTheme(
  id: BuiltinThemeId,
  options: CompileThemeOptions = {},
): DeckTheme {
  const def = BUILTIN_THEME_DEFINITIONS[id];
  const merged: HerdrPalette = { ...def.palette };
  if (options.overrides) {
    for (const key of HERDR_PALETTE_KEYS) {
      const val = options.overrides[key];
      if (val !== undefined) {
        merged[key] = val;
      }
    }
  }
  const palette: Readonly<HerdrPalette> = Object.freeze(merged);

  const isLight = def.polarity === "light";
  const isTerminal = def.id === "terminal";

  // 1. Resolve emphasis background ThemeColors (card interiors & empty canvas remain transparent "")
  const bgBarColor: ThemeColor = isTerminal
    ? palette.panel_bg
    : isLight
      ? palette.surface0
      : palette.panel_bg;

  const bgPillColor: ThemeColor = isTerminal
    ? palette.surface0.kind !== "reset"
      ? palette.surface0
      : palette.surface1
    : isLight
      ? palette.panel_bg
      : palette.surface0;

  const bgBrandColor: ThemeColor = palette.accent;

  const bgSelectedColor: ThemeColor =
    palette.selection_bg.kind !== "reset"
      ? palette.selection_bg
      : palette.active_row_bg;

  const bgModalColor: ThemeColor = isTerminal
    ? palette.panel_bg
    : isLight
      ? palette.panel_bg
      : palette.active_row_bg;

  // Derive bgUrgent dynamically by blending red into panel_bg when both are RGB;
  // in terminal mode (panel_bg=Reset, red=LightRed), emit standard ANSI Red (\x1b[41m) — ZERO 48;2;!
  const panelRgb = asRgb(palette.panel_bg);
  const redRgb = asRgb(palette.red);
  let bgUrgentColor: ThemeColor;
  let urgentUsesAnsiRedBg = false;
  if (panelRgb && redRgb) {
    bgUrgentColor = rgbColor(blendRgb(panelRgb, redRgb, isLight ? 0.14 : 0.22));
  } else if (redRgb) {
    // User explicitly configured an RGB red override on terminal theme
    bgUrgentColor = palette.red;
  } else {
    bgUrgentColor = ansi16("red");
    urgentUsesAnsiRedBg = true;
  }

  // 2. Canvas reference background for contrast checks on transparent canvas (RGB themes only)
  const canvasRefBg: ThemeColor = palette.panel_bg;

  // Canvas foreground hierarchy
  const fgPrimaryColor = ensureThemeColorContrast(palette.text, canvasRefBg, 4.5);
  const fgSecondaryColor = ensureThemeColorContrast(palette.subtext0, canvasRefBg, 4.0);
  const fgMutedColor = isTerminal
    ? palette.subtext0
    : ensureThemeColorContrast(palette.overlay1, canvasRefBg, 3.5);
  const fgSubtleColor = isTerminal
    ? palette.surface1
    : ensureThemeColorContrast(palette.overlay0, canvasRefBg, 2.3);

  // Canvas & selected/urgent-row background lists for multi-surface contrast safety
  const canvasAndSelectedBgs: readonly ThemeColor[] = [canvasRefBg, bgSelectedColor];
  const cardRowBgs: readonly ThemeColor[] = [canvasRefBg, bgSelectedColor, bgUrgentColor];

  // Canvas borders (borderReply & borderRename also render as `❯` prompts on bgSelected)
  const borderDefaultColor = isTerminal
    ? palette.surface1
    : ensureThemeColorContrast(palette.overlay0, canvasRefBg, 2.3);
  const borderFocusColor = ensureThemeColorContrast(palette.accent, canvasRefBg, 3.0);
  const borderUrgentColor = ensureThemeColorContrast(palette.red, canvasRefBg, 3.0);
  const borderReplyColor = ensureThemeColorContrastAcross(
    palette.yellow,
    canvasAndSelectedBgs,
    3.2,
  );
  const borderRenameColor = ensureThemeColorContrastAcross(
    palette.teal,
    canvasAndSelectedBgs,
    3.2,
  );
  const borderBlockedActionColor = ensureThemeColorContrast(
    isLight ? palette.red : palette.peach,
    canvasRefBg,
    3.0,
  );

  // Canvas & row-overlay status / semantic accents
  const statusUrgentColor = ensureThemeColorContrast(palette.red, canvasRefBg, 3.0);
  const statusReviewColor = ensureThemeColorContrastAcross(
    palette.green,
    canvasAndSelectedBgs,
    3.2,
  );
  const statusWorkingColor = ensureThemeColorContrastAcross(
    palette.yellow,
    canvasAndSelectedBgs,
    3.2,
  );
  const statusIdleColor = isTerminal
    ? fgMutedColor
    : ensureThemeColorContrastAcross(palette.overlay1, canvasAndSelectedBgs, 3.2);

  const accentColor = ensureThemeColorContrastAcross(
    palette.accent,
    canvasAndSelectedBgs,
    3.2,
  );
  const accentWarmColor = ensureThemeColorContrast(palette.peach, canvasRefBg, 3.2);
  const accentRemoteColor = isTerminal
    ? ansi16("magenta")
    : ensureThemeColorContrastAcross(palette.mauve, cardRowBgs, 3.2);
  const gitBranchColor = ensureThemeColorContrastAcross(
    palette.teal,
    canvasAndSelectedBgs,
    3.2,
  );
  const gitDirtyColor = ensureThemeColorContrastAcross(
    palette.yellow,
    canvasAndSelectedBgs,
    3.2,
  );
  const gitAheadColor = ensureThemeColorContrastAcross(
    palette.green,
    canvasAndSelectedBgs,
    3.2,
  );
  const gitBehindColor = ensureThemeColorContrastAcross(
    palette.red,
    canvasAndSelectedBgs,
    3.0,
  );

  // 3. Surface-specific high-contrast foregrounds
  const fgBrandColor = pickContrastingBrandFg(bgBrandColor, palette.panel_bg, palette.text, isTerminal);

  const fgBarKeyColor = isTerminal
    ? palette.yellow
    : ensureThemeColorContrast(palette.accent, bgBarColor, 4.5);
  const fgBarDescColor = isTerminal
    ? palette.text
    : ensureThemeColorContrast(isLight ? palette.text : palette.subtext0, bgBarColor, 4.5);

  const fgPillColor = isTerminal
    ? ansi16("white")
    : ensureThemeColorContrast(isLight ? palette.text : palette.subtext0, bgPillColor, 4.5);
  const fgPillMutedColor = isTerminal
    ? ansi16("gray")
    : ensureThemeColorContrast(palette.subtext0, bgPillColor, 4.0);
  const fgPillReviewColor = isTerminal
    ? palette.green
    : ensureThemeColorContrast(palette.green, bgPillColor, 3.2);
  const fgPillWorkingColor = isTerminal
    ? palette.yellow
    : ensureThemeColorContrast(palette.yellow, bgPillColor, 3.2);

  const fgOnSelectedColor = isTerminal
    ? ansi16("white")
    : ensureThemeColorContrast(palette.text, bgSelectedColor, 4.5);
  const fgOnSelectedMutedColor = isTerminal
    ? ansi16("gray")
    : ensureThemeColorContrast(palette.subtext0, bgSelectedColor, 3.8);
  const fgOnSelectedDividerColor = isTerminal
    ? ansi16("gray")
    : ensureThemeColorContrast(palette.overlay1, bgSelectedColor, 3.0);

  const fgUrgentBadgeColor = urgentUsesAnsiRedBg
    ? ansi16("white")
    : bgUrgentColor.kind === "rgb" && !panelRgb
      ? pickContrastingBrandFg(bgUrgentColor, palette.panel_bg, palette.text, isTerminal)
      : ensureThemeColorContrast(palette.red, bgUrgentColor, 4.0);
  const fgOnUrgentColor = urgentUsesAnsiRedBg
    ? ansi16("white")
    : bgUrgentColor.kind === "rgb" && !panelRgb
      ? pickContrastingBrandFg(bgUrgentColor, palette.panel_bg, palette.text, isTerminal)
      : ensureThemeColorContrast(palette.text, bgUrgentColor, 4.5);
  const fgUrgentAccentColor = urgentUsesAnsiRedBg
    ? ansi16("light_yellow")
    : bgUrgentColor.kind === "rgb" && !panelRgb
      ? pickContrastingBrandFg(bgUrgentColor, palette.panel_bg, palette.text, isTerminal)
      : ensureThemeColorContrast(isLight ? palette.red : palette.peach, bgUrgentColor, 4.0);
  const fgOnUrgentMutedColor = urgentUsesAnsiRedBg
    ? ansi16("white")
    : bgUrgentColor.kind === "rgb" && !panelRgb
      ? pickContrastingBrandFg(bgUrgentColor, palette.panel_bg, palette.text, isTerminal)
      : ensureThemeColorContrast(palette.subtext0, bgUrgentColor, 3.8);
  const fgUrgentTitleOverride = urgentUsesAnsiRedBg ? colorToFgSgr(ansi16("white")) : "";

  const fgModalHeadingColor = isTerminal
    ? palette.teal
    : ensureThemeColorContrast(palette.teal, bgModalColor, 4.0);
  const fgModalKeyColor = isTerminal
    ? palette.yellow
    : ensureThemeColorContrast(isLight ? palette.accent : palette.yellow, bgModalColor, 4.5);
  const fgModalTextColor = isTerminal
    ? palette.text
    : ensureThemeColorContrast(palette.text, bgModalColor, 4.5);
  const fgModalMutedColor = isTerminal
    ? palette.subtext0
    : ensureThemeColorContrast(palette.subtext0, bgModalColor, 4.0);

  // 4. Deterministic 6-color name hash palette (blue, teal, mauve, yellow, green, peach)
  const namePaletteColors: readonly [
    ThemeColor,
    ThemeColor,
    ThemeColor,
    ThemeColor,
    ThemeColor,
    ThemeColor,
  ] = isTerminal
    ? [
        palette.blue,
        palette.teal,
        ansi16("magenta"),
        palette.yellow,
        palette.green,
        palette.red,
      ]
    : [
        ensureThemeColorContrastAcross(palette.blue, cardRowBgs, 3.2),
        ensureThemeColorContrastAcross(palette.teal, cardRowBgs, 3.2),
        ensureThemeColorContrastAcross(palette.mauve, cardRowBgs, 3.2),
        ensureThemeColorContrastAcross(palette.yellow, cardRowBgs, 3.2),
        ensureThemeColorContrastAcross(palette.green, cardRowBgs, 3.2),
        ensureThemeColorContrastAcross(palette.peach, cardRowBgs, 3.2),
      ];

  const namePalette = Object.freeze([
    colorToFgSgr(namePaletteColors[0]),
    colorToFgSgr(namePaletteColors[1]),
    colorToFgSgr(namePaletteColors[2]),
    colorToFgSgr(namePaletteColors[3]),
    colorToFgSgr(namePaletteColors[4]),
    colorToFgSgr(namePaletteColors[5]),
  ] as const);

  return Object.freeze({
    id: def.id,
    displayName: def.displayName,
    sourceName: options.sourceName ?? def.id,
    polarity: def.polarity,
    isLight,
    isTerminal,
    palette,

    // Backgrounds
    bgCanvas: "",
    bgBar: colorToBgSgr(bgBarColor),
    bgPill: colorToBgSgr(bgPillColor),
    bgBrand: colorToBgSgr(bgBrandColor),
    bgSelected: colorToBgSgr(bgSelectedColor),
    bgUrgent: colorToBgSgr(bgUrgentColor),
    bgModal: colorToBgSgr(bgModalColor),

    // Canvas Foregrounds
    fgPrimary: colorToFgSgr(fgPrimaryColor),
    fgSecondary: colorToFgSgr(fgSecondaryColor),
    fgMuted: colorToFgSgr(fgMutedColor),
    fgSubtle: colorToFgSgr(fgSubtleColor),

    // Surface-specific Foregrounds
    fgBrand: colorToFgSgr(fgBrandColor),
    fgBarKey: colorToFgSgr(fgBarKeyColor),
    fgBarDesc: colorToFgSgr(fgBarDescColor),
    fgPill: colorToFgSgr(fgPillColor),
    fgPillMuted: colorToFgSgr(fgPillMutedColor),
    fgPillReview: colorToFgSgr(fgPillReviewColor),
    fgPillWorking: colorToFgSgr(fgPillWorkingColor),
    fgOnSelected: colorToFgSgr(fgOnSelectedColor),
    fgOnSelectedMuted: colorToFgSgr(fgOnSelectedMutedColor),
    fgOnSelectedDivider: colorToFgSgr(fgOnSelectedDividerColor),
    fgUrgentBadge: colorToFgSgr(fgUrgentBadgeColor),
    fgOnUrgent: colorToFgSgr(fgOnUrgentColor),
    fgUrgentAccent: colorToFgSgr(fgUrgentAccentColor),
    fgOnUrgentMuted: colorToFgSgr(fgOnUrgentMutedColor),
    fgUrgentTitleOverride,
    fgModalHeading: colorToFgSgr(fgModalHeadingColor),
    fgModalKey: colorToFgSgr(fgModalKeyColor),
    fgModalText: colorToFgSgr(fgModalTextColor),
    fgModalMuted: colorToFgSgr(fgModalMutedColor),

    // Borders
    borderDefault: colorToFgSgr(borderDefaultColor),
    borderFocus: colorToFgSgr(borderFocusColor),
    borderUrgent: colorToFgSgr(borderUrgentColor),
    borderReply: colorToFgSgr(borderReplyColor),
    borderRename: colorToFgSgr(borderRenameColor),
    borderBlockedAction: colorToFgSgr(borderBlockedActionColor),

    // Statuses
    statusUrgent: colorToFgSgr(statusUrgentColor),
    statusReview: colorToFgSgr(statusReviewColor),
    statusWorking: colorToFgSgr(statusWorkingColor),
    statusIdle: colorToFgSgr(statusIdleColor),

    // Accents, Remote & Git
    accent: colorToFgSgr(accentColor),
    accentWarm: colorToFgSgr(accentWarmColor),
    accentRemote: colorToFgSgr(accentRemoteColor),
    gitBranch: colorToFgSgr(gitBranchColor),
    gitDirty: colorToFgSgr(gitDirtyColor),
    gitAhead: colorToFgSgr(gitAheadColor),
    gitBehind: colorToFgSgr(gitBehindColor),

    // Toasts
    toastInfo: colorToFgSgr(gitBranchColor),
    toastOk: colorToFgSgr(statusReviewColor),
    toastWarn: colorToFgSgr(accentWarmColor),
    toastError: colorToFgSgr(statusUrgentColor),

    // Name Hash Palette
    namePalette,
  });
}

export const BUILTIN_THEMES: Readonly<Record<BuiltinThemeId, DeckTheme>> = Object.freeze({
  catppuccin: compileTheme("catppuccin"),
  dracula: compileTheme("dracula"),
  "tokyo-night": compileTheme("tokyo-night"),
  gruvbox: compileTheme("gruvbox"),
  nord: compileTheme("nord"),
  "one-dark": compileTheme("one-dark"),
  "catppuccin-latte": compileTheme("catppuccin-latte"),
  terminal: compileTheme("terminal"),
});

export const DEFAULT_THEME: DeckTheme = BUILTIN_THEMES[DEFAULT_THEME_ID];

export function getBuiltinTheme(id: BuiltinThemeId): DeckTheme {
  return BUILTIN_THEMES[id];
}

/**
 * Deterministic fingerprint of a compiled `DeckTheme` for deduplicating live config reloads.
 */
export function getThemeSignature(theme: DeckTheme): string {
  const paletteParts = HERDR_PALETTE_KEYS.map((key) => {
    const c = theme.palette[key];
    if (c.kind === "rgb") return `${key}:${c.r},${c.g},${c.b}`;
    if (c.kind === "ansi16") return `${key}:a:${c.name}`;
    if (c.kind === "indexed") return `${key}:i:${c.index}`;
    return `${key}:reset`;
  });
  return `${theme.id}|${theme.sourceName}|${theme.polarity}|${paletteParts.join(";")}`;
}
