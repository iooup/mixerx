import { expect, type Page, test } from "@playwright/test";

interface StageStats {
  meanLuma: number;
  histogram: number[];
  seq: number;
}

interface StagePerf {
  fps: number;
  medianFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  gpuMs: number | null;
  longTasks: number;
  longestTaskMs: number;
  frameAgeMs: number;
  scale: number;
  warmedUp: boolean;
}

interface StageHook {
  stats(): Promise<StageStats | null>;
  intent(): { section: string; sceneId: string; flash: number; burst: number; morph: number } | null;
  patch(patch: unknown): void;
  perf(): StagePerf;
  perfReset(): void;
}

interface StageSample {
  luma: number | null;
  section: string;
  flash: number;
  scene: string;
}

/** One luminance sample of the next frame plus the Director's section and scene at that moment. */
const sampleStage = (page: Page): Promise<StageSample> =>
  page.evaluate(async () => {
    const stage = (window as unknown as { mixerxStage?: StageHook }).mixerxStage;
    if (!stage) throw new Error("mixerxStage hook missing");
    const stats = await stage.stats();
    const intent = stage.intent();
    return {
      luma: stats ? stats.meanLuma : null,
      section: intent?.section ?? "none",
      flash: intent?.flash ?? 0,
      scene: intent?.sceneId ?? "",
    };
  });

/** Opens the STAGE popover (native popover: a click toggles, so check the state first). */
async function openStagePopover(page: Page) {
  const popover = page.getByTestId("stage-popover");
  if (!(await popover.isVisible())) await page.getByTestId("stage-badge").click();
  await expect(popover).toBeVisible();
}

async function closeStagePopover(page: Page) {
  const popover = page.getByTestId("stage-popover");
  if (await popover.isVisible()) await page.getByTestId("stage-badge").click();
  await expect(popover).toBeHidden();
}

/** Opens the demo Stage and skips honestly where no adapter can present a WebGPU canvas. */
async function openDemoStage(page: Page, query = "") {
  await page.goto(`/stage?demo=1${query}`);
  const stage = page.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-connected", "true", { timeout: 10_000 });
  let webgpu = await stage.getAttribute("data-webgpu");
  const deadline = Date.now() + 30_000;
  while (webgpu === "pending" && Date.now() < deadline) {
    await page.waitForTimeout(500);
    webgpu = await stage.getAttribute("data-webgpu");
  }
  test.skip(webgpu !== "yes", `WebGPU state "${webgpu}" in this browser build`);
  return stage;
}

async function openConsole(page: Page, autonomy = "copilot") {
  await page.goto("/");
  await page.evaluate((level) => {
    localStorage.setItem("mixerx.v2.session", JSON.stringify({ mode: "mix", autonomy: level, queue: [] }));
  }, autonomy);
  await page.reload();
  await expect(page.getByTestId("onair")).toBeVisible();
}

/** The shortest tracks of the development corpus, so a real load-and-play stays quick. */
async function shortestTrackTitles(page: Page, count = 1): Promise<string[]> {
  const response = await page.request.get("/local-audio/library.json");
  expect(response.ok(), "development manifest must be served in dev").toBeTruthy();
  const manifest = (await response.json()) as { tracks: { title: string; durationSec?: number }[] };
  const sorted = [...manifest.tracks].sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9));
  const titles = sorted.slice(0, count).map((track) => track.title);
  if (titles.length < count) throw new Error("corpus too small");
  return titles;
}

const rowFor = (page: Page, title: string) =>
  page.getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

test.describe("stage", () => {
  test.setTimeout(180_000);

  test("without a session the stage offers to connect or run the demo", async ({ page }) => {
    await page.goto("/stage");
    await expect(page.getByTestId("stage")).toHaveAttribute("data-mode", "connect");
    await page.getByTestId("stage-connect-demo").click();
    await expect(page.getByTestId("stage")).toHaveAttribute("data-demo", "true");
    await expect(page.getByTestId("stage")).toHaveAttribute("data-connected", "true", { timeout: 10_000 });
    await expect(page.getByTestId("scene-library")).toBeVisible();
    await expect(page.getByTestId("director-panel")).toBeVisible();
    // The crowd is opt-in per scene: absent until the DJ adds it to the scene on screen.
    await expect(page.getByTestId("crowd")).toHaveCount(0);
    await page.getByTestId("stage-crowd-toggle").click();
    await expect(page.getByTestId("stage-crowd-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("crowd").locator(".dancer").first()).toBeAttached();
    await page.keyboard.press("c");
    await expect(page.getByTestId("crowd")).toHaveCount(0);
  });

  test("the studio stays on one screen at desktop sizes", async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/stage?demo=1");
      await expect(page.getByTestId("stage")).toHaveAttribute("data-connected", "true", { timeout: 10_000 });
      const report = await page.evaluate(() => {
        const output = document.querySelector('[data-testid="stage-output"]')?.getBoundingClientRect();
        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          outputWidth: output?.width ?? 0,
          outputHeight: output?.height ?? 0,
        };
      });
      expect(report.overflowX, `${width}×${height}`).toBeLessThanOrEqual(1);
      expect(report.overflowY, `${width}×${height}`).toBeLessThanOrEqual(1);
      expect(report.outputWidth).toBeGreaterThan(500);
      expect(report.outputHeight).toBeGreaterThan(300);
    }
  });

  test("the demo signal is legible: beats move the picture, the drop is a discontinuity, breaks are darker", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto("/stage?demo=1&mode=display&speed=4&quality=low");
    const stage = page.getByTestId("stage");
    await expect(stage).toHaveAttribute("data-connected", "true", { timeout: 10_000 });
    // Software adapters cannot present a canvas: skip honestly rather than fail on such machines.
    let webgpu = await stage.getAttribute("data-webgpu");
    const deadline = Date.now() + 30_000;
    while (webgpu === "pending" && Date.now() < deadline) {
      await page.waitForTimeout(500);
      webgpu = await stage.getAttribute("data-webgpu");
    }
    test.skip(webgpu !== "yes", `WebGPU state "${webgpu}" in this browser build`);
    await expect(page.getByTestId("display-hint")).toHaveAttribute("data-visible", "true");

    // Follow sections: the scene changes with the section.
    const scenes = new Set<string>();
    const samples: { t: number; luma: number; section: string; flash: number }[] = [];
    const started = Date.now();
    // 32 bars at 128 BPM = 60 s, played 4× faster: sample one full loop plus a margin.
    while (Date.now() - started < 17_000) {
      const sample = await sampleStage(page);
      if (sample.luma === null) continue;
      samples.push({
        t: Date.now() - started,
        luma: sample.luma,
        section: sample.section,
        flash: sample.flash,
      });
      scenes.add(sample.scene);
    }
    expect(samples.length).toBeGreaterThan(60);
    const bySection = (kind: string) =>
      samples.filter((sample) => sample.section === kind).map((sample) => sample.luma);
    const mean = (values: number[]) =>
      values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
    const drop = bySection("drop");
    const brk = bySection("break");
    expect(drop.length).toBeGreaterThan(10);
    expect(brk.length).toBeGreaterThan(5);
    // (c) mean luminance in the break is below 60 % of the drop.
    const summary = `drop ${mean(drop).toFixed(3)} (${drop.length}) · break ${mean(brk).toFixed(3)} (${brk.length}) · sections ${[...new Set(samples.map((sample) => sample.section))].join(",")}`;
    expect(mean(brk), summary).toBeLessThan(mean(drop) * 0.6);
    // (a) the picture moves with the beat: consecutive drop frames differ measurably.
    let moving = 0;
    for (let i = 1; i < drop.length; i += 1)
      if (Math.abs((drop[i] as number) - (drop[i - 1] as number)) > 0.004) moving += 1;
    expect(moving / drop.length).toBeGreaterThan(0.25);
    // (b) a discontinuity at the drop: the largest jump between consecutive samples happens around a section change.
    let maxJump = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const jump = Math.abs(
        (samples[i] as { luma: number }).luma - (samples[i - 1] as { luma: number }).luma,
      );
      if (jump > maxJump) maxJump = jump;
    }
    expect(maxJump).toBeGreaterThan(0.08);
    expect(scenes.size).toBeGreaterThanOrEqual(3);
  });

  test("warm-up removes the first-switch cost: an eight-scene sweep never hitches", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openDemoStage(page);
    // Every scene's pipelines compile off the main thread and each draws one hidden frame.
    await page.waitForFunction(
      () => (window as unknown as { mixerxStage: StageHook }).mixerxStage.perf().warmedUp === true,
      null,
      { timeout: 40_000 },
    );
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as unknown as { mixerxStage: StageHook }).mixerxStage.perfReset());
    for (let key = 1; key <= 8; key += 1) {
      await page.keyboard.press(String(key));
      await page.waitForTimeout(1500);
    }
    const perf = await page.evaluate(() =>
      (window as unknown as { mixerxStage: StageHook }).mixerxStage.perf(),
    );
    const summary = JSON.stringify(perf);
    expect(perf.longestTaskMs, summary).toBeLessThanOrEqual(50);
    expect(perf.maxFrameMs, summary).toBeLessThan(100);
    expect(perf.fps, summary).toBeGreaterThan(30);
  });

  test("an incoming scene arrives in motion: its first drawn frame is not empty", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    const stage = await openDemoStage(page, "&mode=display&quality=low");
    await page.waitForFunction(
      () => (window as unknown as { mixerxStage: StageHook }).mixerxStage.perf().warmedUp === true,
      null,
      { timeout: 40_000 },
    );
    // Hand-picked scenes, cut transitions: the Director switches on the next bar without a fade.
    await page.evaluate(() =>
      (window as unknown as { mixerxStage: StageHook }).mixerxStage.patch({
        follow: false,
        transition: "cut",
        sceneId: "body-pulse",
      }),
    );
    await page.waitForTimeout(2000);
    for (const scene of ["drop-burst", "cubes", "intro-lines"]) {
      await page.evaluate(
        (id) => (window as unknown as { mixerxStage: StageHook }).mixerxStage.patch({ sceneId: id }),
        scene,
      );
      // First sample once the Director has actually swapped the picture.
      let first: StageSample | null = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const sample = await sampleStage(page);
        if (sample.scene === scene && sample.luma !== null) {
          first = sample;
          break;
        }
      }
      expect(first, `${scene} never came on screen`).not.toBeNull();
      await page.waitForTimeout(2500);
      const settled = await sampleStage(page);
      const summary = `${scene}: first ${first?.luma?.toFixed(4)} · settled ${settled.luma?.toFixed(4)}`;
      expect(settled.luma, summary).not.toBeNull();
      expect(first?.luma ?? 0, summary).toBeGreaterThanOrEqual((settled.luma as number) * 0.3);
    }
    await expect(stage).toHaveAttribute("data-webgpu", "yes");
  });

  test("a track going on air names itself on the Stage, and presets recall a whole look", async ({
    page,
    context,
  }) => {
    await openConsole(page);
    await openStagePopover(page);
    const [studio] = await Promise.all([
      context.waitForEvent("page"),
      page.getByTestId("stage-open-studio").click(),
    ]);
    await closeStagePopover(page);
    await studio.waitForLoadState();
    await expect(studio.getByTestId("stage")).toHaveAttribute("data-connected", "true", {
      timeout: 15_000,
    });

    // Load and start a real track: the lower third names it for the audience.
    const [title, second] = await shortestTrackTitles(page, 2);
    const row = rowFor(page, title as string);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Load A" }).click();
    await expect(page.getByTestId("deck-A-time")).not.toContainText("--:--", { timeout: 60_000 });
    await page.getByTestId("deck-A-play").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");

    const lowerThird = studio.getByTestId("lower-third");
    await expect(lowerThird).toHaveAttribute("data-visible", "true", { timeout: 15_000 });
    await expect(studio.getByTestId("lower-third-title")).toHaveText(title as string, {
      timeout: 15_000,
    });
    // It leaves on its own: six seconds of hold plus the slides.
    await expect(lowerThird).toHaveAttribute("data-visible", "false", { timeout: 20_000 });

    // The night sky: one star per track that has been on air, in the order they went on.
    const sky = studio.getByTestId("night-sky");
    await expect(sky).toHaveAttribute("data-count", "1", { timeout: 10_000 });
    await rowFor(page, second as string)
      .getByRole("button", { name: "Load B" })
      .click();
    await expect(page.getByTestId("deck-B-time")).not.toContainText("--:--", { timeout: 60_000 });
    await page.getByTestId("deck-B-play").click();
    const crossfader = page.getByTestId("crossfader");
    await crossfader.focus();
    await crossfader.press("End");
    await expect(page.getByTestId("deck-B")).toHaveAttribute("data-on-air", "true", { timeout: 10_000 });
    await expect(sky).toHaveAttribute("data-count", "2", { timeout: 10_000 });
    await studio.getByTestId("stage-overlays").locator("summary").first().click();
    await studio.getByTestId("stage-night-sky").locator("[data-value='always']").click();
    await expect(sky).toHaveAttribute("data-visible", "true", { timeout: 5_000 });

    // Presets: save the look on screen, then recall it from the console's STAGE menu.
    await studio.getByTestId("scene-cubes").click();
    studio.on("dialog", (dialog) => void dialog.accept("Lattice"));
    await studio.evaluate(() => {
      window.prompt = () => "Lattice";
    });
    await studio.getByTestId("stage-preset-save").click();
    await expect(studio.getByTestId("stage-preset-5")).toContainText("Lattice");
    await studio.getByTestId("scene-intro-lines").click();
    await expect(studio.getByTestId("stage")).toHaveAttribute("data-scene", "intro-lines", {
      timeout: 10_000,
    });

    await openStagePopover(page);
    await page.getByTestId("stage-apply-preset-5").click();
    await closeStagePopover(page);
    await expect(studio.getByTestId("stage")).toHaveAttribute("data-scene", "cubes", { timeout: 10_000 });
    const session = await page.evaluate(() =>
      (
        window as unknown as {
          mixerx: { invoke(n: string, i: unknown): Promise<{ data: { visuals: { sceneId: string } } }> };
        }
      ).mixerx.invoke("get-session", {}),
    );
    expect(session.data.visuals.sceneId).toBe("cubes");

    // The same preset through the agent, by name.
    await studio.getByTestId("scene-intro-lines").click();
    await expect(studio.getByTestId("stage")).toHaveAttribute("data-scene", "intro-lines", {
      timeout: 10_000,
    });
    const applied = await page.evaluate(() =>
      (
        window as unknown as { mixerx: { invoke(n: string, i: unknown): Promise<{ status: string }> } }
      ).mixerx.invoke("apply-preset", { name: "Lattice" }),
    );
    expect(applied.status).toBe("ok");
    await expect(studio.getByTestId("stage")).toHaveAttribute("data-scene", "cubes", { timeout: 10_000 });
    await studio.close();
  });

  test("the galaxy writes the DJ's message and lets it go", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 560 });
    // Slow music: a phrase is long enough for the springs to settle before the sample is read.
    const stage = await openDemoStage(page, "&mode=display&speed=0.5");
    await page.waitForFunction(
      () => (window as unknown as { mixerxStage: StageHook }).mixerxStage.perf().warmedUp === true,
      null,
      { timeout: 40_000 },
    );
    const morphNow = () =>
      page.evaluate(() => (window as unknown as { mixerxStage: StageHook }).mixerxStage.intent()?.morph ?? 0);
    for (const text of ["HANDS UP", "LAST RECORD"]) {
      await page.evaluate(
        (message) =>
          (window as unknown as { mixerxStage: StageHook }).mixerxStage.patch({
            follow: false,
            transition: "cut",
            sceneId: "drop-burst",
            morph: { text: message, mode: "hold" },
          }),
        text,
      );
      // Reaching 1 proves the mask was not empty: an empty one never leaves "idle".
      await expect
        .poll(morphNow, { timeout: 90_000, message: `"${text}" never assembled` })
        .toBeGreaterThan(0.99);
      await page.waitForTimeout(1500);
      const written = await sampleStage(page);
      expect(written.luma, `"${text}" luma`).not.toBeNull();
      expect(written.luma as number).toBeGreaterThan(0.002);
    }
    // Turning it off releases the particles back into the field.
    await page.evaluate(() =>
      (window as unknown as { mixerxStage: StageHook }).mixerxStage.patch({
        morph: { text: "HANDS UP", mode: "off" },
      }),
    );
    await expect.poll(morphNow, { timeout: 15_000 }).toBe(0);
    await expect(stage).toHaveAttribute("data-webgpu", "yes");
  });

  test("console and stage stay in sync: presence, blackout, scenes, displays", async ({ page, context }) => {
    await openConsole(page);
    const badge = page.getByTestId("stage-badge");
    await expect(badge).toHaveAttribute("data-connected", "false");
    await openStagePopover(page);
    const [studio] = await Promise.all([
      context.waitForEvent("page"),
      page.getByTestId("stage-open-studio").click(),
    ]);
    await closeStagePopover(page);
    await studio.waitForLoadState();
    const stage = studio.getByTestId("stage");
    await expect(stage).toHaveAttribute("data-mode", "studio");
    await expect(stage).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
    await expect(badge).toHaveAttribute("data-connected", "true", { timeout: 10_000 });

    // Blackout from the stage reaches the console, and back.
    await studio.getByTestId("stage-blackout").click();
    await expect(stage).toHaveAttribute("data-blackout", "true");
    await expect(badge).toHaveAttribute("data-blackout", "true", { timeout: 5_000 });
    await openStagePopover(page);
    await page.getByTestId("stage-toggle-blackout").click();
    await expect(stage).toHaveAttribute("data-blackout", "false", { timeout: 5_000 });
    await closeStagePopover(page);

    // apply-scene (Co-DJ) changes the stage's scene; without a beat grid the switch takes half a second.
    const result = await page.evaluate(() =>
      (
        window as unknown as { mixerx: { invoke(n: string, i: unknown): Promise<{ status: string }> } }
      ).mixerx.invoke("apply-scene", { sceneId: "break-haze" }),
    );
    expect(result.status).toBe("ok");
    await expect(stage).toHaveAttribute("data-scene", "break-haze", { timeout: 10_000 });
    await expect(studio.getByTestId("readout-scene")).toHaveText("break-haze");

    // Picking a scene in the library pins it and shows in the console's session.
    await studio.getByTestId("scene-drop-burst").click();
    await expect(stage).toHaveAttribute("data-scene", "drop-burst", { timeout: 10_000 });
    const session = await page.evaluate(() =>
      (
        window as unknown as {
          mixerx: { invoke(n: string, i: unknown): Promise<{ data: { visuals: { sceneId: string } } }> };
        }
      ).mixerx.invoke("get-session", {}),
    );
    expect(session.data.visuals.sceneId).toBe("drop-burst");

    // A display window counts in the badge; the test signal keeps frames flowing.
    await openStagePopover(page);
    const [display] = await Promise.all([
      context.waitForEvent("page"),
      page.getByTestId("stage-open-display").click(),
    ]);
    await closeStagePopover(page);
    await display.waitForLoadState();
    await expect(display.getByTestId("stage")).toHaveAttribute("data-mode", "display");
    await expect(display.getByTestId("stage")).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
    await expect(badge).toHaveAttribute("data-displays", "1", { timeout: 10_000 });
    await studio.getByTestId("stage-test-signal").click();
    await expect(studio.getByTestId("stage-signal")).toContainText("Test signal");
    await display.keyboard.press("Shift+B");
    await expect(display.getByTestId("stage")).toHaveAttribute("data-blackout", "true", { timeout: 5_000 });
    await expect(stage).toHaveAttribute("data-blackout", "true", { timeout: 5_000 });
    await display.close();
    await expect(badge).toHaveAttribute("data-displays", "0", { timeout: 10_000 });
    await studio.close();
    await expect(badge).toHaveAttribute("data-connected", "false", { timeout: 10_000 });
  });
});
