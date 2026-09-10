import { defineConfig } from "@playwright/test";

const baseURL = process.env.DRAW_LAYOUT_BASE_URL ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
  },
  ...(process.env.DRAW_LAYOUT_BASE_URL
    ? {}
    : {
        webServer: {
          command: "pnpm dev --hostname 127.0.0.1 --port 3100",
          url: baseURL,
          timeout: 60_000,
          reuseExistingServer: !process.env.CI,
        },
      }),
});
