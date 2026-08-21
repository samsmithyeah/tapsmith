import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.PORT ?? 5175)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Both apps are desktop multi-column layouts; a narrow viewport collapses
    // panes and would have specs asserting against a layout no user sees.
    viewport: { width: 1600, height: 1000 },
  },

  // Chromium only for both: these are our own apps on one engine, not a
  // cross-browser support matrix.
  projects: [
    {
      name: "ui-mode",
      testDir: "./ui-mode/specs",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "trace-viewer",
      testDir: "./trace-viewer/specs",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "node serve.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
})
