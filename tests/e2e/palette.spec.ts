import { expect, type Page, test } from "@playwright/test";

async function openConsole(page: Page, autonomy = "copilot") {
  await page.goto("/");
  await page.evaluate((level) => {
    localStorage.setItem("mixerx.v2.session", JSON.stringify({ mode: "mix", autonomy: level, queue: [] }));
    localStorage.removeItem("mixerx.v2.palette.recent");
  }, autonomy);
  await page.reload();
  await expect(page.getByTestId("onair")).toBeVisible();
}

const openPalette = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
};

test.describe("command palette, energy arc and recap", () => {
  test.setTimeout(180_000);

  /** The shortest track of the corpus: the fastest real decode, whatever else is running. */
  async function shortestTitle(page: Page): Promise<string> {
    const response = await page.request.get("/local-audio/library.json");
    const manifest = (await response.json()) as { tracks: { title: string; durationSec?: number }[] };
    const sorted = [...manifest.tracks].sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9));
    const first = sorted[0];
    if (!first) throw new Error("corpus too small");
    return first.title;
  }

  test("⌘K reaches the tools, the console and the library, and Escape gives the focus back", async ({
    page,
  }) => {
    await openConsole(page);
    await openPalette(page);
    await expect(page.getByTestId("palette-input")).toBeFocused();

    // A tool that needs one argument asks for it, then runs through the registry: policy, the
    // activity log and Undo all apply exactly as they would for an agent.
    await page.getByTestId("palette-input").fill("apply scene");
    await expect(page.getByTestId("palette-item-0")).toContainText("Apply scene");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-input")).toHaveAttribute("placeholder", /scene/i);
    await page.getByTestId("palette-input").fill("kick");
    await expect(page.getByTestId("palette-item-0")).toContainText("Kick Field");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    const session = await page.evaluate(() =>
      (
        window as unknown as {
          mixerx: { invoke(n: string, i: unknown): Promise<{ data: { visuals: { sceneId: string } } }> };
        }
      ).mixerx.invoke("get-session", {}),
    );
    expect(session.data.visuals.sceneId).toBe("drop-burst");
    await expect(page.getByTestId("activity-log")).toContainText("apply-scene");

    // A console action: the palette toggles the library drawer, both ways.
    const drawer = page.getByTestId("library-drawer");
    const toggleLibrary = async () => {
      await openPalette(page);
      await page.getByTestId("palette-input").fill("library");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette")).toHaveCount(0);
    };
    await toggleLibrary();
    await expect(drawer).toHaveClass(/drawer--closed/);
    await toggleLibrary();
    await expect(drawer).not.toHaveClass(/drawer--closed/);

    // A track: Enter loads it to the free deck, through the same `load-deck` tool an agent calls.
    // The palette builds its list when it opens, so wait until the library has one to offer.
    const title = await shortestTitle(page);
    await expect(
      page.getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }),
    ).toBeVisible({ timeout: 60_000 });
    await openPalette(page);
    await page.getByTestId("palette-input").fill(title);
    await expect(page.getByTestId("palette-item-0")).toContainText(title);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("activity-log")).toContainText("load-deck", { timeout: 10_000 });
    await expect(page.getByTestId("deck-A-time")).not.toContainText("--:--", { timeout: 120_000 });

    // Escape closes and hands the focus back to where it was.
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    // Arrow keys move the selection.
    await openPalette(page);
    await expect(page.getByTestId("palette-item-0")).toHaveAttribute("data-active", "true");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("palette-item-1")).toHaveAttribute("data-active", "true");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("palette-item-0")).toHaveAttribute("data-active", "true");
    // Nothing matches is said plainly, not with an empty box.
    await page.getByTestId("palette-input").fill("zzzzzzz");
    await expect(page.getByTestId("palette-empty")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("a MIDI controller is taught one control and then drives it, with soft takeover", async ({ page }) => {
    await openConsole(page);
    await page.evaluate(() => localStorage.removeItem("mixerx.v2.midi"));
    await page.reload();
    await expect(page.getByTestId("onair")).toBeVisible();

    // The panel is opt-in and lazy: it says what the browser can do before anything is requested.
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("open-midi").click();
    await expect(page.getByTestId("midi-setup")).toBeVisible();
    await expect(page.getByTestId("midi-setup")).toHaveAttribute("data-status", "off");
    await page.getByTestId("midi-close").click();

    // The development harness's virtual controller takes the same path a real port does.
    type Virtual = {
      connect(port?: string): Promise<void>;
      learn(target: string): void;
      send(data: number[], port?: string): void;
      state(): { maps: Record<string, Record<string, unknown>>; ports: string[] };
    };
    await page.waitForFunction(() => "mixerxMidi" in window, null, { timeout: 10_000 });
    await page.evaluate(async () => {
      await (window as unknown as { mixerxMidi: Virtual }).mixerxMidi.connect();
    });

    // Teach it the crossfader: the first message that carries a value binds.
    await page.evaluate(() => {
      const virtual = (window as unknown as { mixerxMidi: Virtual }).mixerxMidi;
      virtual.learn("mixer.crossfader");
      virtual.send([0xb0, 31, 64]);
    });
    const maps = await page.evaluate(
      () => (window as unknown as { mixerxMidi: Virtual }).mixerxMidi.state().maps,
    );
    expect(maps["Virtual controller"]?.["mixer.crossfader"]).toEqual({
      kind: "cc",
      channel: 0,
      number: 31,
    });

    // Soft takeover: the crossfader is at 0, so a knob at the far end is ignored until it comes
    // back down and meets it — that is what stops a controller throwing the mix across the room.
    const crossfader = page.getByTestId("crossfader");
    await expect(crossfader).toHaveValue("0");
    await page.evaluate(() => {
      (window as unknown as { mixerxMidi: Virtual }).mixerxMidi.send([0xb0, 31, 127]);
    });
    await expect(crossfader).toHaveValue("0");
    await page.evaluate(() => {
      const virtual = (window as unknown as { mixerxMidi: Virtual }).mixerxMidi;
      virtual.send([0xb0, 31, 1]); // meets the software value: it takes control here
      virtual.send([0xb0, 31, 127]); // and now it follows
    });
    await expect(crossfader).toHaveValue("100");
  });

  test("the night's arc fills as the set runs, and the recap reads it back", async ({ page }) => {
    await openConsole(page);
    const arc = page.getByTestId("night-arc");
    await expect(arc).toBeVisible();

    const title = await shortestTitle(page);
    const row = page.getByRole("row", {
      name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Load A" }).click();
    await expect(page.getByTestId("deck-A-time")).not.toContainText("--:--", { timeout: 120_000 });
    await page.getByTestId("deck-A-play").click();
    await expect(page.getByTestId("deck-A")).toHaveAttribute("data-on-air", "true");

    // Ten seconds of a real set is five samples at the two-second interval.
    await expect
      .poll(async () => Number(await arc.getAttribute("data-samples")), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(5);

    // End set: the recap names what was played and offers the two local exports.
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("open-recap").click();
    const recap = page.getByTestId("recap");
    await expect(recap).toBeVisible();
    await expect(page.getByTestId("recap-list")).toContainText(title, { timeout: 10_000 });
    await expect(page.getByTestId("recap-stats")).toContainText("1");
    await expect(page.getByTestId("recap-png")).toBeVisible();
    await expect(page.getByTestId("recap-json")).toBeVisible();
    await page.getByTestId("recap-close").click();
    await expect(recap).toHaveCount(0);
  });
});
