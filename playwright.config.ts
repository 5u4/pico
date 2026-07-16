import { defineConfig, devices } from "@playwright/test";

const PORT = 4142;
const BASE_URL = `http://localhost:${PORT}`;
const STREAM_PORT = 4143;
const STREAM_URL = `http://localhost:${STREAM_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "bun run e2e/server.ts",
      env: { PICO_E2E_PORT: String(PORT) },
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "bun run e2e/stream-server.ts",
      env: { PICO_E2E_STREAM_PORT: String(STREAM_PORT) },
      url: STREAM_URL,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
