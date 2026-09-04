import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { Intent } from "../../src/visuals/director";
import type { StageSettings } from "../../src/visuals/protocol";

interface StageHook {
  patch(patch: Partial<StageSettings>): void;
  intent(): Intent;
  stats(): Promise<{ meanLuma: number }>;
}

const patch = (page: Page, value: Partial<StageSettings>) =>
  page.evaluate((value) => (window as unknown as { mixerxStage: StageHook }).mixerxStage.patch(value), value);
const simple = (id: string) => id.startsWith("line-");

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test("simple scenes render and move; category changes cut while same-category scenes blend", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/WebGPU|shader|pipeline/i.test(message.text()) && message.type() === "error")
      errors.push(message.text());
  });
  await page.goto("/stage?demo=1&speed=2");
  const stage = page.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-webgpu", "yes", { timeout: 30_000 });
  await patch(page, { follow: false, palette: "decks", transition: "dissolve", sceneId: "intro-lines" });
  await expect(stage).toHaveAttribute("data-scene", "intro-lines");
  const category = page.getByTestId("scene-category");
  await category.locator('[data-value="simple"]').click();
  await expect(category.locator('[data-value="simple"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("scene-intro-lines")).toHaveCount(0);
  await expect(page.locator(".scene-card")).toHaveCount(4);
  await expect(stage).toHaveAttribute("data-scene", "line-waves");

  for (const id of ["line-waves", "line-orbits", "line-ribbons", "line-lattice"]) {
    await page.getByTestId(`scene-${id}`).click();
    await expect(stage).toHaveAttribute("data-scene", id, { timeout: 10_000 });
    const luma = await page.evaluate(
      async () => (await (window as unknown as { mixerxStage: StageHook }).mixerxStage.stats()).meanLuma,
    );
    expect(luma, id).toBeGreaterThan(0.005);
    const first = await page.getByTestId("stage-canvas").screenshot();
    await page.waitForTimeout(350);
    expect(await page.getByTestId("stage-canvas").screenshot(), id).not.toEqual(first);
    await page.screenshot({ path: info.outputPath(`${id}-1440.png`) });
  }

  // A drop deliberately forces a cut, so inspect blending away from that boundary. Faster
  // controls can finish the scene sweep just as the demo build lands on its drop.
  await page.waitForFunction(() => {
    const intent = (window as unknown as { mixerxStage: StageHook }).mixerxStage.intent();
    return intent.section !== "build" && intent.barsToNext > 2 && intent.beat.phase > 0.25;
  });
  // Record every rendered intent while a same-category blend is interrupted by a category change.
  const observation = page.evaluate(async () => {
    const hook = (window as unknown as { mixerxStage: StageHook }).mixerxStage;
    const transitions: { from: string; to: string }[] = [];
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const intent = hook.intent();
      if (intent.transition) transitions.push({ from: intent.transition.from, to: intent.transition.to });
      await new Promise(requestAnimationFrame);
    }
    return transitions;
  });
  await page.getByTestId("scene-line-waves").click();
  await page.waitForFunction(
    () => !!(window as unknown as { mixerxStage: StageHook }).mixerxStage.intent()?.transition,
  );
  await category.locator('[data-value="classic"]').click();
  await expect(stage).toHaveAttribute("data-scene", "intro-lines");
  const transitions = await observation;
  expect(transitions.some(({ from, to }) => simple(from) && simple(to))).toBe(true);
  expect(transitions.every(({ from, to }) => simple(from) === simple(to))).toBe(true);

  await category.locator('[data-value="simple"]').click();
  await expect(stage).toHaveAttribute("data-scene", "line-waves");
  await page.keyboard.press("2");
  await expect(stage).toHaveAttribute("data-scene", "line-orbits", { timeout: 10_000 });
  await page.setViewportSize({ width: 1024, height: 768 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("simple-1024.png") });
  const a11y = await new AxeBuilder({ page }).include('[data-testid="scene-library"]').analyze();
  expect(a11y.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.keyboard.press("Shift+B");
  await expect(stage).toHaveAttribute("data-scene", "blackout");
  const dark = await page.evaluate(
    async () => (await (window as unknown as { mixerxStage: StageHook }).mixerxStage.stats()).meanLuma,
  );
  expect(dark).toBeLessThan(0.004);
  expect(errors).toEqual([]);
});

test("simple category and presets persist through the console and audience display", async ({
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
  const stage = studio.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
  await expect(stage).toHaveAttribute("data-webgpu", "yes", { timeout: 30_000 });
  await patch(studio, { follow: false, palette: "decks", transition: "cut", sceneId: "intro-lines" });
  await expect(stage).toHaveAttribute("data-scene", "intro-lines");
  await patch(studio, { transition: "dissolve" });
  await studio.getByTestId("scene-category").locator('[data-value="simple"]').click();
  await expect(stage).toHaveAttribute("data-scene", "line-waves");
  await studio.getByTestId("scene-line-orbits").click();
  await expect(stage).toHaveAttribute("data-scene", "line-orbits", { timeout: 10_000 });
  const [display] = await Promise.all([
    context.waitForEvent("page"),
    studio.getByTestId("stage-open-display").click(),
  ]);
  await expect(display.getByTestId("stage")).toHaveAttribute("data-scene", "line-orbits", {
    timeout: 15_000,
  });
  studio.once("dialog", (dialog) => void dialog.accept("Quiet rings"));
  await studio.getByTestId("stage-preset-save").click();
  await expect(studio.getByTestId("stage-preset-5")).toContainText("Quiet rings");
  await studio.getByTestId("scene-category").locator('[data-value="classic"]').click();
  await expect(stage).toHaveAttribute("data-scene", "intro-lines");
  await studio.getByTestId("stage-preset-5").click();
  await expect(stage).toHaveAttribute("data-scene", "line-orbits");
  await expect(display.getByTestId("stage")).toHaveAttribute("data-scene", "line-orbits");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mixerx.v2.stage") ?? "{}").sceneId))
    .toBe("line-orbits");
  await studio.reload();
  await expect(studio.getByTestId("scene-category").locator('[data-value="simple"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(studio.getByTestId("stage-preset-5")).toContainText("Quiet rings");
  await studio.close();
  await display.close();
});
