/**
 * View Transitions: panels that appear, disappear or swap places are
 * cross-faded by the platform instead of popping. Feature-detected (Chrome 111, Firefox 144,
 * Safari 18) and skipped entirely under reduced motion — the state change always happens, with or
 * without the animation, so nothing depends on the API being there.
 */

/** Older engines have no `startViewTransition`; lib.dom declares it as required, so probe for it. */
type MaybeViewTransitions = { startViewTransition?: Document["startViewTransition"] };

function motionIsReduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;
}

/** Applies `mutate` inside a View Transition where the platform has one; otherwise applies it now. */
export function withViewTransition(mutate: () => void): void {
  const doc = typeof document === "undefined" ? null : (document as MaybeViewTransitions);
  const start = doc?.startViewTransition;
  if (!doc || typeof start !== "function" || motionIsReduced()) {
    mutate();
    return;
  }
  try {
    const transition = start.call(doc as Document, mutate);
    // A transition that is skipped (another one started, the tab hid) rejects these; the state
    // change has already happened, so there is nothing to report.
    transition.finished?.catch?.(() => {});
    transition.ready?.catch?.(() => {});
    transition.updateCallbackDone?.catch?.(() => {});
  } catch {
    mutate();
  }
}
