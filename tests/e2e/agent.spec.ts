import { chromium, expect, type Page, test } from "@playwright/test";

interface ManifestTrack {
  title: string;
  durationSec?: number;
}

interface ToolResult {
  status: "ok" | "proposed" | "accepted" | "error";
  proposalId?: string;
  confirmationRequired?: boolean;
  error?: string;
  data?: unknown;
}

async function shortest(page: Page, count: number): Promise<ManifestTrack[]> {
  const manifest = (await (await page.request.get("/local-audio/library.json")).json()) as {
    tracks: ManifestTrack[];
  };
  return [...manifest.tracks].sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9)).slice(0, count);
}

const row = (page: Page, title: string) =>
  page.getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

const invoke = (page: Page, name: string, input: unknown): Promise<ToolResult> =>
  page.evaluate(
    ([tool, args]) =>
      (window as unknown as { mixerx: { invoke(n: string, i: unknown): Promise<ToolResult> } }).mixerx.invoke(
        tool as string,
        args,
      ),
    [name, input],
  );

async function setup(page: Page, autonomy: string) {
  await page.goto("/");
  await page.evaluate((level) => {
    localStorage.setItem("mixerx.v2.session", JSON.stringify({ mode: "mix", autonomy: level, queue: [] }));
  }, autonomy);
  await page.reload();
  await expect(page.locator("tr.track-row")).toHaveCount(16, { timeout: 30_000 });
}

test.describe("agent layer", () => {
  test.setTimeout(240_000);

  test("every tool answers at every autonomy level through the harness", async ({ page }) => {
    await setup(page, "observe");
    const [a, b, c] = await shortest(page, 3);
    if (!a || !b || !c) throw new Error("corpus too small");
    await row(page, a.title).getByRole("button", { name: "Load A" }).click();
    await row(page, b.title).getByRole("button", { name: "Load B" }).click();
    await expect(page.getByTestId("deck-A-bpm")).not.toHaveText("—", { timeout: 120_000 });
    await expect(page.getByTestId("deck-B-bpm")).not.toHaveText("—", { timeout: 120_000 });
    const ids = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("tr.track-row"));
      return rows.map((entry) => entry.dataset.testid?.replace("track-", "") ?? "");
    });
    const idFor = async (title: string) =>
      (await row(page, title).getAttribute("data-testid"))?.replace("track-", "") ?? "";
    const idA = await idFor(a.title);
    const idB = await idFor(b.title);
    const idC = await idFor(c.title);
    expect(ids).toContain(idA);
    await page.getByTestId("deck-A-play").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");

    // Shift+D opens the harness; it lists the tools with their access level.
    await page.locator("body").press("Shift+D");
    await expect(page.getByTestId("harness")).toBeVisible();
    await expect(page.getByTestId("harness-tool").locator("option")).toHaveCount(13);
    await page.keyboard.press("Escape");

    const expectations: Record<string, Record<string, ToolResult["status"]>> = {
      observe: { read: "ok", prepare: "proposed", act: "proposed" },
      prepare: { read: "ok", prepare: "ok", act: "proposed" },
      copilot: { read: "ok", prepare: "ok", act: "ok" },
    };
    const calls: { name: string; access: "read" | "prepare" | "act"; input: unknown; refusal?: RegExp }[] = [
      { name: "get-session", access: "read", input: {} },
      { name: "search-library", access: "read", input: { query: "", limit: 5 } },
      { name: "get-track", access: "read", input: { trackId: idA } },
      { name: "propose-transition", access: "read", input: {} },
      { name: "plan-set", access: "read", input: { trackIds: [idA, idB, idC], target: "peak" } },
      { name: "propose-scene", access: "read", input: {} },
      { name: "set-queue", access: "prepare", input: { trackIds: [idC] } },
      { name: "preview-cue", access: "prepare", input: { trackId: idC }, refusal: /CUE is not routed/ },
      { name: "load-deck", access: "prepare", input: { deck: "A", trackId: idC }, refusal: /on air/ },
      { name: "apply-scene", access: "act", input: { sceneId: "drop-burst" } },
      { name: "apply-preset", access: "act", input: { name: "Deep space" } },
      { name: "arm-transition", access: "act", input: {} },
      { name: "enter-deck", access: "act", input: { deck: "B" } },
    ];

    for (const autonomy of ["observe", "prepare", "copilot"] as const) {
      await page.getByTestId("autonomy-switch").locator(`[data-value='${autonomy}']`).click();
      for (const call of calls) {
        const result = await invoke(page, call.name, call.input);
        const expected = expectations[autonomy]?.[call.access];
        if (call.refusal) {
          expect(result.status, `${autonomy}/${call.name}`).toBe("error");
          expect(result.error, `${autonomy}/${call.name}`).toMatch(call.refusal);
        } else {
          expect(result.status, `${autonomy}/${call.name}: ${result.error ?? ""}`).toBe(expected);
        }
        if (result.status === "proposed") {
          await expect(page.getByTestId(`proposal-${result.proposalId}`)).toBeVisible();
          await page.getByTestId(`proposal-dismiss-${result.proposalId}`).click();
        }
        if (result.status === "ok" && (call.name === "arm-transition" || call.name === "enter-deck")) {
          await expect(page.getByTestId("onair-next")).toContainText(/enters|armed/);
          await page.locator('[data-testid^="undo-"]').first().click();
          await expect(page.getByTestId("onair-next")).toContainText("No scheduled event");
        }
      }
    }

    // The activity log is real: it lists the tool, caller, and outcome for every call.
    await expect(page.getByTestId("activity-log").locator("li").first()).toContainText(
      /enter-deck|arm-transition|apply-scene/,
    );
    const unknown = await invoke(page, "nope", {});
    expect(unknown.error).toContain("Unknown tool");
    const invalid = await invoke(page, "load-deck", { deck: "C", trackId: idC });
    expect(invalid.error).toContain("one of A, B");
  });

  test("proposal flow: propose-transition → load-deck (confirm) → enter-deck (confirm)", async ({ page }) => {
    await setup(page, "observe");
    const [a, b] = await shortest(page, 2);
    if (!a || !b) throw new Error("corpus too small");
    await row(page, a.title).getByRole("button", { name: "Load A" }).click();
    await expect(page.getByTestId("deck-A-bpm")).not.toHaveText("—", { timeout: 120_000 });
    const idB = (await row(page, b.title).getAttribute("data-testid"))?.replace("track-", "") ?? "";
    await page.getByTestId("deck-A-play").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");

    const load = await invoke(page, "load-deck", { deck: "B", trackId: idB });
    expect(load.status).toBe("proposed");
    const card = page.getByTestId(`proposal-${load.proposalId}`);
    await expect(card).toContainText(`Load ${b.title} → B`);
    await card.getByTestId(`proposal-accept-${load.proposalId}`).click();
    await expect(page.getByTestId("deck-B-time")).not.toContainText("--:--", { timeout: 60_000 });
    await expect(card).toBeHidden();
    await expect(page.getByTestId("activity-log")).toContainText("confirmed by you");
    await expect(page.getByTestId("deck-B-bpm")).not.toHaveText("—", { timeout: 120_000 });

    const plan = await invoke(page, "propose-transition", {});
    expect(plan.status).toBe("ok");
    expect((plan.data as { entryBarOnFrom: number }).entryBarOnFrom).toBeGreaterThan(0);

    const enter = await invoke(page, "enter-deck", { deck: "B" });
    expect(enter.status).toBe("proposed");
    await page.getByTestId(`proposal-accept-${enter.proposalId}`).click();
    await expect(page.getByTestId("onair-next")).toContainText(/B enters in|armed/);
    await expect(page.getByTestId("deck-B")).toHaveAttribute("data-playing", "true", { timeout: 20_000 });
  });

  test("WebMCP: an external agent calls propose-transition → load-deck (user confirm) → enter-deck", async ({
    baseURL,
  }) => {
    const browser = await chromium.launch({
      args: [
        "--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseURL}/`);
      await page.evaluate(() => {
        localStorage.setItem(
          "mixerx.v2.session",
          JSON.stringify({ mode: "mix", autonomy: "observe", queue: [] }),
        );
      });
      await page.reload();
      const available = await page.evaluate(() => "modelContext" in document || "modelContext" in navigator);
      test.skip(!available, "This Chromium build does not expose document.modelContext.");
      await expect(page.locator("tr.track-row")).toHaveCount(16, { timeout: 30_000 });
      await expect(page.getByTestId("agent-badge")).toHaveAttribute("data-webmcp", "registered");
      await expect(page.getByTestId("webmcp-status")).toContainText(/tools registered/);

      // The external agent's view. Every tool the mode allows registers at every autonomy level:
      // policy is enforced when the call runs, so an act tool answers `proposed` rather than
      // being hidden. Hiding it would leave ChatGPT no path at all, since it has no declarative
      // forms to fall back on.
      const listTools = () =>
        page.evaluate(async () => {
          const testing = (
            navigator as unknown as { modelContextTesting: { listTools(): Promise<{ name: string }[]> } }
          ).modelContextTesting;
          return (await testing.listTools()).map((tool) => tool.name).sort();
        });
      const names = await listTools();
      expect(names).toContain("get-session");
      expect(names).toContain("search-library");
      expect(names.filter((name) => name === "enter-deck")).toHaveLength(1);
      expect(names.filter((name) => name === "arm-transition")).toHaveLength(1);

      const execute = (name: string, input: unknown) =>
        page.evaluate(
          async ([tool, args]) => {
            const testing = (
              navigator as unknown as {
                modelContextTesting: { executeTool(name: string, input: string): Promise<unknown> };
              }
            ).modelContextTesting;
            const raw = await testing.executeTool(tool as string, JSON.stringify(args));
            const unwrap = (value: unknown): ToolResult => {
              if (typeof value === "string") return unwrap(JSON.parse(value));
              const text = (value as { content?: { text?: string }[] })?.content?.[0]?.text;
              return text ? unwrap(text) : (value as ToolResult);
            };
            return unwrap(raw);
          },
          [name, input],
        );

      const [a, b] = await shortest(page, 2);
      if (!a || !b) throw new Error("corpus too small");
      await row(page, a.title).getByRole("button", { name: "Load A" }).click();
      await expect(page.getByTestId("deck-A-bpm")).not.toHaveText("—", { timeout: 120_000 });
      await page.getByTestId("deck-A-play").click();
      await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");
      const search = await execute("search-library", { query: b.title, limit: 1 });
      expect(search.status).toBe("ok");
      const idB = (search.data as { tracks: { id: string }[] }).tracks[0]?.id ?? "";
      expect(idB).not.toBe("");

      const load = await execute("load-deck", { deck: "B", trackId: idB });
      expect(load.status).toBe("proposed");
      await page.getByTestId(`proposal-accept-${load.proposalId}`).click();
      await expect(page.getByTestId("deck-B-bpm")).not.toHaveText("—", { timeout: 120_000 });

      const plan = await execute("propose-transition", {});
      expect(plan.status).toBe("ok");

      // The plan reaches the person as a card in their own words before anything is scheduled.
      const armed = await execute("arm-transition", {});
      expect(armed.status).toBe("proposed");
      expect(armed.confirmationRequired).toBe(true);
      const card = page.getByTestId(`proposal-${armed.proposalId}`);
      await expect(card).toContainText(/enters at bar/);
      expect(await card.locator(".proposal__reasons li").count()).toBeGreaterThan(0);
      await page.getByTestId(`proposal-dismiss-${armed.proposalId}`).click();

      // Agent asks, person confirms, music enters. `enter-deck` takes the on-air deck's next bar 1,
      // so the entry is audible inside the test's patience; arm-transition can be 32 bars out.
      const asked = await execute("enter-deck", { deck: "B" });
      expect(asked.status).toBe("proposed");
      await expect(page.getByTestId(`proposal-${asked.proposalId}`)).toContainText(/Enter B/);
      await page.getByTestId(`proposal-accept-${asked.proposalId}`).click();
      await expect(page.getByTestId("onair-next")).toContainText(/B enters in|armed/);
      await expect(page.getByTestId("activity-log")).toContainText("confirmed by you");
      await expect(page.getByTestId("deck-B")).toHaveAttribute("data-playing", "true", { timeout: 20_000 });

      // Co-DJ changes the policy, not the tool list: the same call now runs without a card, and
      // re-registering across the switch must not leave a duplicate behind.
      await page.getByTestId("deck-B-cue").click();
      await page.getByTestId("autonomy-switch").locator("[data-value='copilot']").click();
      await expect.poll(async () => (await listTools()).join(","), { timeout: 10_000 }).toBe(names.join(","));
      const direct = await execute("enter-deck", { deck: "B" });
      expect(direct.status).toBe("ok");
      await expect(page.getByTestId("deck-B")).toHaveAttribute("data-playing", "true", { timeout: 20_000 });
    } finally {
      await browser.close();
    }
  });
});
