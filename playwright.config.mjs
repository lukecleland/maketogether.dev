import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  use: {
    browserName: "webkit",
    baseURL: "http://127.0.0.1:5178",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "VITE_SHARED_BROWSER_ENABLED=true npm run dev -- --host 127.0.0.1 --port 5178 --strictPort",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: false,
  },
});
