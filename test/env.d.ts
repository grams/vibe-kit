import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KIT_AUTH_SECRET: string;
      KIT_DEV_LOGIN: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
