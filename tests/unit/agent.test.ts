import { describe, expect, it } from "vitest";
import { activityStore } from "../../src/agent/activity-store";
import { redactSession } from "../../src/agent/redact";
import { ToolRegistry } from "../../src/agent/registry";
import { sceneFor } from "../../src/agent/scenes";
import { validate } from "../../src/agent/schema";
import { arcTarget, planSet, planTransition } from "../../src/agent/transition";
import { permitted, type ToolDefinition, ToolError } from "../../src/agent/types";
import type { TrackAnalysis } from "../../src/state/session";
import { createInitialSession, reduceSession, sessionStore } from "../../src/state/session-store";

const analysis = (
  trackId: string,
  bpm: number,
  sections: TrackAnalysis["sections"],
  camelot = "8A",
): TrackAnalysis => ({
  schemaVersion: 2,
  trackId,
  grid: {
    kind: "constant",
    bpm,
    firstBeatSec: 0,
    downbeatOffset: 0,
    downbeatConfirmed: true,
    confidence: 0.9,
    candidates: [],
  },
  key: { camelot, name: "A minor", confidence: 0.7 },
  loudness: { integratedLufs: -9.5, truePeakDb: -0.3, gainSuggestionDb: -4.5 },
  energyPerBar: new Float32Array(sections.length ? (sections[sections.length - 1]?.endBar ?? 0) : 0).fill(
    0.7,
  ),
  sections,
  waveform: { hop: 1024, bins: new Uint8Array(0), overview: new Uint8Array(0) },
  analysedAt: 0,
});

describe("schema validation", () => {
  it("rejects wrong types, unknown fields, and out-of-range values with messages", () => {
    const schema = {
      type: "object" as const,
      properties: {
        deck: { type: "string" as const, enum: ["A", "B"] },
        limit: { type: "integer" as const, minimum: 1, maximum: 5 },
        ids: { type: "array" as const, items: { type: "string" as const }, maxItems: 2 },
      },
      required: ["deck"],
      additionalProperties: false,
    };
    expect(validate(schema, { deck: "A", limit: 3, ids: ["x"] })).toEqual([]);
    expect(validate(schema, {})).toEqual(["input.deck is required"]);
    expect(validate(schema, { deck: "C" })[0]).toContain("one of A, B");
    expect(validate(schema, { deck: "A", limit: 9 })[0]).toContain("≤ 5");
    expect(validate(schema, { deck: "A", limit: 1.5 })[0]).toContain("integer");
    expect(validate(schema, { deck: "A", extra: 1 })[0]).toContain("not a known field");
    expect(validate(schema, { deck: "A", ids: ["a", "b", "c"] })[0]).toContain("at most 2");
    expect(validate(schema, "nope")).toEqual(["input must be an object"]);
  });
});

describe("policy and registry", () => {
  it("permits by autonomy level", () => {
    expect(permitted("read", "observe")).toBe(true);
    expect(permitted("prepare", "observe")).toBe(false);
    expect(permitted("prepare", "prepare")).toBe(true);
    expect(permitted("act", "prepare")).toBe(false);
    expect(permitted("act", "copilot")).toBe(true);
  });

  it("executes, proposes, or errors depending on autonomy, and accepts proposals with user confirmation", async () => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const act: ToolDefinition<{ value: number }, { done: boolean }> = {
      name: "test-act",
      title: "Test act",
      description: "acts",
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      access: "act",
      annotations: { readOnlyHint: false },
      contexts: ["copilot-only"],
      describe: ({ value }) => ({ kind: "enter", title: `Act ${value}`, reasons: ["because"] }),
      handler: async ({ value }, ctx) => {
        calls.push(`act:${value}:${ctx.confirmedBy ?? "auto"}`);
        return {
          data: { done: true },
          undo: {
            label: "undo act",
            run: async () => {
              calls.push("undo");
            },
          },
        };
      },
    };
    const failing: ToolDefinition<Record<string, never>, never> = {
      name: "test-fail",
      title: "Fails",
      description: "fails with guidance",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      access: "read",
      annotations: { readOnlyHint: true },
      contexts: ["mix"],
      handler: async () => {
        throw new ToolError("Deck B is on air; wait for the fader.");
      },
    };
    registry.register(act);
    registry.register(failing);
    activityStore.dispatch({ type: "activity/clear" });

    sessionStore.dispatch({ type: "autonomy/set", autonomy: "prepare" });
    const proposed = await registry.invoke("test-act", { value: 1 }, { caller: "local" });
    expect(proposed.status).toBe("proposed");
    expect(proposed.confirmationRequired).toBe(true);
    const proposal = sessionStore.getState().proposals.find((entry) => entry.id === proposed.proposalId);
    expect(proposal?.title).toBe("Act 1");
    expect(proposal?.status).toBe("open");
    expect(calls).toEqual([]);

    const accepted = await registry.accept(proposed.proposalId as string);
    expect(accepted.status).toBe("ok");
    expect(calls).toEqual(["act:1:user"]);
    expect(sessionStore.getState().proposals.find((entry) => entry.id === proposed.proposalId)?.status).toBe(
      "accepted",
    );
    const log = activityStore.getState().entries;
    expect(log[log.length - 1]?.confirmedBy).toBe("user");
    expect(log[log.length - 1]?.undoLabel).toBe("undo act");

    sessionStore.dispatch({ type: "autonomy/set", autonomy: "copilot" });
    const direct = await registry.invoke("test-act", { value: 2 }, { caller: "webmcp" });
    expect(direct.status).toBe("ok");
    expect(direct.liveOutputChanged).toBe(true);
    expect(calls).toContain("act:2:auto");

    const invalid = await registry.invoke("test-act", { value: "x" }, { caller: "harness" });
    expect(invalid.status).toBe("error");
    expect(invalid.error).toContain("must be a number");
    const unknown = await registry.invoke("nope", {}, { caller: "harness" });
    expect(unknown.error).toContain("Unknown tool");
    const failed = await registry.invoke("test-fail", {}, { caller: "webmcp" });
    expect(failed).toEqual({
      status: "error",
      error: "Deck B is on air; wait for the fader.",
      liveOutputChanged: false,
    });

    expect(registry.forContext("learn", "copilot").map((tool) => tool.name)).toEqual([]);
    expect(registry.forContext("mix", "prepare").map((tool) => tool.name)).toEqual(["test-fail"]);
    expect(registry.forContext("mix", "copilot").map((tool) => tool.name)).toEqual(["test-act", "test-fail"]);
    sessionStore.dispatch({ type: "autonomy/set", autonomy: "prepare" });
  });
});

describe("planners", () => {
  it("plans a phrase-aligned transition at A's section boundary with EQ moves and reasons", () => {
    const a = analysis("a", 128, [
      { kind: "intro", startBar: 0, endBar: 16, energy: 0.3 },
      { kind: "drop", startBar: 16, endBar: 48, energy: 0.9 },
      { kind: "outro", startBar: 48, endBar: 64, energy: 0.4 },
    ]);
    const b = analysis(
      "b",
      130,
      [
        { kind: "intro", startBar: 0, endBar: 16, energy: 0.3 },
        { kind: "drop", startBar: 16, endBar: 40, energy: 0.9 },
      ],
      "9A",
    );
    // 128 BPM → 1.875 s per bar; bar 40 is at 75 s: the drop ends at bar 48 (8 bars ahead)
    const plan = planTransition({
      from: "A",
      to: "B",
      fromAnalysis: a,
      toAnalysis: b,
      fromPositionSec: 75,
      toCueSec: 0,
    });
    expect(plan.entryBarOnFrom).toBe(48);
    expect(plan.lengthBars).toBe(16);
    expect(plan.eqMoves).toEqual([
      { atBar: 48, deck: "B", band: "low", toDb: -26 },
      { atBar: 56, deck: "A", band: "low", toDb: -26 },
      { atBar: 56, deck: "B", band: "low", toDb: 0 },
    ]);
    expect(plan.reasons.join(" | ")).toMatch(/drop ends in 8 bars → outro/);
    expect(plan.reasons.join(" | ")).toMatch(/key 8A→9A \(neighbour\)/);
    expect(plan.reasons.join(" | ")).toMatch(/tempo \+1\.6 %/);
    // Far from a boundary: the next phrase boundary at least 4 bars ahead.
    const later = planTransition({
      from: "A",
      to: "B",
      fromAnalysis: a,
      toAnalysis: b,
      fromPositionSec: 20 * 1.875,
      toCueSec: 0,
    });
    expect(later.entryBarOnFrom).toBe(48);
    const early = planTransition({
      from: "A",
      to: "B",
      fromAnalysis: a,
      toAnalysis: b,
      fromPositionSec: 2 * 1.875,
      toCueSec: 0,
      maxLeadBars: 8,
    });
    expect(early.entryBarOnFrom).toBe(8);
  });

  it("orders a set along an energy arc", () => {
    expect(arcTarget(0, "peak", 2, 9)).toBe(2);
    expect(arcTarget(0.7, "peak", 2, 9)).toBeCloseTo(9);
    expect(arcTarget(1, "rise", 2, 9)).toBe(9);
    const set = planSet([
      { id: "hi", energy: 9, camelot: "8A", bpm: 130 },
      { id: "lo", energy: 3, camelot: "8A", bpm: 126 },
      { id: "mid", energy: 6, camelot: "9A", bpm: 128 },
      { id: "mid2", energy: 7, camelot: "8B", bpm: 129 },
    ]);
    expect(set.order[0]).toBe("lo");
    expect(set.order.indexOf("hi")).toBeGreaterThan(set.order.indexOf("mid"));
    expect(set.reasons).toHaveLength(4);
  });

  it("maps sections and energy to provisional scenes", () => {
    expect(sceneFor("drop", 8).id).toBe("drop-burst");
    expect(sceneFor("break", 2).id).toBe("break-haze");
    expect(sceneFor(null, 8).id).toBe("drop-burst");
    expect(sceneFor(null, 2).id).toBe("intro-lines");
  });
});

describe("redaction", () => {
  it("exposes summaries without waveform bytes or file details", () => {
    let session = createInitialSession();
    session = reduceSession(session, {
      type: "deck/track",
      deck: "A",
      track: {
        id: "t",
        title: "T",
        artist: "X",
        durationSec: 10,
        sizeBytes: 5,
        source: "folder",
        hasArtwork: true,
      },
    });
    session = reduceSession(session, {
      type: "deck/analysis",
      deck: "A",
      analysis: analysis("t", 120, [{ kind: "body", startBar: 0, endBar: 4, energy: 0.5 }]),
    });
    const redacted = redactSession(session);
    const text = JSON.stringify(redacted);
    expect(redacted.decks.A.analysis?.bpm).toBe(120);
    expect(redacted.decks.A.analysis?.energyPerBar).toHaveLength(4);
    expect(text).not.toContain("waveform");
    expect(text).not.toContain("sizeBytes");
    expect(text).not.toContain("hasArtwork");
    expect(redacted.routing).toEqual({
      mode: "single",
      configured: false,
      cueConnected: false,
      latencyMs: { master: 0, cue: 0 },
    });
  });
});
