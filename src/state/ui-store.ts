import { createStore, readJson, safeStorage, useStore, writeJson } from "./store";

export const UI_STORAGE_KEY = "mixerx.v2.ui";
export const DRAWER_MIN_HEIGHT = 160;
export const DRAWER_DEFAULT_HEIGHT = 240;

export interface UiState {
  drawerOpen: boolean;
  drawerHeight: number;
  railCollapsed: boolean; // persisted preference for wide layouts
  railOverlayOpen: boolean; // transient: rail shown as an overlay on narrow layouts
  stagePreviewOpen: boolean; // transient: corner preview of the audience output
}

export type UiEvent =
  | { type: "ui/drawer"; open: boolean }
  | { type: "ui/drawerHeight"; height: number }
  | { type: "ui/rail"; collapsed: boolean }
  | { type: "ui/railOverlay"; open: boolean }
  | { type: "ui/stagePreview"; open: boolean };

export function createInitialUi(stored: Partial<UiState> | null = null): UiState {
  return {
    drawerOpen: typeof stored?.drawerOpen === "boolean" ? stored.drawerOpen : true,
    drawerHeight: clampDrawerHeight(stored?.drawerHeight ?? DRAWER_DEFAULT_HEIGHT),
    railCollapsed: typeof stored?.railCollapsed === "boolean" ? stored.railCollapsed : false,
    railOverlayOpen: false,
    stagePreviewOpen: false,
  };
}

export function clampDrawerHeight(height: number, viewportHeight = 900): number {
  const numeric = Number.isFinite(height) ? height : DRAWER_DEFAULT_HEIGHT;
  const max = Math.max(DRAWER_MIN_HEIGHT, Math.round(viewportHeight * 0.7));
  return Math.min(max, Math.max(DRAWER_MIN_HEIGHT, Math.round(numeric)));
}

export function reduceUi(state: UiState, event: UiEvent): UiState {
  switch (event.type) {
    case "ui/drawer":
      return state.drawerOpen === event.open ? state : { ...state, drawerOpen: event.open };
    case "ui/drawerHeight": {
      const height = clampDrawerHeight(event.height);
      return state.drawerHeight === height ? state : { ...state, drawerHeight: height };
    }
    case "ui/rail":
      return state.railCollapsed === event.collapsed ? state : { ...state, railCollapsed: event.collapsed };
    case "ui/railOverlay":
      return state.railOverlayOpen === event.open ? state : { ...state, railOverlayOpen: event.open };
    case "ui/stagePreview":
      return state.stagePreviewOpen === event.open ? state : { ...state, stagePreviewOpen: event.open };
    default:
      return state;
  }
}

let lastPersisted: string | null = null;

export function persistUi(storage: Storage | null, state: UiState): void {
  const { drawerOpen, drawerHeight, railCollapsed } = state;
  const serialised = JSON.stringify({ drawerOpen, drawerHeight, railCollapsed });
  if (serialised === lastPersisted) return;
  lastPersisted = serialised;
  writeJson(storage, UI_STORAGE_KEY, { drawerOpen, drawerHeight, railCollapsed });
}

export const uiStore = createStore(
  createInitialUi(readJson<Partial<UiState>>(safeStorage(), UI_STORAGE_KEY)),
  reduceUi,
);

const identity = (state: UiState) => state;

export function useUi(): UiState {
  return useStore(uiStore, identity);
}
