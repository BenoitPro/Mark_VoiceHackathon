import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry"
  },
  webServer: {
    command: "pnpm build && pnpm preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: "android-360",
      use: { viewport: { width: 360, height: 800 } }
    },
    {
      name: "iphone-390",
      use: { viewport: { width: 390, height: 844 } }
    },
    {
      name: "tablet-768",
      use: { viewport: { width: 768, height: 1024 } }
    },
    {
      name: "desktop-1280",
      use: { viewport: { width: 1280, height: 800 } }
    }
  ]
});
