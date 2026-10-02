import type { KeybindingsManager } from "@earendil-works/pi-tui";

const FULLSCREEN_SCROLL_REMAPS = [
  ["tui.altScreen.top", "home", "alt+home"],
  ["tui.altScreen.bottom", "end", "alt+end"],
] as const;

type ReloadableKeybindings = KeybindingsManager & { reload?: () => void };

function remapCurrentFullscreenScrollBindings(keybindings: KeybindingsManager): void {
  const updatedBindings = { ...keybindings.getUserBindings() };
  let changed = false;

  for (const [action, key, replacement] of FULLSCREEN_SCROLL_REMAPS) {
    const currentKeys = keybindings.getKeys(action);
    if (!currentKeys.includes(key)) continue;

    const remappedKeys = [
      ...new Set(currentKeys.map((currentKey) => (currentKey === key ? replacement : currentKey))),
    ];
    updatedBindings[action] = remappedKeys.length === 1 ? remappedKeys[0] : remappedKeys;
    changed = true;
  }

  if (changed) keybindings.setUserBindings(updatedBindings);
}

/** Free Home/End for the editor while preserving fullscreen transcript jumps. */
export function remapFullscreenScrollBindings(keybindings: KeybindingsManager): () => void {
  const reloadable = keybindings as ReloadableKeybindings;
  const originalReload = reloadable.reload;
  let originalUserBindings = keybindings.getUserBindings();

  remapCurrentFullscreenScrollBindings(keybindings);

  // Pi reloads keybindings after session_start, so reapply the remap after that reset.
  const wrappedReload = originalReload
    ? function (this: ReloadableKeybindings) {
        originalReload.call(this);
        originalUserBindings = keybindings.getUserBindings();
        remapCurrentFullscreenScrollBindings(keybindings);
      }
    : undefined;

  if (wrappedReload) reloadable.reload = wrappedReload;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;

    if (wrappedReload && reloadable.reload === wrappedReload) {
      reloadable.reload = originalReload;
    }
    const restoredBindings = keybindings.getUserBindings();
    for (const [action] of FULLSCREEN_SCROLL_REMAPS) {
      if (Object.hasOwn(originalUserBindings, action)) {
        restoredBindings[action] = originalUserBindings[action];
      } else {
        delete restoredBindings[action];
      }
    }
    keybindings.setUserBindings(restoredBindings);
  };
}
