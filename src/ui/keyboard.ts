import { deckActions } from "../engine/actions";

export interface Shortcut {
  keys: string[]; // display form
  label: string; // locale key
  test: (event: KeyboardEvent) => boolean;
  run?: (context: ShortcutContext) => void;
}

export interface ShortcutContext {
  toggleDrawer(): void;
  toggleHelp(): void;
  toggleHarness(): void;
  closeOverlays(): void;
}

const key = (value: string) => (event: KeyboardEvent) => event.key.toLowerCase() === value && !event.shiftKey;

export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: "keys.group.decks",
    items: [
      { keys: ["Z", "M"], label: "keys.play", test: key("z"), run: () => void deckActions.togglePlay("A") },
      { keys: ["X", ","], label: "keys.cue", test: key("x"), run: () => void deckActions.cue("A") },
      { keys: ["S", "K"], label: "keys.sync", test: key("s"), run: () => void deckActions.sync("A") },
      {
        keys: ["G", "H"],
        label: "keys.loop4",
        test: key("g"),
        run: () => void deckActions.setLoopBeats("A", 4),
      },
      { keys: ["1–4", "7–0"], label: "keys.hotCues", test: () => false },
    ],
  },
  {
    title: "keys.group.console",
    items: [
      { keys: ["⌘/Ctrl", "K"], label: "keys.palette", test: () => false },
      { keys: ["L"], label: "keys.library", test: key("l"), run: (context) => context.toggleDrawer() },
      {
        keys: ["?"],
        label: "keys.help",
        test: (event) => event.key === "?",
        run: (context) => context.toggleHelp(),
      },
      {
        keys: ["Shift", "D"],
        label: "keys.harness",
        test: (event) => event.key === "D" && event.shiftKey,
        run: (context) => context.toggleHarness(),
      },
      {
        keys: ["Esc"],
        label: "keys.close",
        test: (event) => event.key === "Escape",
        run: (context) => context.closeOverlays(),
      },
    ],
  },
  {
    title: "keys.group.stage",
    items: [
      { keys: ["F"], label: "keys.stageFullscreen", test: () => false },
      { keys: ["Shift", "B"], label: "keys.stageBlackout", test: () => false },
      { keys: ["T"], label: "keys.stageTest", test: () => false },
      { keys: ["C"], label: "keys.stageCrowd", test: () => false },
      { keys: ["N"], label: "keys.stageLowerThird", test: () => false },
      { keys: ["M"], label: "keys.stageMorph", test: () => false },
      { keys: ["1–8"], label: "keys.stageScenes", test: () => false },
      { keys: ["Shift", "1–9"], label: "keys.stagePresets", test: () => false },
    ],
  },
  {
    title: "keys.group.library",
    items: [
      { keys: ["↑", "↓"], label: "keys.select", test: () => false },
      { keys: ["A", "B"], label: "keys.loadRow", test: () => false },
      { keys: ["C"], label: "keys.preview", test: () => false },
      { keys: ["Q"], label: "keys.queue", test: () => false },
    ],
  },
];

const HOT_CUE_KEYS: Record<string, { deck: "A" | "B"; slot: number }> = {
  "1": { deck: "A", slot: 0 },
  "2": { deck: "A", slot: 1 },
  "3": { deck: "A", slot: 2 },
  "4": { deck: "A", slot: 3 },
  "7": { deck: "B", slot: 0 },
  "8": { deck: "B", slot: 1 },
  "9": { deck: "B", slot: 2 },
  "0": { deck: "B", slot: 3 },
};

/** Global console shortcuts (not while typing in a field). Returns true when handled. */
export function handleConsoleKey(event: KeyboardEvent, context: ShortcutContext): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const lower = event.key.toLowerCase();
  const deckB: Record<string, () => void> = {
    m: () => void deckActions.togglePlay("B"),
    ",": () => void deckActions.cue("B"),
    k: () => void deckActions.sync("B"),
    h: () => void deckActions.setLoopBeats("B", 4),
  };
  const hotCue = HOT_CUE_KEYS[event.key];
  if (hotCue) {
    void deckActions.triggerHotCue(hotCue.deck, hotCue.slot);
    return true;
  }
  const b = deckB[lower];
  if (b && !event.shiftKey) {
    b();
    return true;
  }
  for (const group of SHORTCUT_GROUPS) {
    for (const item of group.items) {
      if (item.run && item.test(event)) {
        item.run(context);
        return true;
      }
    }
  }
  return false;
}
