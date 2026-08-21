import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.PORT ?? 5175)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // UI mode is a desktop three-column layout; a narrow viewport collapses
    // panes and would make pane-level specs assert against a layout no user
    // of UI mode sees.
    viewport: { width: 1600, height: 1000 },
  },

  projects: [
    {
      name: "chromium",
      // Chromium only: this is our own app on one engine, not a
      // cross-browser support matrix.
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "node serve-ui.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
})
