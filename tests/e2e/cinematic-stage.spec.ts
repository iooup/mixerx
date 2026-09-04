import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { Intent } from "../../src/visuals/director";
import type { StageSettings } from "../../src/visuals/protocol";

interface StageHook {
  patch(patch: Partial<StageSettings>): void;
  intent(): Intent;
  stats(): Promise<{ meanLuma: number }>;
  renderer(): { lastError: string | null; warmedUp: boolean; thumbnailFrames: number };
}
const patch = (page: Page, value: Partial<StageSettings>) =>
  page.evaluate((value) => (window as unknown as { mixerxStage: StageHook }).mixerxStage.patch(value), value);
const worlds = ["cinematic-phoenix", "cinematic-gate", "cinematic-lotus", "cinematic-crystal"];

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: "on", size: { width: 1440, height: 900 } },
});

test("cinematic controls fit both desktop checkpoints", async ({ page }, info) => {
  await page.goto("/stage?demo=1");
  await expect(page.getByTestId("stage")).toHaveAttribute("data-webgpu", "yes", { timeout: 30_000 });
  await patch(page, {
    sceneId: "cinematic-phoenix",
    follow: false,
    transition: "cut",
    crowdScenes: [],
    lowerThird: false,
  });
  await expect(page.getByTestId("stage")).toHaveAttribute("data-scene", "cinematic-phoenix");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (window as unknown as { mixerxStage: StageHook }).mixerxStage.stats()).meanLuma,
      ),
    )
    .toBeGreaterThan(0.04);
  await expect(page.getByRole("radio", { name: "Cinematic", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.getByTestId("stage-intensity")).toBeInViewport();
    await expect(page.getByTestId("stage-follow")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    );
    await page.screenshot({ path: info.outputPath(`cinematic-ar-${size.width}.png`) });
  }
});

test("four cinematic worlds render with calm luminance, shared controls and faithful thumbnails", async ({
  page,
}, info) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:"))
      external.push(request.url());
  });
  await page.goto("/stage?demo=1&speed=1.1328125");
  const stage = page.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-webgpu", "yes", { timeout: 30_000 });
  await patch(page, {
    follow: false,
    transition: "cut",
    intensity: 1,
    photosensitiveSafe: false,
    crowdScenes: [],
    nightSky: "off",
    lowerThird: false,
  });
  await page.getByTestId("scene-category").locator('[data-value="cinematic"]').click();
  await expect(page.locator(".scene-card")).toHaveCount(4);
  await expect(page.getByTestId("stage-intensity")).toBeVisible();
  await expect(page.getByTestId("stage-follow")).toBeVisible();
  await expect(page.getByTestId("stage-palette")).not.toBeVisible();
  await expect(page.getByTestId("stage-appearance")).not.toHaveAttribute("open");

  for (const id of worlds) {
    await page.getByTestId(`scene-${id}`).click();
    await expect(stage).toHaveAttribute("data-scene", id, { timeout: 10_000 });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await (window as unknown as { mixerxStage: StageHook }).mixerxStage.stats()).meanLuma,
        ),
      )
      .toBeGreaterThan(0.04);
    const samples = await page.evaluate(async () => {
      const hook = (window as unknown as { mixerxStage: StageHook }).mixerxStage;
      const values: number[] = [];
      let flashes = 0;
      for (let i = 0; i < 28; i++) {
        values.push((await hook.stats()).meanLuma);
        flashes += hook.intent().flash + hook.intent().strobe;
      }
      return { values, flashes, error: hook.renderer().lastError, thumbs: hook.renderer().thumbnailFrames };
    });
    expect(samples.error).toBeNull();
    expect(samples.flashes).toBe(0);
    expect(samples.thumbs).toBeGreaterThan(0);
    expect(Math.max(...samples.values)).toBeLessThan(0.7);
    const jumps = samples.values.slice(1).map((value, i) => Math.abs(value - (samples.values[i] ?? value)));
    expect(Math.max(...jumps)).toBeLessThan(0.035);
    const before = await page.getByTestId("stage-canvas").screenshot();
    await page.waitForTimeout(900);
    expect(await page.getByTestId("stage-canvas").screenshot()).not.toEqual(before);
    await page.screenshot({ path: info.outputPath(`${id}-1440.png`) });
  }

  await page.getByTestId("stage-appearance").locator("summary").click();
  await page.getByTestId("stage-reduced").check();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { mixerxStage: StageHook }).mixerxStage.intent().reducedMotion,
      ),
    )
    .toBe(true);
  await page.getByTestId("stage-reduced").uncheck();
  await page.getByTestId("stage-appearance").locator("summary").click();
  await page.getByTestId("stage-intensity").press("Home");
  await expect(page.getByTestId("stage-intensity")).toHaveValue("0");
  await page.getByTestId("stage-intensity").press("End");
  await expect(page.getByTestId("stage-intensity")).toHaveValue("1");
  await page.getByTestId("scene-cinematic-phoenix").click();
  await page.keyboard.press("2");
  await expect(stage).toHaveAttribute("data-scene", "cinematic-gate");

  await patch(page, { transition: "dissolve" });
  await page.getByTestId("scene-cinematic-lotus").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { mixerxStage: StageHook }).mixerxStage.intent().transition?.to,
      ),
    )
    .toBe("cinematic-lotus");
  await page.getByTestId("scene-category").locator('[data-value="simple"]').click();
  await expect(stage).toHaveAttribute("data-scene", "line-waves");
  expect(
    await page.evaluate(
      () => (window as unknown as { mixerxStage: StageHook }).mixerxStage.intent().transition,
    ),
  ).toBeNull();
  await page.getByTestId("scene-category").locator('[data-value="cinematic"]').click();
  await expect(stage).toHaveAttribute("data-scene", "cinematic-lotus");
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("stage-follow")).toBeInViewport();
  await page.screenshot({ path: info.outputPath("cinematic-1024.png") });
  const a11y = await new AxeBuilder({ page })
    .include('[data-testid="scene-library"]')
    .include('[data-testid="director-panel"]')
    .analyze();
  expect(a11y.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.keyboard.press("Shift+B");
  await expect(stage).toHaveAttribute("data-scene", "blackout");
  expect(
    await page.evaluate(
      async () => (await (window as unknown as { mixerxStage: StageHook }).mixerxStage.stats()).meanLuma,
    ),
  ).toBeLessThan(0.004);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("cinematic selections and shared controls persist and reach an audience display", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByTestId("stage-badge").click();
  const [studio] = await Promise.all([
    context.waitForEvent("page"),
    page.getByTestId("stage-open-studio").click(),
  ]);
  await expect(studio.getByTestId("stage")).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
  await patch(studio, { follow: false, transition: "cut", sceneId: "cinematic-lotus", intensity: 0.4 });
  await expect(studio.getByTestId("stage")).toHaveAttribute("data-scene", "cinematic-lotus");
  const [display] = await Promise.all([
    context.waitForEvent("page"),
    studio.getByTestId("stage-open-display").click(),
  ]);
  await expect(display.getByTestId("stage")).toHaveAttribute("data-scene", "cinematic-lotus", {
    timeout: 15_000,
  });
  await expect(display.getByTestId("director-panel")).toHaveCount(0);
  studio.once("dialog", (dialog) => void dialog.accept("Moon garden"));
  await studio.getByTestId("stage-preset-save").click();
  await expect(studio.getByTestId("stage-preset-5")).toContainText("Moon garden");
  await studio.getByTestId("scene-cinematic-crystal").click();
  await expect(display.getByTestId("stage")).toHaveAttribute("data-scene", "cinematic-crystal");
  await studio.getByTestId("stage-preset-5").click();
  await expect(display.getByTestId("stage")).toHaveAttribute("data-scene", "cinematic-lotus");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mixerx.v2.stage") ?? "{}").sceneId))
    .toBe("cinematic-lotus");
  await studio.reload();
  await expect(studio.getByTestId("scene-category").locator('[data-value="cinematic"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(studio.getByTestId("stage-intensity")).toHaveValue("0.4");
  await expect(studio.getByTestId("stage-preset-5")).toContainText("Moon garden");
  await studio.close();
  await display.close();
});
