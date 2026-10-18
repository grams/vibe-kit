// Tests de la CLI (Node, sans dépendance) : node --test test/cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/vibe-kit.mjs", import.meta.url));

/** App factice : package.json, wrangler.jsonc, migrations de l'app et kit « installé ». */
function makeApp({ spec = "git+https://github.com/grams/vibe-kit.git", kitMigrations = ["001-auth.sql"], appMigrations = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vibe-kit-cli-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "vibe-kit": spec } }));
  writeFileSync(join(dir, "wrangler.jsonc"), `{ "d1_databases": [{ "binding": "DB", "migrations_dir": "db" }] }`);
  mkdirSync(join(dir, "db"));
  for (const f of appMigrations) writeFileSync(join(dir, "db", f), "-- app");
  const kit = join(dir, "node_modules", "vibe-kit");
  mkdirSync(join(kit, "migrations"), { recursive: true });
  writeFileSync(join(kit, "package.json"), JSON.stringify({ name: "vibe-kit", version: "0.0.1" }));
  for (const f of kitMigrations) writeFileSync(join(kit, "migrations", f), `-- kit ${f}`);
  return dir;
}

const run = (dir, ...args) => execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });
const migrations = (dir) => readdirSync(join(dir, "db")).sort();

test("sync copie les migrations du kit à la suite de celles de l'app", () => {
  const dir = makeApp({ kitMigrations: ["001-auth.sql", "002-ajout.sql"], appMigrations: ["0001_kit-001-auth.sql", "0002_app.sql"] });
  const out = run(dir, "sync");
  assert.match(out, /0003_kit-002-ajout\.sql/);
  assert.deepEqual(migrations(dir), ["0001_kit-001-auth.sql", "0002_app.sql", "0003_kit-002-ajout.sql"]);
  assert.equal(readFileSync(join(dir, "db", "0003_kit-002-ajout.sql"), "utf8"), "-- kit 002-ajout.sql");
});

test("sync est idempotent", () => {
  const dir = makeApp({ kitMigrations: ["001-auth.sql"] });
  run(dir, "sync");
  const out = run(dir, "sync");
  assert.match(out, /rien à ajouter/);
  assert.deepEqual(migrations(dir), ["0001_kit-001-auth.sql"]);
});

test("une dépendance hors GitHub est signalée clairement", () => {
  const dir = makeApp({ spec: "file:../ailleurs" });
  const res = spawnSync("node", [CLI, "version"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Dépendance vibe-kit inattendue/);
});

test("une commande inconnue affiche l'aide et échoue", () => {
  const dir = makeApp();
  const res = spawnSync("node", [CLI, "nimporte"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Usage/);
});
