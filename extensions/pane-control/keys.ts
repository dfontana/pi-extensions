/**
 * Canonical key-spec parsing and translation to backend key names.
 *
 * Agents pass keys like "Enter", "Esc", "Ctrl+C", "Shift+Up". Kitty's
 * `send-key` wants "ctrl+c" / "shift+up"; zellij's `send-keys` wants each key
 * as one space-separated argv element like "Ctrl c" / "Shift Up".
 */

/** A key's argument spelling per backend. */
interface BackendKey {
  kitty: string;
  zellij: string;
}

const MODIFIERS: Record<string, BackendKey> = {
  ctrl: { kitty: "ctrl", zellij: "Ctrl" },
  control: { kitty: "ctrl", zellij: "Ctrl" },
  alt: { kitty: "alt", zellij: "Alt" },
  option: { kitty: "alt", zellij: "Alt" },
  shift: { kitty: "shift", zellij: "Shift" },
  super: { kitty: "super", zellij: "Super" },
  cmd: { kitty: "super", zellij: "Super" },
};

const NAMED_KEYS: Record<string, BackendKey> = {
  enter: { kitty: "enter", zellij: "Enter" },
  return: { kitty: "enter", zellij: "Enter" },
  esc: { kitty: "escape", zellij: "Esc" },
  escape: { kitty: "escape", zellij: "Esc" },
  tab: { kitty: "tab", zellij: "Tab" },
  space: { kitty: "space", zellij: "Space" },
  backspace: { kitty: "backspace", zellij: "Backspace" },
  delete: { kitty: "delete", zellij: "Delete" },
  del: { kitty: "delete", zellij: "Delete" },
  insert: { kitty: "insert", zellij: "Insert" },
  up: { kitty: "up", zellij: "Up" },
  down: { kitty: "down", zellij: "Down" },
  left: { kitty: "left", zellij: "Left" },
  right: { kitty: "right", zellij: "Right" },
  home: { kitty: "home", zellij: "Home" },
  end: { kitty: "end", zellij: "End" },
  pageup: { kitty: "page_up", zellij: "PageUp" },
  pagedown: { kitty: "page_down", zellij: "PageDown" },
};
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`f${i}`] = { kitty: `f${i}`, zellij: `F${i}` };
}

function resolveKey(spec: string): { mods: string[]; key: BackendKey } {
  const s = spec.trim();
  if (!s) throw new Error("Empty key spec");
  let modParts: string[];
  let key: string;
  if (s.endsWith("+")) {
    // A trailing "+" means the key itself is "+" (e.g. "+" or "Ctrl++").
    key = "+";
    modParts = s.slice(0, -1).split("+");
  } else {
    modParts = s.split("+");
    key = modParts.pop()!;
  }
  const mods: string[] = [];
  for (const raw of modParts) {
    if (!raw) continue;
    const mod = raw.toLowerCase();
    if (!(mod in MODIFIERS)) {
      throw new Error(
        `Unknown modifier "${raw}" in key spec "${spec}" (valid: Ctrl, Alt, Shift, Super)`,
      );
    }
    if (!mods.includes(mod)) mods.push(mod);
  }
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return { mods, key: named };
  if ([...key].length === 1) {
    const ch = key.toLowerCase();
    return { mods, key: { kitty: ch, zellij: ch } };
  }
  throw new Error(
    `Unknown key "${key}" in spec "${spec}". Use a single character or one of: ` +
      `Enter, Esc, Tab, Space, Backspace, Delete, Insert, Up, Down, Left, Right, ` +
      `Home, End, PageUp, PageDown, F1-F12 (with optional Ctrl+/Alt+/Shift+ modifiers).`,
  );
}

/** Translate a canonical key spec to a kitty `send-key` argument, e.g. "Ctrl+C" → "ctrl+c". */
export function toKittyKey(spec: string): string {
  const { mods, key } = resolveKey(spec);
  return [...mods.map((m) => MODIFIERS[m].kitty), key.kitty].join("+");
}

/** Translate a canonical key spec to a zellij `send-keys` argument, e.g. "Ctrl+C" → "Ctrl c". */
export function toZellijKey(spec: string): string {
  const { mods, key } = resolveKey(spec);
  return [...mods.map((m) => MODIFIERS[m].zellij), key.zellij].join(" ");
}
