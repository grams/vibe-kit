# vibe-kit

[![npm](https://img.shields.io/npm/v/vibe-kit)](https://www.npmjs.com/package/vibe-kit)

Socle pour apps Cloudflare Workers : authentification (Google + lien magique par email) sur D1, client navigateur et migrations SQL.

Le plus simple est de partir du dépôt **vibe-template**, qui l'installe et contient un `AGENTS.md` pour les agents IA.

## Installation

```sh
npm install vibe-kit
npm install -D wrangler @cloudflare/workers-types
```

Les types utilisent les globals Workers (`D1Database`…) : ajouter `"types": ["@cloudflare/workers-types"]` au `tsconfig.json`.

## Utilisation

```ts
import { createApp, requireUser, currentUser, type KitEnv } from "vibe-kit";

type Env = KitEnv; // + vos propres bindings

const app = createApp<Env>({ appName: "Mon app" });

app.get("/api/notes", requireUser, async (c) => {
  const user = currentUser(c);
  const { results } = await c.env.DB.prepare("SELECT * FROM notes WHERE user_id = ?").bind(user.id).all();
  return c.json(results);
});

export default app;
```

`wrangler.jsonc` : flag `nodejs_compat`, binding D1 `DB`, et `assets.run_worker_first: ["/api/*", "/vibe-kit.js"]` si l'app sert des fichiers statiques.

Tables d'auth : `npx vibe-kit sync` copie les migrations du kit dans `migrations/`, puis `wrangler d1 migrations apply DB`.

Côté navigateur : `<script src="/vibe-kit.js"></script>` puis `kit.me()`, `kit.signInWithGoogle()`, `kit.sendMagicLink(email)`, `kit.signOut()`, `kit.api(path, { body })`.

## Variables d'environnement

| Nom | Obligatoire | Rôle |
|---|---|---|
| `DB` (binding D1) | oui | Base de données |
| `BETTER_AUTH_SECRET` | oui | Signature des sessions |
| `BETTER_AUTH_URL` | non | URL publique (déduite de la requête sinon) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | non | Active la connexion Google |
| `RESEND_API_KEY` / `EMAIL_FROM` | non | Envoi réel des liens magiques (sinon affichés dans les logs) |

## CLI

| Commande | Effet |
|---|---|
| `npx vibe-kit version` | Version installée et dernière version npm |
| `npx vibe-kit sync` | Copie les migrations du kit manquantes dans l'app |
| `npx vibe-kit upgrade [X.Y.Z]` | `npm install vibe-kit@latest` puis `sync` |

## Publier une version (mainteneur)

Première fois uniquement :
1. `npm login` puis `npm publish` depuis ce dossier (crée le paquet sur npm).
2. Sur npmjs.com → paquet → *Settings* → *Trusted publishing* : ajouter GitHub Actions, dépôt `grams/vibe-kit`, workflow `publish.yml`, environnement `npm`.
3. Sur GitHub : *Settings* → *Environments* → créer `npm`.

Ensuite, pour chaque version :
1. Code + tests. Changement du schéma d'auth → **nouveau** fichier `migrations/NNN-description.sql` (ne jamais modifier une migration publiée, changements additifs uniquement).
2. `npm version patch | minor | major` → met à jour `package.json` et `src/version.ts`, commit et tag.
3. `git push --follow-tags` → la CI publie sur npm avec provenance.
