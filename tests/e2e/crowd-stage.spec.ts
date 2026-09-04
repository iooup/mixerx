import { expect, test } from "@playwright/test";
import { openCrowdSession } from "../helpers/crowd-session";

test("mixed crowd controls fit narrow displays and retain full character selection", async ({ page }) => {
  await page.goto("/stage?demo=1");
  await expect(page.getByTestId("stage")).toHaveAttribute("data-connected", "true");
  await page.getByTestId("stage-follow").click();
  await expect(page.getByTestId("stage-follow")).not.toBeChecked();
  await page.getByTestId("scene-build-rise").click();
  await expect(page.getByTestId("stage")).toHaveAttribute("data-scene", "build-rise", { timeout: 10_000 });
  await page.getByTestId("stage-overlays").locator("summary").first().click();
  await page.getByTestId("crowd-character-mixed").check();
  const crowd = page.getByTestId("crowd");
  await expect(crowd).toHaveAttribute("data-asset", "ready");
  await expect(crowd).toHaveAttribute("data-members", "codex,fireball,hoots,dario");
  await expect(crowd).toHaveAttribute("data-count", "8");
  await page.getByTestId("crowd-formation").locator("summary").click();
  await page.getByTestId("crowd-count").focus();
  await page.getByTestId("crowd-count").press("End");
  await expect(crowd).toHaveAttribute("data-count", "10");
  await expect(page.getByTestId("crowd-count")).toHaveAttribute("max", "10");
  await page.getByTestId("crowd-size").focus();
  await page.getByTestId("crowd-size").press("Home");
  await expect(crowd).toHaveAttribute("data-size", "0.65");
  await page.getByTestId("crowd-spacing").focus();
  await page.getByTestId("crowd-spacing").press("End");
  await expect(crowd).toHaveAttribute("data-spacing", "1.5");
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
    await expect
      .poll(() =>
        crowd.evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
          return data?.some((value, index) => index % 4 === 3 && value > 128);
        }),
      )
      .toBe(true);
    const overflow = await page
      .getByTestId("crowd-picker")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  await page.getByTestId("stage-appearance").locator("summary").click();
  await page.getByTestId("stage-reduced").click();
  await expect(page.getByTestId("stage-reduced")).toBeChecked();
  await expect(crowd).toHaveAttribute("data-frame", "0:0");
  await expect(crowd).toHaveAttribute("data-move", "rest");
  await page.getByTestId("crowd-character-classic").check();
  await expect(page.getByTestId("crowd").locator(".dancer")).toHaveCount(10);
});

test("real audio drives pets at changing tempos, between decks, and across audience settings", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const { studio, display } = await openCrowdSession(page, context);
  const crowd = display.getByTestId("crowd");
  const poses = new Set<string | null>();
  for (let i = 0; i < 16; i++) {
    poses.add(await crowd.getAttribute("data-frame"));
    await page.waitForTimeout(150);
  }
  expect(poses.size).toBeGreaterThan(2);
  const original = await page.getByTestId("deck-A-bpm").textContent();
  await page.getByTestId("deck-A-tempo").focus();
  await page.getByTestId("deck-A-tempo").press("End");
  await expect(page.getByTestId("deck-A-bpm")).not.toHaveText(original as string);
  await expect(crowd).not.toHaveAttribute("data-move", "rest");
  await page.getByTestId("deck-B-play").click();
  await page.getByTestId("crossfader").focus();
  await page.getByTestId("crossfader").press("End");
  await expect(page.getByTestId("deck-B")).toHaveAttribute("data-on-air", "true");
  await page.getByTestId("deck-A-cue").click();
  await studio.getByTestId("crowd-formation").locator("summary").click();
  await studio.getByTestId("crowd-count").focus();
  await studio.getByTestId("crowd-count").press("Home");
  await expect(crowd).toHaveAttribute("data-count", "4");
  await page.getByTestId("deck-B-play").click();
  await expect(crowd).toHaveAttribute("data-move", "rest", { timeout: 10_000 });
  await studio.getByTestId("stage-blackout").click();
  await expect(crowd).toHaveCount(0);
  await studio.getByTestId("stage-blackout").click();
  await expect(crowd).toHaveAttribute("data-character", "mixed");
  await page.reload();
  await studio.reload();
  await expect(studio.getByTestId("crowd-character-mixed")).toBeChecked();
  await expect(studio.getByTestId("crowd")).toHaveAttribute("data-count", "4");
});
