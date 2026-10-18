#!/usr/bin/env node
// CLI vibe-kit, à lancer depuis la racine d'une app :
//   npx vibe-kit version         version installée + dernière version publiée sur npm
//   npx vibe-kit sync            copie les migrations SQL de la lib qui manquent dans ./migrations
//   npx vibe-kit upgrade [X.Y.Z] npm install vibe-kit@latest (ou X.Y.Z), puis sync des migrations
import { readFileSync, readdirSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP_DIR = process.cwd();
const PKG = "vibe-kit";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

function appPackage() {
  const path = join(APP_DIR, "package.json");
  if (!existsSync(path)) fail("Lancer cette commande à la racine de l'app (package.json introuvable).");
  return { path, pkg: readJson(path) };
}

function installedVersion() {
  const p = join(APP_DIR, "node_modules", PKG, "package.json");
  return existsSync(p) ? readJson(p).version : null;
}

/** Dernière version publiée sur npm (null si hors ligne). */
function latestVersion() {
  try {
    return execFileSync("npm", ["view", PKG, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: APP_DIR,
    }).trim();
  } catch {
    return null;
  }
}

function migrationsDir() {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const p = join(APP_DIR, name);
    if (existsSync(p)) {
      const m = readFileSync(p, "utf8").match(/"migrations_dir"\s*:\s*"([^"]+)"/);
      if (m) return join(APP_DIR, m[1]);
    }
  }
  return join(APP_DIR, "migrations");
}

function sync(libDir = join(APP_DIR, "node_modules", PKG)) {
  const src = join(libDir, "migrations");
  const dest = migrationsDir();
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  const existing = readdirSync(dest).filter((f) => f.endsWith(".sql"));
  let next = existing.reduce((max, f) => Math.max(max, parseInt(f, 10) || 0), 0) + 1;
  const added = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith(".sql")).sort()) {
    const suffix = `_kit-${file}`;
    if (existing.some((f) => f.endsWith(suffix))) continue;
    const target = `${String(next++).padStart(4, "0")}${suffix}`;
    copyFileSync(join(src, file), join(dest, target));
    added.push(target);
  }
  if (added.length) {
    console.log(`Migrations ajoutées :\n${added.map((f) => `  + ${f}`).join("\n")}`);
    console.log("À appliquer : npm run db:migrate (local) puis npm run db:migrate:remote (prod).");
  } else {
    console.log("Migrations du kit : rien à ajouter.");
  }
  return added;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "version") {
  appPackage();
  const installed = installedVersion();
  const latest = latestVersion();
  console.log(`Installée : ${installed ?? "non installée (lancer npm install)"}`);
  if (!latest) console.log("Dernière publiée : inconnue (pas de réseau ?).");
  else if (installed && cmp(latest, installed) <= 0) console.log(`Dernière publiée : ${latest} — à jour.`);
  else {
    const major = installed && parse(latest)[0] > parse(installed)[0];
    console.log(`Dernière publiée : ${latest} — mise à jour disponible${major ? " (MAJEURE : l'app devra être adaptée)" : ""}.`);
    console.log("Mettre à jour : npm run kit:upgrade");
  }
} else if (cmd === "sync") {
  sync();
} else if (cmd === "upgrade") {
  appPackage();
  const from = installedVersion();
  const target = arg ? arg.replace(/^v/, "") : latestVersion();
  if (!target) fail("Impossible de joindre npm. Préciser la version : npx vibe-kit upgrade 1.2.0");
  if (from && cmp(target, from) <= 0) {
    console.log(`Déjà à jour (${from}).`);
    process.exit(0);
  }
  console.log(`Mise à jour ${from ?? "?"} → ${target}…`);
  execFileSync("npm", ["install", `${PKG}@${target}`], { stdio: "inherit", cwd: APP_DIR });
  sync();
  console.log(
    "\n===== Étapes suivantes =====\n" +
      "1. Vérifier dans node_modules/vibe-kit/README.md si l'API a changé et adapter l'app.\n" +
      "2. npm run typecheck && npm run db:migrate && npm run dev → vérifier connexion + fonctionnalités.\n" +
      "3. npm run db:migrate:remote && npm run deploy",
  );
} else {
  console.log("Usage : npx vibe-kit <version | sync | upgrade [X.Y.Z]>");
  process.exit(cmd ? 1 : 0);
}
