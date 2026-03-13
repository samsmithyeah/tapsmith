import { defineConfig } from "pilot";

export default defineConfig({
  apk: "~/projects/story-app/android/app/build/outputs/apk/debug/app-debug.apk",
  timeout: 30_000,
  retries: 0,
  screenshot: "only-on-failure",
  device: "emulator-5554",
});
