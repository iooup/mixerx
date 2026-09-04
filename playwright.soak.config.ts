import { defineConfig } from "@playwright/test";

/** An explicit, real-time stability gate; kept out of the ordinary fast E2E run. */
export default defineConfig({
  testDir: "./tests/soak",
  timeout: 35 * 60_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4187",
    channel: "chromium",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    },
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4187 --strictPort",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
