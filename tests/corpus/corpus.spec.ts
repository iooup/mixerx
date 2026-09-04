import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

interface ManifestTrack {
  id: string;
  title: string;
  src: string;
  bpm?: number;
  key?: string;
  durationSec?: number;
}

interface Row {
  title: string;
  bpm: string;
  key: string;
  energy: string;
  time: string;
  state: string;
}

/**
 * Not a pass/fail on musical truth: the manifest BPM/key values are the previous tool's
 * estimates, not independently confirmed ground truth. The gate
 * fails only when analysis does not complete for every track; the comparison is a report.
 */
test("analyses the whole development corpus and reports BPM/key against manifest hints", async ({
  page,
}, testInfo) => {
  const manifest = (await (await page.request.get("/local-audio/library.json")).json()) as {
    tracks: ManifestTrack[];
  };
  await page.goto("/");
  const rows = page.locator("tr.track-row");
  await expect(rows).toHaveCount(manifest.tracks.length, { timeout: 60_000 });
  const started = Date.now();
  await expect
    .poll(async () => await page.locator("tr.track-row .track-row__state--ready").count(), {
      timeout: 18 * 60_000,
      intervals: [2000],
    })
    .toBe(manifest.tracks.length);
  const elapsedSec = (Date.now() - started) / 1000;

  const results: Row[] = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const headers = Array.from(element.closest("table")?.querySelectorAll("thead th") ?? []).map(
        (cell) => cell.textContent?.trim() ?? "",
      );
      const cells = Array.from(element.querySelectorAll("td")).map((cell) => cell.textContent?.trim() ?? "");
      const cell = (name: string) => {
        const index = headers.indexOf(name);
        if (index < 0) throw new Error(`Corpus table column missing: ${name}`);
        return cells[index] ?? "";
      };
      return {
        title: element.querySelector("strong")?.textContent?.trim() ?? "",
        bpm: cell("BPM"),
        key: cell("Key"),
        energy: cell("Energy"),
        time: cell("Time"),
        state: element.querySelector(".track-row__state")?.textContent?.trim() ?? "",
      };
    }),
  );

  const lines = [
    "# Corpus analysis report",
    "",
    `Generated ${new Date().toISOString()} · ${manifest.tracks.length} tracks · ${elapsedSec.toFixed(0)} s wall clock (sequential, one worker).`,
    "",
    "Manifest BPM/key are the previous tool's estimates, not confirmed ground truth. `ratio` is analysed ÷ manifest BPM (1.00 = agreement, 0.50/2.00 = octave).",
    "",
    "| Track | Analysed BPM | Manifest BPM | Ratio | Analysed key | Manifest key | Energy |",
    "|---|---:|---:|---:|---|---|---:|",
  ];
  let agreements = 0;
  for (const track of manifest.tracks) {
    const row = results.find((entry) => entry.title === track.title);
    const analysed = Number.parseFloat(row?.bpm ?? "");
    const ratio = track.bpm && Number.isFinite(analysed) ? analysed / track.bpm : Number.NaN;
    if (Number.isFinite(ratio) && Math.abs(ratio - 1) < 0.02) agreements += 1;
    lines.push(
      `| ${track.title} | ${row?.bpm ?? "—"} | ${track.bpm ?? "—"} | ${Number.isFinite(ratio) ? ratio.toFixed(2) : "—"} | ${row?.key ?? "—"} | ${track.key ?? "—"} | ${row?.energy ?? "—"} |`,
    );
  }
  lines.push("", `BPM within ±2 % of the manifest hint: ${agreements}/${manifest.tracks.length}.`, "");
  const report = lines.join("\n");
  mkdirSync(testInfo.outputDir, { recursive: true });
  const reportPath = testInfo.outputPath("corpus-report.md");
  writeFileSync(reportPath, report);
  await testInfo.attach("corpus-report", { path: reportPath, contentType: "text/markdown" });
  expect(results.every((row) => row.state.startsWith("Ready"))).toBeTruthy();
});
