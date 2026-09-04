import { defineConfig, devices } from "@playwright/test";

/** Corpus gate: analyses every development track and reports BPM/key against the manifest hints. */
export default defineConfig({
  testDir: "./tests/corpus",
  timeout: 20 * 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4187",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4187 --strictPort",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
