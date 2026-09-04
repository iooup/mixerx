import { describe, expect, it } from "vitest";
import {
  createInitialSession,
  persistPreferences,
  readStoredPreferences,
  reduceSession,
} from "../../src/state/session-store";
import { createStore } from "../../src/state/store";
import {
  clampDrawerHeight,
  createInitialUi,
  DRAWER_DEFAULT_HEIGHT,
  persistUi,
  reduceUi,
} from "../../src/state/ui-store";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("createStore", () => {
  it("notifies subscribers only when the reducer returns a new reference", () => {
    const store = createStore({ count: 0 }, (state, event: { type: "inc" | "noop" }) =>
      event.type === "inc" ? { count: state.count + 1 } : state,
    );
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.dispatch({ type: "noop" });
    store.dispatch({ type: "inc" });
    expect(store.getState().count).toBe(1);
    expect(notifications).toBe(1);
    unsubscribe();
    store.dispatch({ type: "inc" });
    expect(notifications).toBe(1);
  });
});

describe("session store", () => {
  it("starts silent, unconfigured, and honest about the agent and the network policy", () => {
    const session = createInitialSession();
    expect(session.mode).toBe("learn");
    expect(session.autonomy).toBe("prepare");
    expect(session.decks.A.track).toBeNull();
    expect(session.decks.A.onAir).toBe(false);
    expect(session.routing.configured).toBe(false);
    expect(session.agent.webmcp).toBe("unavailable");
    expect(session.privacy.cspEnforced).toBeNull();
    expect(session.mixer.crossfader).toBe(0);
  });

  it("reduces mode, autonomy, privacy, and agent events without touching other slices", () => {
    const initial = createInitialSession();
    const afterMode = reduceSession(initial, { type: "mode/set", mode: "learn" });
    expect(afterMode.mode).toBe("learn");
    expect(afterMode.decks).toBe(initial.decks);
    expect(reduceSession(afterMode, { type: "mode/set", mode: "learn" })).toBe(afterMode);

    const afterCsp = reduceSession(afterMode, { type: "privacy/csp", enforced: true });
    expect(afterCsp.privacy.cspEnforced).toBe(true);
    expect(afterCsp.mixer).toBe(initial.mixer);

    const afterAgent = reduceSession(afterCsp, { type: "agent/webmcp", status: "available", toolCount: 0 });
    expect(afterAgent.agent).toEqual({ webmcp: "available", toolCount: 0 });

    const afterAutonomy = reduceSession(afterAgent, { type: "autonomy/set", autonomy: "copilot" });
    expect(afterAutonomy.autonomy).toBe("copilot");
  });

  it("persists mode, autonomy and the queue and ignores corrupt values", () => {
    const storage = memoryStorage();
    persistPreferences(storage, reduceSession(createInitialSession(), { type: "mode/set", mode: "perform" }));
    expect(readStoredPreferences(storage)).toEqual({ mode: "perform", autonomy: "prepare", queue: [] });
    storage.setItem("mixerx.v2.session", JSON.stringify({ mode: "bogus", autonomy: 42 }));
    expect(readStoredPreferences(storage)).toEqual({});
    storage.setItem("mixerx.v2.session", "{not json");
    expect(readStoredPreferences(storage)).toEqual({});
  });
});

describe("ui store", () => {
  it("clamps the drawer height and applies stored preferences", () => {
    expect(clampDrawerHeight(10)).toBe(160);
    expect(clampDrawerHeight(5000, 900)).toBe(630);
    expect(clampDrawerHeight(Number.NaN)).toBe(DRAWER_DEFAULT_HEIGHT);
    const ui = createInitialUi({ drawerOpen: false, drawerHeight: 300, railCollapsed: true });
    expect(ui).toEqual({
      drawerOpen: false,
      drawerHeight: 300,
      railCollapsed: true,
      railOverlayOpen: false,
      stagePreviewOpen: false,
    });
    const storage = memoryStorage();
    persistUi(storage, reduceUi(ui, { type: "ui/railOverlay", open: true }));
    expect(JSON.parse(storage.getItem("mixerx.v2.ui") ?? "{}")).toEqual({
      drawerOpen: false,
      drawerHeight: 300,
      railCollapsed: true,
    });
    expect(reduceUi(ui, { type: "ui/drawer", open: false })).toBe(ui);
    expect(reduceUi(ui, { type: "ui/drawerHeight", height: 20 }).drawerHeight).toBe(160);
  });
});
