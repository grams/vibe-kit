import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Les tests tournent dans le runtime Workers (workerd) avec une base D1 locale.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("../migrations");
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            KIT_AUTH_SECRET: "secret-de-test-0123456789abcdef0123456789",
            KIT_DEV_LOGIN: "1",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["**/*.test.ts"],
      exclude: ["node_modules/**"],
      setupFiles: ["./setup.ts"],
    },
  };
});
