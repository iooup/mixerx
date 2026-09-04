import { expect, test } from "@playwright/test";

test.describe("library drawer", () => {
  test.setTimeout(120_000);

  test("search, filters, queue with energy arc, and CUE preview", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "mixerx.v2.session",
        JSON.stringify({ mode: "mix", autonomy: "prepare", queue: [] }),
      );
    });
    await page.reload();
    const rows = page.locator("tr.track-row");
    await expect(rows).toHaveCount(16, { timeout: 30_000 });

    await page.getByTestId("library-search").fill("roar");
    await expect(rows).toHaveCount(1);
    await page.getByTestId("library-search").fill("");
    await expect(rows).toHaveCount(16);

    // Queue two tracks with the Q key and the button; the energy arc appears once both are analysed.
    const first = rows.nth(0);
    await first.click();
    await first.press("q");
    await expect(page.getByTestId("queue-list").locator("li")).toHaveCount(1);
    await rows.nth(1).getByRole("button", { name: /queue/i }).click();
    await expect(page.getByTestId("queue-list").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("energy-arc")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("queue-list").locator("li")).toHaveCount(2, { timeout: 30_000 });
    await page.locator('[data-testid^="queue-remove-"]').first().click();
    await expect(page.getByTestId("queue-list").locator("li")).toHaveCount(1);

    // CUE preview toggles per row and stops when toggled again.
    const preview = page.locator('[data-testid^="preview-"]').first();
    await preview.click();
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("routing-badge")).toHaveAttribute("data-engine", "running");
    await preview.click();
    await expect(preview).toHaveAttribute("aria-pressed", "false");

    // Key/tempo filters need a reference deck; the energy band filter works alone.
    await expect(page.getByTestId("filter-key")).toBeDisabled();
    await page.getByTestId("filter-energy").selectOption("high");
    await expect(page.getByTestId("library-count")).not.toHaveText("16/16", { timeout: 120_000 });
    await page.getByTestId("filter-energy").selectOption("all");
    await expect(page.getByTestId("library-count")).toHaveText("16/16");
  });
});
