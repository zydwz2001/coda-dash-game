"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: {
      width: 1440,
      height: 1000,
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node ../backend/e2e-server.js",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: "npx http-server . -p 4173 -c-1 --silent",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});

