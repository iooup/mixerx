import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? "line" : "list",
  projects: [
    // The console specs run in the headless shell; the Stage needs a browser that can present a
    // WebGPU canvas, which today means the full Chromium build in its new headless mode.
    { name: "console", testIgnore: /stage\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "stage",
      testMatch: /stage\.spec\.ts/,
      // One Stage window at a time: four Chromium instances presenting WebGPU through the same GPU
      // stall each other's frames, which the frame-time assertions would report as a regression.
      fullyParallel: false,
      workers: 1,
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4187",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        // WebGPU for the Stage specs: the headless shell exposes a SwiftShader adapter with these.
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
      ],
    },
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4187 --strictPort",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
