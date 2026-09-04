import { describe, expect, it } from "vitest";
import { detectModelContext } from "../../src/agent/detect";
import { type CspProbeDeps, probeCsp } from "../../src/app/privacy";

function fakeDeps(options: { fetchOutcome: "reject" | "resolve"; violation?: string | null }) {
  let handler: ((blockedUri: string) => void) | null = null;
  const timers: (() => void)[] = [];
  const deps: CspProbeDeps = {
    fetch: () => {
      queueMicrotask(() => {
        if (options.violation) handler?.(options.violation);
      });
      return options.fetchOutcome === "reject"
        ? Promise.reject(new TypeError("blocked"))
        : Promise.resolve({});
    },
    onViolation(next) {
      handler = next;
      return () => {
        handler = null;
      };
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
  };
  return {
    deps,
    fireTimeout: () => {
      for (const callback of timers) callback();
    },
  };
}

describe("probeCsp", () => {
  it("reports enforcement only when the browser reports a violation for the probe URL", async () => {
    const { deps } = fakeDeps({ fetchOutcome: "reject", violation: "https://csp-probe.invalid" });
    await expect(probeCsp(deps)).resolves.toBe("enforced");
  });

  it("treats a successful external fetch as a missing policy", async () => {
    const { deps } = fakeDeps({ fetchOutcome: "resolve", violation: null });
    await expect(probeCsp(deps)).resolves.toBe("not-enforced");
  });

  it("treats a rejected fetch without a violation as a real network attempt", async () => {
    const { deps, fireTimeout } = fakeDeps({ fetchOutcome: "reject", violation: null });
    const result = probeCsp(deps);
    await Promise.resolve();
    fireTimeout();
    await expect(result).resolves.toBe("not-enforced");
  });

  it("ignores violations for other URLs", async () => {
    const { deps, fireTimeout } = fakeDeps({ fetchOutcome: "reject", violation: "https://other.invalid" });
    const result = probeCsp(deps);
    await Promise.resolve();
    await Promise.resolve();
    fireTimeout();
    await expect(result).resolves.toBe("not-enforced");
  });
});

describe("detectModelContext", () => {
  const registerTool = () => Promise.resolve();

  it("prefers document.modelContext and falls back to the deprecated navigator alias", () => {
    expect(detectModelContext({ document: { modelContext: { registerTool } }, navigator: {} }).surface).toBe(
      "document",
    );
    expect(detectModelContext({ document: {}, navigator: { modelContext: { registerTool } } }).surface).toBe(
      "navigator",
    );
    expect(detectModelContext({ document: {}, navigator: {} })).toEqual({
      available: false,
      surface: null,
      context: null,
    });
    expect(detectModelContext({ document: { modelContext: { registerTool: "no" } } }).available).toBe(false);
  });
});
