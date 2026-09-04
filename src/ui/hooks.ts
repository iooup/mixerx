import { useSyncExternalStore } from "react";
import { uiStore, useUi } from "../state/ui-store";

export const NARROW_LAYOUT_QUERY = "(max-width: 1279px)";

/** Reactive media query. Returns false during server-less first paint when matchMedia is missing. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/**
 * The agent rail is a persisted, collapsible column on wide layouts and a transient overlay
 * on narrow ones.
 */
export function useRail(): { narrow: boolean; collapsed: boolean; toggle(): void } {
  const narrow = useMediaQuery(NARROW_LAYOUT_QUERY);
  const { railCollapsed, railOverlayOpen } = useUi();
  const collapsed = narrow ? !railOverlayOpen : railCollapsed;
  const toggle = () => {
    const state = uiStore.getState();
    if (narrow) uiStore.dispatch({ type: "ui/railOverlay", open: !state.railOverlayOpen });
    else uiStore.dispatch({ type: "ui/rail", collapsed: !state.railCollapsed });
  };
  return { narrow, collapsed, toggle };
}
