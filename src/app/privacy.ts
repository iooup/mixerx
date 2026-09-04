/**
 * Offline proof. The page asks the browser to fetch an external URL that cannot exist; if the
 * Content-Security-Policy is enforced the request is blocked and the document receives a
 * `securitypolicyviolation` event. Only that event proves enforcement: a rejected fetch alone
 * could be a DNS failure after a real network attempt.
 */

export type CspProbeResult = "enforced" | "not-enforced";

export const CSP_PROBE_URL = "https://csp-probe.invalid/mixerx";

export interface CspProbeDeps {
  fetch(url: string, init: { mode: "no-cors"; cache: "no-store" }): Promise<unknown>;
  /** Registers a violation listener and returns the unsubscribe function. */
  onViolation(handler: (blockedUri: string) => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function probeCsp(deps: CspProbeDeps, timeoutMs = 1500): Promise<CspProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let timer: unknown;

    const finish = (result: CspProbeResult) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      deps.clearTimeout(timer);
      resolve(result);
    };

    unsubscribe = deps.onViolation((blockedUri) => {
      if (blockedUri.startsWith("https://csp-probe.invalid")) finish("enforced");
    });
    timer = deps.setTimeout(() => finish("not-enforced"), timeoutMs);

    deps
      .fetch(CSP_PROBE_URL, { mode: "no-cors", cache: "no-store" })
      .then(() => finish("not-enforced"))
      .catch(() => {
        // A rejection is expected under CSP; the violation event decides.
      });
  });
}

export function browserCspDeps(): CspProbeDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    onViolation(handler) {
      const listener = (event: SecurityPolicyViolationEvent) => handler(event.blockedURI);
      document.addEventListener("securitypolicyviolation", listener);
      return () => document.removeEventListener("securitypolicyviolation", listener);
    },
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}
