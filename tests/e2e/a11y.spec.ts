import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  { path: "/", testId: "console" },
  { path: "/stage", testId: "stage" },
] as const;

test("console and stage have no serious or critical accessibility violations", async ({ page }) => {
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.getByTestId(route.testId)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      serious.map(
        (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      ),
      route.path,
    ).toEqual([]);
  }
});
