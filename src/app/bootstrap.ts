import { detectModelContext } from "../agent/detect";
import { persistPreferences, sessionStore } from "../state/session-store";
import { safeStorage } from "../state/store";
import { persistUi, uiStore } from "../state/ui-store";
import { browserCspDeps, probeCsp } from "./privacy";

/** One-time wiring between the browser environment and the stores. */
export function bootstrap(): void {
  const storage = safeStorage();

  sessionStore.dispatch({ type: "privacy/isolation", isolated: globalThis.crossOriginIsolated === true });

  const detection = detectModelContext();
  sessionStore.dispatch({
    type: "agent/webmcp",
    status: detection.available ? "available" : "unavailable",
    toolCount: 0,
  });

  void probeCsp(browserCspDeps()).then((result) => {
    sessionStore.dispatch({ type: "privacy/csp", enforced: result === "enforced" });
  });

  sessionStore.subscribe(() => persistPreferences(storage, sessionStore.getState()));
  uiStore.subscribe(() => persistUi(storage, uiStore.getState()));
}
