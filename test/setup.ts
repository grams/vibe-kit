import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Schéma du kit + une table de profil d'app, appliqués avant les tests.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await env.DB.exec(
  "CREATE TABLE IF NOT EXISTS profile (user_id TEXT PRIMARY KEY REFERENCES kit_user (id) ON DELETE CASCADE, display_name TEXT, theme TEXT);",
);
