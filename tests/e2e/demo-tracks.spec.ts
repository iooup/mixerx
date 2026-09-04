import { expect, test } from "@playwright/test";

/**
 * The first thing a visitor with no music of their own can do. This covers the whole path — render,
 * decode, beat grid, key — because the demo pair is what a first-time judge or player actually
 * meets, and a silent failure here leaves an empty console.
 */
test.describe("demo tracks", () => {
  test("a first visit can load the demo pair and the analysis agrees with how it was written", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await page.goto("/");

    const drawer = page.getByTestId("library-drawer");
    await expect(drawer).toContainText("No tracks yet");

    await page.getByTestId("load-demo").click();

    const list = page.getByTestId("track-list");
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(list.getByText("Neon Drift")).toBeVisible();
    await expect(list.getByText("Glass Tide")).toBeVisible();

    // Both tracks reach "ready"; the analysis runs for real, so give it room.
    await expect(list.getByText("Ready", { exact: true })).toHaveCount(2, { timeout: 60_000 });

    const row = (title: string) => list.locator("tr", { hasText: title });

    // Written at 124 and 128 BPM. The grid is detected, not declared, so allow a small margin.
    for (const [title, bpm] of [
      ["Neon Drift", 124],
      ["Glass Tide", 128],
    ] as const) {
      const text = await row(title).innerText();
      const found = Number(text.match(/1\d\d\.\d/)?.[0] ?? "0");
      expect(Math.abs(found - bpm), `${title} detected ${found} BPM`).toBeLessThan(2);
    }

    // A minor and its relative major: the pair exists to show a harmonic blend.
    await expect(row("Neon Drift")).toContainText("8A");
    await expect(row("Glass Tide")).toContainText("8B");

    // Nothing was fetched to make this happen.
    await expect(page.getByTestId("csp-badge")).toHaveAttribute("data-state", "enforced");
  });

  test("the demo button is offered only while the library is empty", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await page.goto("/");
    await expect(page.getByTestId("load-demo")).toBeVisible();
    await page.getByTestId("load-demo").click();
    await expect(page.getByTestId("track-list")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("load-demo")).toHaveCount(0);
  });
});
