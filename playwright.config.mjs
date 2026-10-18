import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', workers: 1, retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', {open:'never'}]],
  use: {baseURL:'http://127.0.0.1:39871',viewport:{width:1280,height:900},trace:'retain-on-failure', screenshot:'only-on-failure', ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})},
  webServer: {command:'node scripts/demo-server.mjs',url:'http://127.0.0.1:39871',reuseExistingServer:false,timeout:30000}
});
