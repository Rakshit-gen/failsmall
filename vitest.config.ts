import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests turn workflow sleeps off. Check windows are computed from the
        // plan, not the clock, so the simulated telemetry is the same either way.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TIME_SCALE: "60" } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
