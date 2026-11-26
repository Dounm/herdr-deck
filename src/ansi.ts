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

  // Backgrounds
  bg0Hard: bgHex(29, 32, 33), // #1d2021
  bg0: bgHex(40, 40, 40), // #282828
  bg1: bgHex(60, 56, 54), // #3c3836 selected row / header bar
  bg2: bgHex(80, 73, 69), // #504945 active badge / input bar
  bgUrgent: bgHex(76, 36, 32), // subtle warm dark red tint for selected blocked row
  bgInteract: bgHex(52, 62, 54), // subtle greenish tint when interact mode active
} as const;

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
      cp === 0x23f3 || // ⏳
      cp === 0x26a1 || // ⚡
      cp === 0x26a0 || // ⚠
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
