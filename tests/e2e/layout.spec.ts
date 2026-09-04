import { expect, type Page, test } from "@playwright/test";

interface ManifestTrack {
  title: string;
  durationSec?: number;
}

async function shortest(page: Page, count: number): Promise<ManifestTrack[]> {
  const manifest = (await (await page.request.get("/local-audio/library.json")).json()) as {
    tracks: ManifestTrack[];
  };
  return [...manifest.tracks].sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9)).slice(0, count);
}

const row = (page: Page, title: string) =>
  page.getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

async function openMix(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "mixerx.v2.session",
      JSON.stringify({ mode: "mix", autonomy: "prepare", queue: [] }),
    );
  });
  await page.reload();
  await expect(page.locator("tr.track-row")).toHaveCount(16, { timeout: 30_000 });
}

/** Supported console sizes. */
const SIZES = [
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [834, 1112],
] as const;

test.describe("console layout", () => {
  test.setTimeout(240_000);

  test("mixer and decks stay on one screen at every supported size with loaded decks", async ({ page }) => {
    await openMix(page);
    const [first, second] = await shortest(page, 2);
    if (!first || !second) throw new Error("corpus too small");
    await row(page, first.title).getByRole("button", { name: "Load A" }).click();
    await row(page, second.title).getByRole("button", { name: "Load B" }).click();
    await expect(page.getByTestId("deck-A-time")).not.toContainText("--:--", { timeout: 60_000 });
    await expect(page.getByTestId("deck-B-time")).not.toContainText("--:--", { timeout: 60_000 });
    await page.getByTestId("deck-A-play").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(350);
      const report = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
        const mixer = document.querySelector<HTMLElement>('[data-testid="mixer"] .mx');
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          mixerOverflowY: mixer ? mixer.scrollHeight - mixer.clientHeight : -1,
          mixerOverflowX: mixer ? mixer.scrollWidth - mixer.clientWidth : -1,
          crossfader: rect('[data-testid="crossfader"]'),
          deckA: rect('[data-testid="deck-A"]'),
          deckB: rect('[data-testid="deck-B"]'),
          mixer: rect('[data-testid="mixer"]'),
          knobs: document.querySelectorAll(".knob__input").length,
          faders: document.querySelectorAll(".fader").length,
          viewportHeight: innerHeight,
        };
      });
      const label = `${width}×${height}`;
      expect(report.pageOverflow, `${label} page`).toBeLessThanOrEqual(1);
      expect(report.mixerOverflowY, `${label} mixer height`).toBeLessThanOrEqual(1);
      expect(report.mixerOverflowX, `${label} mixer width`).toBeLessThanOrEqual(1);
      expect(report.knobs, `${label} knobs`).toBe(12);
      expect(report.faders, `${label} faders`).toBe(2);
      expect(report.crossfader?.height ?? 0, `${label} crossfader visible`).toBeGreaterThan(20);
      expect(report.crossfader?.bottom ?? 1e9, `${label} crossfader on screen`).toBeLessThanOrEqual(
        report.viewportHeight,
      );
      expect(report.crossfader?.bottom ?? 1e9, `${label} crossfader inside the mixer`).toBeLessThanOrEqual(
        (report.mixer?.bottom ?? 0) + 1,
      );
      if (width < 1024) {
        expect(report.mixer?.top ?? 0, `${label} mixer band under the decks`).toBeGreaterThanOrEqual(
          (report.deckA?.bottom ?? 0) - 1,
        );
        expect(report.deckB?.left ?? 0, `${label} decks side by side`).toBeGreaterThanOrEqual(
          (report.deckA?.right ?? 0) - 1,
        );
      } else {
        expect(report.mixer?.left ?? 0, `${label} mixer between the decks`).toBeGreaterThanOrEqual(
          (report.deckA?.right ?? 0) - 1,
        );
      }
    }

    // MIX with loaded decks: no visible text below 11 px either.
    await page.setViewportSize({ width: 1024, height: 768 });
    const small = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (typeof element.checkVisibility === "function" && !element.checkVisibility()) continue;
        if (element.classList.contains("sr-only")) continue;
        const hasText = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
        );
        if (!hasText) continue;
        const size = Number.parseFloat(style.fontSize);
        if (size < 11) offenders.push(`${element.tagName.toLowerCase()}.${element.className} ${size}px`);
      }
      return offenders;
    });
    expect(small).toEqual([]);
  });

  test("a knob answers to drag, wheel, double-click kill, and the keyboard through one range input", async ({
    page,
  }) => {
    await openMix(page);
    const low = page.getByTestId("eqLow-A");
    const knob = page.locator(".knob", { has: low });
    await expect(low).toHaveValue("0");

    // Drag up: 40 px of a 160 px sweep is 67.5°, half of the +12 dB side.
    const box = await knob.boundingBox();
    if (!box) throw new Error("knob has no box");
    const x = box.x + box.width / 2;
    const y = box.y + box.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 40, { steps: 8 });
    await page.mouse.up();
    await expect(low).toHaveValue("6");
    await expect(knob.locator(".knob__value")).toHaveText("+6.0 dB");

    // Double-click kills the band and shows it; a second double-click restores 0 dB.
    await knob.dblclick({ position: { x: box.width / 2, y: box.width / 2 } });
    await expect(low).toHaveValue("-26");
    await expect(knob).toHaveAttribute("data-kill", "true");
    await expect(knob.locator(".knob__value")).toHaveText("KILL");
    await knob.dblclick({ position: { x: box.width / 2, y: box.width / 2 } });
    await expect(low).toHaveValue("0");

    // Wheel: one notch is 1 dB on an EQ band.
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -100);
    await expect(low).toHaveValue("1");

    // Keyboard on the same input (the Guide and the lesson test rely on this).
    await low.focus();
    await low.press("Home");
    await expect(low).toHaveValue("-26");
    await low.press("End");
    await expect(low).toHaveValue("12");

    // The crossfader curve chip cycles through the three laws.
    const chip = page.getByTestId("crossfader-curve");
    await expect(chip).toHaveAttribute("data-curve", "equal-power");
    await chip.click();
    await expect(chip).toHaveAttribute("data-curve", "linear");
    await chip.click();
    await expect(chip).toHaveAttribute("data-curve", "cut");
    await chip.click();
    await expect(chip).toHaveAttribute("data-curve", "equal-power");
  });
});
