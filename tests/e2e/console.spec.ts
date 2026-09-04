import { expect, test } from "@playwright/test";

test.describe("console shell", () => {
  test("renders in English by default with an honest ON-AIR strip and an enforced network policy", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("onair")).toBeVisible();
    await expect(page.getByTestId("onair")).toContainText("Silent");
    await expect(page.getByTestId("routing-badge")).toContainText("Audio engine off");
    await expect(page.getByTestId("routing-badge")).toHaveAttribute("data-engine", "idle");
    await expect(page.getByTestId("csp-badge")).toHaveAttribute("data-state", "enforced", { timeout: 5000 });
    await expect(page.getByTestId("agent-badge")).toHaveAttribute("data-webmcp", /available|unavailable/);
    for (const id of ["deck-A", "deck-B", "mixer", "copilot-rail", "library-drawer"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test("is English and left-to-right, with no language control to change that", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("onair")).toContainText("Silent");
    await page.getByTestId("settings-toggle").click();
    await expect(page.getByTestId("lang-select")).toHaveCount(0);
  });

  test("mode, autonomy, rail, and drawer state persist across reloads", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-switch").locator("[data-value='learn']").click();
    await expect(page.getByTestId("console")).toHaveAttribute("data-mode", "learn");
    await page.getByTestId("autonomy-switch").locator("[data-value='copilot']").click();
    await page.getByTestId("drawer-toggle").click();
    await expect(page.getByTestId("library-drawer")).toHaveAttribute("data-open", "false");
    await page.getByTestId("rail-toggle").click();
    await expect(page.getByTestId("copilot-rail")).toHaveAttribute("data-collapsed", "true");

    await page.reload();
    await expect(page.getByTestId("console")).toHaveAttribute("data-mode", "learn");
    await expect(page.getByTestId("library-drawer")).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("copilot-rail")).toHaveAttribute("data-collapsed", "true");
    await page.getByTestId("rail-toggle").click();
    await expect(page.getByTestId("autonomy-switch").locator("[data-value='copilot']")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("keyboard: L toggles the library drawer and arrow keys move the mode radio", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-drawer")).toHaveAttribute("data-open", "true");
    await page.locator("body").press("l");
    await expect(page.getByTestId("library-drawer")).toHaveAttribute("data-open", "false");
    await page.locator("body").press("l");
    await expect(page.getByTestId("library-drawer")).toHaveAttribute("data-open", "true");

    const mix = page.getByTestId("mode-switch").locator("[data-value='mix']");
    await mix.focus();
    await mix.press("ArrowRight");
    await expect(page.getByTestId("console")).toHaveAttribute("data-mode", "perform");
    await expect(page.getByTestId("mode-switch").locator("[data-value='perform']")).toBeFocused();
  });

  test("has no horizontal overflow at common desktop and tablet sizes", async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [1024, 768],
      [834, 1112],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByTestId("onair")).toBeVisible();
      const overflow = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(overflow.scroll, `${width}×${height}`).toBeLessThanOrEqual(overflow.client + 1);
    }
  });

  test("narrow screens get an honest notice instead of a broken console", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(
      page.getByText("The Console is not available at this screen width.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId("console")).toBeHidden();
  });

  test("the stage route without a session shows the connect panel", async ({ page }) => {
    await page.goto("/stage");
    await expect(page.getByTestId("stage")).toBeVisible();
    await expect(page.getByTestId("stage")).toHaveAttribute("data-mode", "connect");
    await expect(page).toHaveTitle(/Mixerx/);
  });

  test("first run opens LEARN with the guide card, and no visible text is smaller than 11 px", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("console")).toHaveAttribute("data-mode", "learn");
    await expect(page.getByTestId("guide-card")).toHaveAttribute("data-step", "1");
    expect(await page.locator("[data-guide-current]").count()).toBe(1);
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
});
