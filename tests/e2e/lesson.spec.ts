import { expect, type Locator, type Page, test } from "@playwright/test";

interface ManifestTrack {
  title: string;
  durationSec?: number;
}

async function shortestTracks(page: Page, count: number): Promise<ManifestTrack[]> {
  const manifest = (await (await page.request.get("/local-audio/library.json")).json()) as {
    tracks: ManifestTrack[];
  };
  return [...manifest.tracks].sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9)).slice(0, count);
}

const rowFor = (page: Page, title: string): Locator =>
  page.getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

test.describe("Lesson 1 — phrase entry blend", () => {
  test.setTimeout(300_000);

  test("runs end to end on real audio with exactly one highlighted control per step", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "mixerx.v2.session",
        JSON.stringify({ mode: "learn", autonomy: "prepare", queue: [] }),
      );
    });
    await page.reload();
    const card = page.getByTestId("guide-card");
    const expectStep = async (step: number) => {
      await expect(card).toHaveAttribute("data-step", String(step), { timeout: 90_000 });
      expect(await page.locator("[data-guide-current]").count(), `step ${step} highlights one control`).toBe(
        1,
      );
    };

    await expectStep(1);
    await expect(page.getByTestId("crossfader")).toBeDisabled();
    await expect(page.getByTestId("learn-rail")).toBeVisible();

    const [first, second] = await shortestTracks(page, 2);
    if (!first || !second) throw new Error("corpus too small");
    await expect(rowFor(page, first.title)).toBeVisible({ timeout: 30_000 });
    await rowFor(page, first.title).getByRole("button", { name: "Load A" }).click();
    await rowFor(page, second.title).getByRole("button", { name: "Load B" }).click();
    await expect(page.getByTestId("deck-B-play")).toBeDisabled();

    // Steps 2–3: analysis, then the calibration card with its CUE loop.
    await expectStep(3);
    await card.getByTestId("guide-loop").click();
    await expect(card.getByTestId("guide-loop")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("deck-B")).toHaveAttribute("data-playing", "true");
    await expect(page.getByTestId("deck-B")).toHaveAttribute("data-on-air", "false");
    await card.getByTestId("guide-beat-plus").click();
    await card.getByTestId("guide-beat-minus").click();
    await card.getByTestId("guide-confirm").click();
    await expectStep(4);
    await expect(page.getByTestId("deck-B")).toHaveAttribute("data-playing", "false");

    await page.getByTestId("deck-A-play").click();
    await expectStep(5);
    await expect(page.getByTestId("deck-B-play")).toBeDisabled();
    await card.getByTestId("guide-enter").click();
    await expect(page.getByTestId("onair-next")).toContainText(/B enters in|armed/);
    await expectStep(6);
    await expect(page.getByTestId("deck-B")).toHaveAttribute("data-playing", "true");
    await expect(page.getByTestId("phase-meter")).toBeHidden();

    // Step 6 completes by itself when 8 consecutive beats align within 15 ms.
    await expectStep(7);
    await expect(page.getByTestId("phase-meter")).toBeVisible({ timeout: 30_000 });
    const crossfader = page.getByTestId("crossfader");
    await expect(crossfader).toBeEnabled();
    await crossfader.focus();
    for (let i = 0; i < 5; i += 1) await crossfader.press("PageUp");
    await expect(crossfader).toHaveValue("50");
    await expectStep(8);

    const lowA = page.getByTestId("eqLow-A");
    await expect(lowA).toBeEnabled();
    await lowA.focus();
    await lowA.press("Home");
    await expectStep(9);

    await crossfader.focus();
    await crossfader.press("End");
    await expectStep(10);
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-playing", "false");
    await expect(card).toContainText(/Alignment \d+ ms · Blend \d+ bars · Bass swap on beat 1 [✓✗]/);

    // Finishing is celebrated (the sparks are a zero-size anchor with animated dots), and the
    // badge is kept locally — nothing is ever locked behind one.
    await expect(page.getByTestId("guide-sparks")).toBeAttached();
    const spark = await page.evaluate(() => {
      const dot = document.querySelector(".guide-sparks__dot");
      return dot ? getComputedStyle(dot).animationName : null;
    });
    expect(spark).toBe("guide-spark");
    const badges = await page.evaluate(() => {
      const raw = localStorage.getItem("mixerx.v2.badges");
      return raw ? (JSON.parse(raw) as { earned: string[]; streak: number }) : null;
    });
    expect(badges?.earned).toContain("first-blend");
    expect(badges?.streak).toBeGreaterThanOrEqual(1);

    await card.getByTestId("guide-replay").click();
    await expectStep(4);
    await expect(crossfader).toHaveValue("0");

    // Leaving LEARN ends the lesson and unlocks everything.
    await page.getByTestId("mode-switch").locator("[data-value='mix']").click();
    await expect(card).toBeHidden();
    await expect(crossfader).toBeEnabled();
    expect(await page.locator("[data-guide-current]").count()).toBe(0);
  });
});
