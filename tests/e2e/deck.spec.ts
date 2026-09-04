import { expect, type Page, test } from "@playwright/test";

interface ManifestTrack {
  id: string;
  title: string;
  durationSec?: number;
  bpm?: number;
}

async function shortestTrack(page: Page): Promise<ManifestTrack> {
  const response = await page.request.get("/local-audio/library.json");
  expect(response.ok(), "development manifest must be served in dev").toBeTruthy();
  const manifest = (await response.json()) as { tracks: ManifestTrack[] };
  const sorted = [...manifest.tracks].sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9));
  const first = sorted[0];
  if (!first) throw new Error("manifest has no tracks");
  return first;
}

test.describe("decks and mixer (development corpus)", () => {
  test.setTimeout(180_000);

  test("loads a track, shows its duration and waveform, plays on air, and analyses BPM", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "mixerx.v2.session",
        JSON.stringify({ mode: "mix", autonomy: "prepare", queue: [] }),
      );
    });
    await page.reload();
    const track = await shortestTrack(page);
    const row = page.getByRole("row", {
      name: new RegExp(track.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Load A" }).click();

    const deck = page.getByTestId("deck-A");
    await expect(page.getByTestId("deck-A-time")).not.toContainText("--:--", { timeout: 60_000 });
    await expect(page.getByTestId("routing-badge")).toHaveAttribute("data-engine", "running");
    await expect(deck).toHaveAttribute("data-playing", "false");
    await expect(page.getByTestId("onair-led-A")).not.toHaveClass(/led--on/);

    await page.getByTestId("deck-A-play").click();
    await expect(deck).toHaveAttribute("data-playing", "true");
    await expect(deck).toHaveAttribute("data-on-air", "true");
    await expect(page.getByTestId("onair-led-A")).toHaveClass(/led--on/);
    await expect(page.getByTestId("onair-status")).toContainText("A");
    const before = await page.getByTestId("deck-A-time").textContent();
    await page.waitForTimeout(1500);
    expect(await page.getByTestId("deck-A-time").textContent()).not.toBe(before);

    // Loaded decks and live badges must not widen the page.
    const overflow = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);

    // The waveform has real pixels (not a placeholder).
    const painted = await page
      .getByTestId("wave-zoom-A")
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => {
        const ctx = canvas.getContext("2d");
        if (!ctx || !canvas.width) return 0;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) lit += 1;
        return lit / (canvas.width * canvas.height);
      });
    expect(painted).toBeGreaterThan(0.02);

    // Analysis completes in the worker and the BPM appears on the deck.
    await expect(page.getByTestId("deck-A-bpm")).not.toHaveText("—", { timeout: 120_000 });
    const bpm = Number.parseFloat((await page.getByTestId("deck-A-bpm").textContent()) ?? "0");
    expect(bpm).toBeGreaterThan(60);
    expect(bpm).toBeLessThan(220);

    // Crossfader fully to B (keyboard End) takes A off air; the transport keeps running.
    const crossfader = page.getByTestId("crossfader");
    await crossfader.focus();
    await crossfader.press("End");
    await expect(crossfader).toHaveValue("100");
    await expect(deck).toHaveAttribute("data-on-air", "false");
    await expect(page.getByTestId("onair-led-A")).not.toHaveClass(/led--on/);
    await expect(deck).toHaveAttribute("data-playing", "true");
    await crossfader.press("Home");
    await expect(crossfader).toHaveValue("0");
    await expect(deck).toHaveAttribute("data-on-air", "true");

    // CUE while playing stops the deck and returns to the cue point.
    await page.getByTestId("deck-A-cue").click();
    await expect(deck).toHaveAttribute("data-playing", "false");
    await expect(deck).toHaveAttribute("data-on-air", "false");
    await expect(page.getByTestId("deck-A-time")).toHaveText("00:00");
  });

  test("audio setup applies the single-output routing and remembers it", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "mixerx.v2.session",
        JSON.stringify({ mode: "mix", autonomy: "prepare", queue: [] }),
      );
    });
    await page.reload();
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("open-audio-setup").click();
    const dialog = page.getByTestId("audio-setup");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /Single output/ }).check();
    await dialog.getByTestId("audio-apply").click();
    await expect(page.getByTestId("routing-badge")).toHaveAttribute("data-engine", "running");
    await expect(page.getByTestId("routing-badge")).not.toContainText("not set up");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    const stored = await page.evaluate(() => localStorage.getItem("mixerx.v2.routing"));
    expect(stored).toContain('"single"');
  });

  test("PERFORM pads set and recall hot cues, loop 4 beats, and ? opens the keyboard map", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "mixerx.v2.session",
        JSON.stringify({ mode: "mix", autonomy: "prepare", queue: [] }),
      );
    });
    await page.reload();
    const track = await shortestTrack(page);
    const row = page.getByRole("row", {
      name: new RegExp(track.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Load A" }).click();
    await expect(page.getByTestId("deck-A-time")).not.toContainText("--:--", { timeout: 60_000 });

    await page.getByTestId("mode-switch").locator("[data-value='perform']").click();
    await expect(page.getByTestId("pads-A")).toBeVisible();
    await expect(page.getByTestId("pads-B")).toBeVisible();

    await page.getByTestId("deck-A-play").click();
    await page.waitForTimeout(1200);
    await page.getByTestId("hotcue-A-1").click();
    await expect(page.getByTestId("hotcue-A-1")).toHaveClass(/pad--set/);
    await page.waitForTimeout(2500);
    await page.getByTestId("hotcue-A-1").click();
    await expect(page.getByTestId("deck-A-time")).toHaveText(/^00:0[0-2]/);

    await expect(page.getByTestId("deck-A-bpm")).not.toHaveText("—", { timeout: 120_000 });
    await page.getByTestId("loop-A-4").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-loop", "4");
    await page.getByTestId("loop-A-exit").click();
    await expect(page.getByTestId("deck-A")).not.toHaveAttribute("data-loop", /.+/);

    await page.getByTestId("deck-A-section").waitFor();
    await page.locator("body").press("Shift+?");
    await expect(page.getByTestId("keyboard-map")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("keyboard-map")).toBeHidden();
    await page.getByTestId("deck-A-cue").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-playing", "false");
  });
});
