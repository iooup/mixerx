import { type BrowserContext, expect, type Page } from "@playwright/test";

export async function openCrowdSession(page: Page, context: BrowserContext) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "mixerx.v2.session",
      // The test owns transport; Co-DJ would also schedule deck transitions.
      JSON.stringify({ mode: "mix", autonomy: "observe", queue: [] }),
    );
  });
  await page.reload();
  const manifest = (await (await page.request.get("/local-audio/library.json")).json()) as {
    tracks: { title: string; durationSec: number }[];
  };
  const tracks = [...manifest.tracks].sort((a, b) => a.durationSec - b.durationSec).slice(0, 2);
  for (const [i, deck] of ["A", "B"].entries()) {
    const track = tracks[i];
    if (!track) throw new Error("Two local audio tracks are required");
    const row = page.getByRole("row", {
      name: new RegExp(track.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: `Load ${deck}`, exact: true }).click();
    await expect(page.getByTestId(`deck-${deck}-time`)).not.toContainText("--:--", { timeout: 60_000 });
    await expect(page.getByTestId(`deck-${deck}-bpm`)).not.toHaveText("—", { timeout: 60_000 });
  }
  await page.getByTestId("stage-badge").click();
  const [studio] = await Promise.all([
    context.waitForEvent("page"),
    page.getByTestId("stage-open-studio").click(),
  ]);
  await page.getByTestId("stage-badge").click();
  await expect(studio.getByTestId("stage")).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
  await studio.getByTestId("stage-follow").click();
  await expect(studio.getByTestId("stage-follow")).not.toBeChecked();
  await studio.getByTestId("scene-build-rise").click();
  await expect(studio.getByTestId("stage")).toHaveAttribute("data-scene", "build-rise", { timeout: 10_000 });
  await studio.getByTestId("stage-overlays").locator("summary").first().click();
  await studio.getByTestId("crowd-character-mixed").check();
  await expect(studio.getByTestId("crowd")).toHaveAttribute("data-asset", "ready");
  const display = await context.newPage();
  await display.goto(`${studio.url()}&mode=display`);
  await expect(display.getByTestId("crowd")).toHaveAttribute("data-character", "mixed", { timeout: 10_000 });
  await page.getByTestId("deck-A-play").click();
  await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");
  return { studio, display, tracks };
}
