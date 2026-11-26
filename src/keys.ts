export type ParsedKey =
  | { kind: "char"; value: string }
  | { kind: "ctrl"; key: string }
  | { kind: "special"; name: "up" | "down" | "left" | "right" | "enter" | "esc" | "tab" | "shift+tab" | "backspace" | "delete" | "pageup" | "pagedown" | "home" | "end" | "space" };

/**
 * Parse raw terminal stdin buffer chunk into structured key events.
 * Handles UTF-8 / CJK multi-character input, pasted chunks, arrow keys, CSI sequences, and Ctrl chords.
 */
export function parseTerminalInput(buf: Buffer): ParsedKey[] {
  const str = buf.toString("utf8");
  const events: ParsedKey[] = [];
  let i = 0;

  while (i < str.length) {
    const ch = str[i]!;
    const code = ch.charCodeAt(0);

    if (ch === "\x1b") {
      // Standalone Escape
      if (i + 1 >= str.length) {
        events.push({ kind: "special", name: "esc" });
        i += 1;
        continue;
      }

      const next = str[i + 1]!;
      if (next === "[" || next === "O") {
        // CSI or SS3 sequence
        let j = i + 2;
        while (j < str.length && !/[A-Za-z~]/.test(str[j]!)) {
          j += 1;
        }
        const seq = str.slice(i, Math.min(j + 1, str.length));
        i = Math.min(j + 1, str.length);

        // Ignore mouse SGR reports if any leak through (\x1b[<...M / m)
        if (seq.startsWith("\x1b[<")) {
          continue;
        }

        switch (seq) {
          case "\x1b[A":
          case "\x1bOA":
            events.push({ kind: "special", name: "up" });
            break;
          case "\x1b[B":
          case "\x1bOB":
            events.push({ kind: "special", name: "down" });
            break;
          case "\x1b[C":
          case "\x1bOC":
            events.push({ kind: "special", name: "right" });
            break;
          case "\x1b[D":
          case "\x1bOD":
            events.push({ kind: "special", name: "left" });
            break;
          case "\x1b[Z":
            events.push({ kind: "special", name: "shift+tab" });
            break;
          case "\x1b[3~":
            events.push({ kind: "special", name: "delete" });
            break;
          case "\x1b[5~":
            events.push({ kind: "special", name: "pageup" });
            break;
          case "\x1b[6~":
            events.push({ kind: "special", name: "pagedown" });
            break;
          case "\x1b[H":
          case "\x1b[1~":
            events.push({ kind: "special", name: "home" });
            break;
          case "\x1b[F":
          case "\x1b[4~":
            events.push({ kind: "special", name: "end" });
            break;
          default:
            break;
        }
        continue;
      }

      // Alt+key or double Esc
      events.push({ kind: "special", name: "esc" });
      i += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      events.push({ kind: "special", name: "enter" });
      if (ch === "\r" && str[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "\t") {
      events.push({ kind: "special", name: "tab" });
      i += 1;
      continue;
    }

    if (code === 0x7f || code === 0x08) {
      events.push({ kind: "special", name: "backspace" });
      i += 1;
      continue;
    }

    if (ch === " ") {
      events.push({ kind: "special", name: "space" });
      i += 1;
      continue;
    }

    // Ctrl+A (1) .. Ctrl+Z (26)
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(96 + code);
      events.push({ kind: "ctrl", key: letter });
      i += 1;
      continue;
    }

    if (code < 32) {
      i += 1;
      continue;
    }

    // Full Unicode code point (handles surrogate pairs / emoji / CJK)
    const cp = str.codePointAt(i)!;
    const glyph = String.fromCodePoint(cp);
    events.push({ kind: "char", value: glyph });
    i += glyph.length;
  }

  return events;
}

/**
 * Convert a ParsedKey into a Herdr `agent.send_keys` / `pane.send_keys` key combo string.
 */
export function toHerdrKeySpec(key: ParsedKey): string | null {
  if (key.kind === "char") {
    if (key.value === "-") return "minus";
    if (key.value === "+") return "plus";
    return key.value;
  }
  if (key.kind === "ctrl") {
    return `ctrl+${key.key}`;
  }
  switch (key.name) {
    case "up":
      return "up";
    case "down":
      return "down";
    case "left":
      return "left";
    case "right":
      return "right";
    case "enter":
      return "enter";
    case "esc":
      return "esc";
    case "tab":
      return "tab";
    case "shift+tab":
      return "shift+tab";
    case "backspace":
      return "backspace";
    case "delete":
      return "delete";
    case "pageup":
      return "pageup";
    case "pagedown":
      return "pagedown";
    case "home":
      return "home";
    case "end":
      return "end";
    case "space":
      return "space";
  }
}
