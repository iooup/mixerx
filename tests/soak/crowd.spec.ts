import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openCrowdSession } from "../helpers/crowd-session";

interface Perf {
  fps: number;
  p95FrameMs: number;
  medianFrameMs: number;
  gpuMs: number | null;
  scale: number;
  warmedUp: boolean;
}
interface Hook {
  perf(): Perf;
  perfReset(): void;
  patch(value: unknown): void;
  intent(): { onAir: string; audio: { rms: number }; beat: { bpm: number }; section: string };
}

test("30 minutes of real audio, changing pet formations and a 1440p audience display", async ({
  page,
  context,
}, testInfo) => {
  const durationMs = 30 * 60_000;
  const errors: string[] = [];
  const external: string[] = [];
  context.on("page", (p) => p.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  context.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).hostname !== "127.0.0.1") external.push(url);
  });
  const { studio, display, tracks } = await openCrowdSession(page, context);
  await display.setViewportSize({ width: 2560, height: 1440 });
  await expect(display.getByTestId("stage")).toHaveAttribute("data-webgpu", "yes", { timeout: 30_000 });
  await expect
    .poll(
      () => display.evaluate(() => (window as unknown as { mixerxStage: Hook }).mixerxStage.perf().warmedUp),
      { timeout: 40_000 },
    )
    .toBe(true);
  // Finish background analysis before measuring a stable, two-deck session.
  await expect(page.locator("tr.track-row .track-row__state--ready")).toHaveCount(16, { timeout: 180_000 });
  // Start the measurement with a full track remaining after the analysis warm-up.
  if ((await page.getByTestId("deck-A").getAttribute("data-playing")) !== "true")
    await page.getByTestId("deck-A-play").click();
  await expect(page.getByTestId("deck-A")).toHaveAttribute("data-playing", "true");
  await page.getByTestId("deck-A-cue").click();
  await expect(page.getByTestId("deck-A")).toHaveAttribute("data-playing", "false");
  await page.getByTestId("deck-A-play").click();
  await expect(page.getByTestId("deck-A")).toHaveAttribute("data-playing", "true");
  const sessions = await Promise.all([page, studio, display].map((p) => context.newCDPSession(p)));
  for (const cdp of sessions) await cdp.send("Performance.enable");
  const sceneIds = ["build-rise", "break-haze", "cubes", "intro-lines"];
  const samples: Record<string, unknown>[] = [];
  const summaries: { heapMiB: number; nodes: number; fps: number; p95: number }[] = [];
  let active: "A" | "B" = "A";
  let switchedAt = 0;
  let minute = -1;
  const observedFrames = new Set<string>();
  let audibleSamples = 0;
  const started = Date.now();
  const artifactDir = testInfo.outputPath("crowd-soak");
  mkdirSync(artifactDir, { recursive: true });
  const save = (status: string) =>
    writeFileSync(
      `${artifactDir}/soak.json`,
      `${JSON.stringify(
        {
          status,
          startedAt: new Date(started).toISOString(),
          elapsedSec: (Date.now() - started) / 1000,
          targetSec: durationMs / 1000,
          viewport: [2560, 1440],
          tracks: tracks.map((track) => track.title),
          memoryMetric:
            "Sum of console, studio and display JavaScript heaps (CDP JSHeapUsedSize), not total process/GPU memory; no forced GC",
          samples,
          errors,
          externalRequests: external,
        },
        null,
        2,
      )}\n`,
    );
  try {
    while (Date.now() - started < durationMs) {
      const elapsed = Date.now() - started;
      if (elapsed - switchedAt > 90_000) {
        const next: "A" | "B" = active === "A" ? "B" : "A";
        await expect(page.getByTestId(`deck-${next}`)).toHaveAttribute("data-playing", "false");
        await page.getByTestId(`deck-${next}-play`).click();
        await expect(page.getByTestId(`deck-${next}`)).toHaveAttribute("data-playing", "true");
        await page.getByTestId("crossfader").focus();
        await page.getByTestId("crossfader").press(next === "B" ? "End" : "Home");
        await expect(page.getByTestId(`deck-${next}`)).toHaveAttribute("data-on-air", "true");
        await page.getByTestId(`deck-${active}-cue`).click();
        await expect(page.getByTestId(`deck-${active}`)).toHaveAttribute("data-playing", "false");
        active = next;
        switchedAt = elapsed;
      }
      const nextMinute = Math.floor(elapsed / 60_000);
      if (nextMinute !== minute) {
        minute = nextMinute;
        const count = [4, 8, 10][minute % 3] as number;
        await studio.evaluate(
          ({ ids, scene, count }) => {
            (window as unknown as { mixerxStage: Hook }).mixerxStage.patch({
              follow: false,
              sceneId: scene,
              crowdScenes: ids,
              crowdStyles: Object.fromEntries(ids.map((id) => [id, "mixed"])),
              crowdLayouts: Object.fromEntries(ids.map((id) => [id, { count, size: 1, spacing: 1 }])),
            });
          },
          { ids: sceneIds, scene: sceneIds[minute % sceneIds.length] as string, count },
        );
        await page.getByTestId(`deck-${active}-tempo`).focus();
        await page.getByTestId(`deck-${active}-tempo`).press(minute % 2 ? "End" : "Home");
        await display.evaluate(() => (window as unknown as { mixerxStage: Hook }).mixerxStage.perfReset());
      }
      await page.waitForTimeout(10_000);
      const state = await display.evaluate(() => {
        const stage = (window as unknown as { mixerxStage: Hook }).mixerxStage;
        const intent = stage.intent();
        const crowd = document.querySelector('[data-testid="crowd"]');
        return {
          perf: stage.perf(),
          onAir: intent.onAir,
          rms: intent.audio.rms,
          bpm: intent.beat.bpm,
          section: intent.section,
          character: crowd?.getAttribute("data-character"),
          count: crowd?.getAttribute("data-count"),
          frame: crowd?.getAttribute("data-frame"),
          asset: crowd?.getAttribute("data-asset"),
        };
      });
      const memory = await Promise.all(
        sessions.map(async (cdp) => {
          const result = await cdp.send("Performance.getMetrics");
          const metrics = Object.fromEntries(
            result.metrics.map((m: { name: string; value: number }) => [m.name, m.value]),
          );
          expect(Number(metrics.JSHeapUsedSize), "Heap measurement must be available").toBeGreaterThan(0);
          expect(Number(metrics.Nodes), "DOM measurement must be available").toBeGreaterThan(0);
          return {
            heapMiB: Number(metrics.JSHeapUsedSize ?? 0) / 1024 / 1024,
            nodes: Number(metrics.Nodes ?? 0),
          };
        }),
      );
      const heapMiB = memory.reduce((sum, m) => sum + m.heapMiB, 0);
      const nodes = memory.reduce((sum, m) => sum + m.nodes, 0);
      summaries.push({ heapMiB, nodes, fps: state.perf.fps, p95: state.perf.p95FrameMs });
      samples.push({
        elapsedSec: Math.round((Date.now() - started) / 1000),
        ...state,
        heapMiB: Math.round(heapMiB * 10) / 10,
        nodes,
      });
      if (state.frame) observedFrames.add(state.frame);
      if (state.onAir !== "none" && state.rms > 0.001) audibleSamples++;
      expect(state.asset).toBe("ready");
      expect(state.character).toBe("mixed");
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      save("running");
      process.stdout.write(
        `SOAK ${Math.round((Date.now() - started) / 60000)} / 30 min · ${state.count} pets · ${state.perf.fps} FPS · p95 ${state.perf.p95FrameMs} ms · JS heap ${heapMiB.toFixed(1)} MiB\n`,
      );
    }
    const early = summaries.slice(6, 18);
    const late = summaries.slice(-12);
    const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
    const heapGrowth = mean(late.map((s) => s.heapMiB)) - mean(early.map((s) => s.heapMiB));
    const nodeGrowth = mean(late.map((s) => s.nodes)) - mean(early.map((s) => s.nodes));
    expect(Date.now() - started).toBeGreaterThanOrEqual(durationMs);
    expect(audibleSamples / samples.length).toBeGreaterThan(0.85);
    expect(observedFrames.size).toBeGreaterThan(12);
    expect(heapGrowth, "Late versus early JS heap growth, without forced GC").toBeLessThan(40);
    expect(nodeGrowth, "DOM nodes must remain bounded across formation changes").toBeLessThan(500);
    expect(Math.max(...summaries.map((s) => s.heapMiB))).toBeLessThan(250);
    expect(
      summaries.filter((s) => s.fps >= 55).length / summaries.length,
      "1440p near-60-FPS sample ratio",
    ).toBeGreaterThan(0.9);
    await display.screenshot({ path: `${artifactDir}/soak-display-1440p.png` });
    save("passed");
  } catch (error) {
    save("failed");
    throw error;
  } finally {
    for (const deck of ["A", "B"]) {
      if ((await page.getByTestId(`deck-${deck}`).getAttribute("data-playing")) === "true")
        await page.getByTestId(`deck-${deck}-play`).click();
    }
    await testInfo.attach("soak-report", {
      path: `${artifactDir}/soak.json`,
      contentType: "application/json",
    });
  }
});
