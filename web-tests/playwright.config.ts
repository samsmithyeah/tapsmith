import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.PORT ?? 5175)
const BASE_URL = `http://127.0.0.1:${PORT}`
const VIEWPORT = { width: 1600, height: 1000 }

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },

  // Chromium only for both: these are our own apps on one engine, not a
  // cross-browser support matrix.
  //
  // The viewport is set per project rather than globally: both apps are desktop
  // multi-column layouts that collapse panes when narrow, and `devices[...]`
  // carries its own 1280x720 viewport which a project's `use` applies over the
  // global one — so setting it globally silently had no effect.
  projects: [
    {
      name: "ui-mode",
      testDir: "./ui-mode/specs",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORT },
    },
    {
      name: "trace-viewer",
      testDir: "./trace-viewer/specs",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORT },
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
