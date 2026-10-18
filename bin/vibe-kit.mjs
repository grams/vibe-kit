#!/usr/bin/env node
// CLI vibe-kit, à lancer depuis la racine d'une app :
//   npx vibe-kit version          version installée + dernière version publiée (tags Git du dépôt)
//   npx vibe-kit sync             copie les migrations SQL du kit qui manquent dans ./migrations
//   npx vibe-kit upgrade [vX.Y.Z] installe la dernière version (ou celle indiquée), puis sync
//
// Le kit s'installe depuis GitHub en HTTPS (aucune clé SSH nécessaire) :
//   "vibe-kit": "git+https://github.com/compte/vibe-kit.git#vX.Y.Z"
// (sans #vX.Y.Z : dernier commit de la branche par défaut).
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
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

function depSpec(pkg) {
  const spec = pkg.dependencies?.[PKG];
  if (!spec) fail(`${PKG} n'est pas dans les dépendances de l'app.`);
  const m = spec.match(/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#(.+))?$/);
  if (!m) fail(`Dépendance ${PKG} inattendue : "${spec}" (attendu : git+https://github.com/compte/${PKG}.git#vX.Y.Z)`);
  return { spec, repo: m[1], ref: m[2] ?? null };
}

/** Tags vX.Y.Z du dépôt, triés (null si git ou le réseau sont indisponibles). */
function remoteTags(repo) {
  try {
    const out = execFileSync("git", ["ls-remote", "--tags", "--refs", `https://github.com/${repo}.git`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((l) => l.split("refs/tags/")[1])
      .filter((t) => t && /^v\d+\.\d+\.\d+$/.test(t))
      .sort(cmp);
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
  const { pkg } = appPackage();
  const { repo, ref } = depSpec(pkg);
  const installed = installedVersion();
  const tags = remoteTags(repo);
  const latest = tags?.at(-1);
  console.log(`Installée : ${installed ?? "non installée (lancer npm install)"} — source : ${repo}${ref ? `#${ref}` : " (branche par défaut)"}`);
  if (tags === null) console.log("Dernière version : inconnue (git ou réseau indisponible).");
  else if (!latest) console.log("Aucune version publiée (tag) pour l'instant.");
  else if (installed && cmp(latest, installed) <= 0) console.log(`Dernière version : ${latest} — à jour.`);
  else {
    const major = installed && parse(latest)[0] > parse(installed)[0];
    console.log(`Dernière version : ${latest} — mise à jour disponible${major ? " (MAJEURE : l'app devra être adaptée)" : ""}.`);
    console.log("Mettre à jour : npm run kit:upgrade");
  }
} else if (cmd === "sync") {
  sync();
} else if (cmd === "upgrade") {
  const { path, pkg } = appPackage();
  const { repo, ref } = depSpec(pkg);
  const from = installedVersion();
  const tags = remoteTags(repo) ?? [];
  const target = arg ? `v${arg.replace(/^v/, "")}` : tags.at(-1);
  let spec;
  if (target) {
    if (from && !arg && cmp(target, from) <= 0 && ref === target) {
      console.log(`Déjà à jour (${from}).`);
      process.exit(0);
    }
    spec = `git+https://github.com/${repo}.git#${target}`;
  } else {
    // Pas de tag : on suit la branche par défaut et on récupère son dernier commit.
    spec = `git+https://github.com/${repo}.git`;
  }
  pkg.dependencies[PKG] = spec;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`Mise à jour ${from ?? "?"} → ${target ?? "dernier commit de la branche par défaut"}…`);
  execFileSync("npm", ["install", spec], { stdio: "inherit", cwd: APP_DIR });
  sync();
  console.log(
    "\n===== Étapes suivantes =====\n" +
      "1. Vérifier dans node_modules/vibe-kit/README.md si l'API a changé et adapter l'app.\n" +
      "2. npm run typecheck && npm run build\n" +
      "3. Pousser une branche, tester l'aperçu, puis fusionner.",
  );
} else {
  console.log("Usage : npx vibe-kit <version | sync | upgrade [vX.Y.Z]>");
  process.exit(cmd ? 1 : 0);
}
