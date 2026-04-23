import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Bun's default test matcher picks up *.test.ts and *.spec.ts, so we
  // use a different suffix to keep these out of `bun test` discovery.
  testMatch: ["**/*.pw.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: undefined,
    trace: "retain-on-failure",
  },
});
