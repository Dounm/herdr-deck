// Gruvbox Dark 24-bit TrueColor palette & ANSI helpers for Herdr Deck

const ESC = "\x1b[";

function fgHex(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`;
}

function bgHex(r: number, g: number, b: number): string {
  return `${ESC}48;2;${r};${g};${b}m`;
}

export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;

export const GRUVBOX = {
  // Foregrounds
  fg0: fgHex(251, 241, 199), // #fbf1c7 cream bright
  fg1: fgHex(235, 219, 178), // #ebdbb2 warm main text
  fg2: fgHex(213, 196, 161), // #d5c4a1 secondary text
  fg3: fgHex(189, 174, 147), // #bdae93 muted
  gray: fgHex(146, 131, 116), // #928374 comment gray
  darkGray: fgHex(102, 92, 84), // #665c54 border dim

  // Accents
  red: fgHex(251, 73, 52), // #fb4934 blocked urgent
  orange: fgHex(254, 128, 25), // #fe8019 needs attention / active frame
  yellow: fgHex(250, 189, 47), // #fabd2f working / warm highlight
  green: fgHex(184, 187, 38), // #b8bb26 done / ready for review
  aqua: fgHex(142, 192, 124), // #8ec07c branch / path
  blue: fgHex(131, 165, 152), // #83a598 info / workspace
  purple: fgHex(211, 134, 155), // #d3869b accent name color

  // Backgrounds
  bg0Hard: bgHex(29, 32, 33), // #1d2021
  bg0: bgHex(40, 40, 40), // #282828
  bg1: bgHex(60, 56, 54), // #3c3836 selected row / header bar
  bg2: bgHex(80, 73, 69), // #504945 active badge / input bar
  bgUrgent: bgHex(76, 36, 32), // subtle warm dark red tint for selected blocked row
  bgModal: bgHex(34, 34, 34), // #222222 overlay modal card surface
} as const;

const NAME_PALETTE = [
  GRUVBOX.blue,
  GRUVBOX.aqua,
  GRUVBOX.purple,
  GRUVBOX.yellow,
  GRUVBOX.green,
  GRUVBOX.orange,
] as const;

/**
 * Deterministic FNV-1a hash mapping an agent/pane title to a readable Gruvbox accent color.
 */
export function pickNameColor(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return GRUVBOX.fg1;
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = (hash >>> 0) % NAME_PALETTE.length;
  return NAME_PALETTE[idx]!;
}

/**
 * Render a rounded box top border: `╭─ Title ───────── RightTag ─╮` with exact visible width.
 */
export function renderBoxTop(
  title: string,
  rightTag: string,
  width: number,
  borderColor: string,
  bg = "",
): string {
  if (width < 4) {
    return fitAnsiColumns("╭" + "─".repeat(Math.max(0, width - 2)) + "╮", width);
  }
  const innerBudget = width - 2; // exclude ╭ and ╮
  const leftText = title ? `─ ${title} ` : "";
  const rightText = rightTag ? ` ${rightTag} ─` : "";

  const leftW = visibleWidth(leftText);
  const rightW = visibleWidth(rightText);

  if (rightTag && leftW + rightW + 1 <= innerBudget) {
    const fillCount = innerBudget - leftW - rightW;
    const fill = `${bg}${borderColor}${"─".repeat(fillCount)}${RESET}`;
    return (
      `${bg}${borderColor}╭─${RESET}` +
      (title ? `${bg} ${title}${RESET}${bg} ` : "") +
      fill +
      `${bg} ${rightTag}${RESET}${bg}${borderColor} ─╮${RESET}`
    );
  }

  if (title) {
    const maxTitleCols = Math.max(1, innerBudget - 4);
    const fittedTitle = fitAnsiColumns(title, maxTitleCols, { ellipsis: "…" });
    const usedTitleW = visibleWidth(fittedTitle);
    const fillCount = Math.max(0, innerBudget - usedTitleW - 3);
    return (
      `${bg}${borderColor}╭─${RESET}` +
      `${bg} ${fittedTitle}${RESET}${bg} ` +
      `${bg}${borderColor}${"─".repeat(fillCount)}╮${RESET}`
    );
  }

  return `${bg}${borderColor}╭${"─".repeat(innerBudget)}╮${RESET}`;
}

export function renderBoxBottom(width: number, borderColor: string, bg = ""): string {
  if (width < 2) return "";
  return `${bg}${borderColor}╰${"─".repeat(width - 2)}╯${RESET}`;
}

export function renderBoxRow(
  innerContent: string,
  width: number,
  borderColor: string,
  padBg?: string,
): string {
  if (width < 2) return "";
  const innerWidth = width - 2;
  const fitted = fitAnsiColumns(innerContent, innerWidth, { pad: true, padBg });
  const bg = padBg ?? "";
  return `${bg}${borderColor}│${RESET}${fitted}${bg}${borderColor}│${RESET}`;
}

export function style(text: string, ...codes: string[]): string {
  if (!codes.length) return text;
  return `${codes.join("")}${text}${RESET}`;
}

/**
 * Compute terminal cell display width of a Unicode code point (CJK / fullwidth = 2, control/combining = 0).
 */
export function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  // Private Use Area (Nerd Font icons: U+E000..U+F8FF, Plane 15/16 PUA) = 1 cell in terminal Nerd Fonts
  if (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  ) {
    return 1;
  }
  // Wide / Fullwidth / CJK / Emoji blocks
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x23e9 && cp <= 0x23fa) || // ⏩..⏺ incl. ⏳ ⏰
      (cp >= 0x25fd && cp <= 0x25fe) || // ◽◾
      (cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols & Dingbats (⚠ ⚡ ✅ ❌ ✨ etc.)
      (cp >= 0x2b50 && cp <= 0x2b55) || // ⭐ ⭕
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

const TOKEN_REGEX =
  // eslint-disable-next-line no-control-regex
  /(\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/g;

export function visibleWidth(input: string): number {
  let width = 0;
  const plain = input.replace(TOKEN_REGEX, "");
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      width += codePointWidth(cp);
    }
  }
  return width;
}

/**
 * Sanitize raw pane ANSI line so only safe SGR color/style sequences remain
 * (strips cursor movement, screen clear, OSC titles, tabs -> spaces).
 */
export function sanitizePreviewAnsiLine(rawLine: string): string {
  const expanded = rawLine.replace(/\r/g, "").replace(/\t/g, "  ");
  return expanded.replace(TOKEN_REGEX, (seq) => {
    // Keep only CSI ... m (SGR color/attribute codes)
    if (seq.startsWith("\x1b[") && seq.endsWith("m")) {
      return seq;
    }
    return "";
  });
}

/**
 * Truncate a string (possibly containing ANSI SGR sequences) to fit `maxCols` display columns,
 * optionally appending an ellipsis and always resetting trailing SGR when ANSI was used.
 */
export function fitAnsiColumns(
  input: string,
  maxCols: number,
  options: { pad?: boolean; ellipsis?: string; padBg?: string } = {},
): string {
  if (maxCols <= 0) return "";
  const ellipsis = options.ellipsis ?? "…";
  const ellipsisWidth = visibleWidth(ellipsis);

  const totalWidth = visibleWidth(input);
  if (totalWidth <= maxCols) {
    const hasAnsi = input.includes("\x1b[");
    const suffixReset = hasAnsi ? RESET : "";
    if (!options.pad || totalWidth === maxCols) {
      return input + suffixReset;
    }
    const padSpaces = " ".repeat(maxCols - totalWidth);
    return (
      input +
      suffixReset +
      (options.padBg ? `${options.padBg}${padSpaces}${RESET}` : padSpaces)
    );
  }

  const budget = ellipsisWidth < maxCols ? maxCols - ellipsisWidth : maxCols;
  let used = 0;
  let out = "";
  let sawAnsi = false;
  let lastIndex = 0;

  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  const appendPlainSlice = (segment: string): boolean => {
    for (const ch of segment) {
      const cp = ch.codePointAt(0) ?? 0;
      const w = codePointWidth(cp);
      if (used + w > budget) {
        return false;
      }
      out += ch;
      used += w;
    }
    return true;
  };

  while ((match = TOKEN_REGEX.exec(input)) !== null) {
    const plainChunk = input.slice(lastIndex, match.index);
    if (plainChunk && !appendPlainSlice(plainChunk)) {
      break;
    }
    out += match[0];
    sawAnsi = true;
    lastIndex = TOKEN_REGEX.lastIndex;
  }

  if (lastIndex < input.length && used < budget) {
    appendPlainSlice(input.slice(lastIndex));
  }

  if (ellipsisWidth > 0 && ellipsisWidth <= maxCols && used + ellipsisWidth <= maxCols) {
    out += (sawAnsi ? `${RESET}${GRUVBOX.gray}` : "") + ellipsis;
    used += ellipsisWidth;
    sawAnsi = true;
  }

  if (sawAnsi) {
    out += RESET;
  }

  if (options.pad && used < maxCols) {
    const padSpaces = " ".repeat(maxCols - used);
    out += options.padBg ? `${options.padBg}${padSpaces}${RESET}` : padSpaces;
  }

  return out;
}

/**
 * Slice a plain text input draft with a cursor index (in Unicode code points) so it fits within `maxCols`
 * while keeping the cursor always visible. Returns the visible text slice and the cursor's cell offset inside it.
 */
export function layoutEditableInput(
  text: string,
  cursorIndex: number,
  maxCols: number,
): { visibleText: string; cursorCellOffset: number } {
  const chars = Array.from(text);
  const clampedCursor = Math.max(0, Math.min(chars.length, cursorIndex));
  const widths = chars.map((ch) => codePointWidth(ch.codePointAt(0) ?? 0));

  if (maxCols <= 1) {
    return { visibleText: "", cursorCellOffset: 0 };
  }

  // Reserve 1 cell for the terminal cursor itself when at the end of the text
  const textBudget = Math.max(1, maxCols - 1);

  const totalWidth = widths.reduce((sum, w) => sum + w, 0);
  if (totalWidth <= textBudget) {
    let offset = 0;
    for (let i = 0; i < clampedCursor; i++) {
      offset += widths[i]!;
    }
    return { visibleText: text, cursorCellOffset: offset };
  }

  // Keep cursor visible by choosing a window [start, end) that contains clampedCursor
  let start = 0;
  let widthBeforeCursor = 0;
  for (let i = 0; i < clampedCursor; i++) {
    widthBeforeCursor += widths[i]!;
  }

  // If text before cursor exceeds budget, advance start until it fits (leave 1 cell for leading '‹')
  if (widthBeforeCursor > textBudget - 1) {
    let acc = 0;
    let s = clampedCursor;
    while (s > 0 && acc + widths[s - 1]! <= textBudget - 1) {
      s -= 1;
      acc += widths[s]!;
    }
    start = s;
  }

  const hasLeftOverflow = start > 0;
  let used = hasLeftOverflow ? 1 : 0;
  let end = start;
  let cursorCellOffset = used;

  while (end < chars.length) {
    const w = widths[end]!;
    if (used + w > textBudget) break;
    if (end < clampedCursor) {
      cursorCellOffset += w;
    }
    used += w;
    end += 1;
  }

  const slice = chars.slice(start, end).join("");
  return {
    visibleText: hasLeftOverflow ? `‹${slice}` : slice,
    cursorCellOffset,
  };
}

/**
 * Wrap a single sanitized ANSI SGR line into visual lines of at most `maxCols` display cells.
 * - Preserves active ANSI SGR color/style across wrapped lines cleanly.
 * - Keeps pure horizontal divider lines (e.g. `──────`) trimmed to 1 neat line instead of wrapping into 2 ugly lines.
 * - Trims trailing whitespace padding that terminal emulators emit on full-width lines.
 */
export function wrapAnsiLine(rawLine: string, maxCols: number): string[] {
  if (maxCols <= 0) return [""];

  const clean = sanitizePreviewAnsiLine(rawLine);
  const plainTrimmedRight = clean.replace(TOKEN_REGEX, "").replace(/\s+$/, "");

  // Empty / whitespace-only line -> single empty line
  if (plainTrimmedRight.length === 0) {
    return [""];
  }

  // Pure horizontal rule / box divider (e.g. Claude/Agy 185-col `─────` separators) -> clip to 1 row cleanly
  const plainTrimmed = plainTrimmedRight.trim();
  if (plainTrimmed.length >= 4 && /^[─━═┄┅┈┉\-_=]+$/.test(plainTrimmed)) {
    return [fitAnsiColumns(clean, maxCols, { ellipsis: "" })];
  }

  // Fast path: already fits within maxCols
  if (visibleWidth(plainTrimmedRight) <= maxCols) {
    return [fitAnsiColumns(trimTrailingSpacesAnsi(clean), maxCols, { ellipsis: "" })];
  }

  const trimmed = trimTrailingSpacesAnsi(clean);
  const result: string[] = [];

  let activeSgr = "";
  let currentLine = "";
  let currentWidth = 0;

  const flushLine = () => {
    result.push(currentLine + (activeSgr ? RESET : ""));
    currentLine = activeSgr;
    currentWidth = 0;
  };

  TOKEN_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushPlain = (segment: string) => {
    for (const ch of segment) {
      const cp = ch.codePointAt(0) ?? 0;
      const w = codePointWidth(cp);
      if (w > 0 && currentWidth + w > maxCols && currentWidth > 0) {
        flushLine();
      }
      currentLine += ch;
      currentWidth += w;
    }
  };

  while ((match = TOKEN_REGEX.exec(trimmed)) !== null) {
    const plainChunk = trimmed.slice(lastIndex, match.index);
    if (plainChunk) {
      pushPlain(plainChunk);
    }
    const seq = match[0];
    if (seq === "\x1b[0m" || seq === "\x1b[m") {
      activeSgr = "";
    } else if (seq.startsWith("\x1b[") && seq.endsWith("m")) {
      activeSgr += seq;
    }
    currentLine += seq;
    lastIndex = TOKEN_REGEX.lastIndex;
  }

  if (lastIndex < trimmed.length) {
    pushPlain(trimmed.slice(lastIndex));
  }

  if (currentWidth > 0 || result.length === 0) {
    result.push(currentLine + (activeSgr ? RESET : ""));
  }

  return result;
}

function trimTrailingSpacesAnsi(input: string): string {
  // Strip trailing plain spaces (preserving trailing SGR resets cleanly)
  const parts: Array<{ isAnsi: boolean; text: string }> = [];
  TOKEN_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_REGEX.exec(input)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ isAnsi: false, text: input.slice(lastIndex, match.index) });
    }
    parts.push({ isAnsi: true, text: match[0] });
    lastIndex = TOKEN_REGEX.lastIndex;
  }
  if (lastIndex < input.length) {
    parts.push({ isAnsi: false, text: input.slice(lastIndex) });
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p.isAnsi) continue;
    const trimmed = p.text.replace(/[ \t]+$/, "");
    p.text = trimmed;
    if (trimmed.length > 0) break;
  }

  return parts.map((p) => p.text).join("");
}
