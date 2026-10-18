# vibe-kit

Socle pour créer des apps web **sans être développeur**, en les décrivant à un assistant IA. Les apps sont hébergées gratuitement sur Cloudflare : connexion avec un compte Google (ou GitHub), accès sur invitation, back-office, base de données.

**Pour commencer**, ouvrir une conversation avec Claude (ou un autre assistant) et écrire :

> Voici le README de vibe-kit : https://github.com/grams/vibe-kit — crée-moi une app qui …

L'assistant s'occupe du reste et guide pas à pas. Le reste de ce document est la référence technique.

---

## Créer une app — instructions pour l'assistant IA

La personne qui te parle **n'est pas développeuse** : elle n'a peut-être jamais utilisé GitHub ni Cloudflare. Tu fais le travail, tu la guides **une étape à la fois**, en mots simples, et tu vérifies chaque étape avant de passer à la suivante.

**1. Créer le dépôt de l'app à partir du modèle [`grams/vibe-template`](https://github.com/grams/vibe-template).**

- Si tu peux créer un dépôt GitHub toi-même (connecteur GitHub, `gh`, ou l'API `POST /repos/grams/vibe-template/generate`), fais-le : nom court en minuscules avec tirets tiré de l'idée de l'app (ex. `liste-courses`), privé par défaut.
- Sinon, guide la personne :
  1. Si elle n'a pas de compte GitHub : https://github.com/signup (email, mot de passe, nom d'utilisateur ; confirmer l'email).
  2. Ouvrir https://github.com/new?template_owner=grams&template_name=vibe-template
  3. **Repository name** : le nom que tu proposes ; **Private** ; cliquer **Create repository**.
  4. Te donner accès à ce dépôt (dans Claude : ajouter le dépôt GitHub à la conversation) et te coller son adresse.

**2. Ouvrir le dépôt créé et suivre son `AGENTS.md`.** Il prend le relais : vérification de l'installation (`npm run doctor`), installation guidée sur Cloudflare (`docs/ONBOARDING.md`), puis construction de l'app demandée, testée en local puis en ligne.

Ne commence pas à coder l'app avant que l'installation ne soit terminée : la personne doit pouvoir voir et tester son app en ligne dès les premiers changements.

## Installation

Le kit s'installe directement depuis GitHub, en HTTPS (pas de publication npm, aucune clé SSH nécessaire) ; npm le construit à l'installation (script `prepare`).

```json
"dependencies": { "vibe-kit": "git+https://github.com/grams/vibe-kit.git#vX.Y.Z" }
```

Sans `#vX.Y.Z`, npm prend le dernier commit de la branche par défaut (figé ensuite par le `package-lock.json`).

## Le préfixe `kit` est réservé au socle

Tout ce qui appartient au kit porte ce préfixe ; une app ne l'utilise jamais. C'est ce qui permet de mettre le kit à jour sans conflit.

| Élément | Réservé au kit |
|---|---|
| Tables D1 | `kit_*` (`kit_user`, `kit_session`, `kit_account`, `kit_verification`, `kit_settings`, `kit_invitation`) |
| Migrations copiées dans l'app | `migrations/NNNN_kit-*.sql` |
| Routes | `/api/kit/*` (auth : `/api/kit/auth/*`, back-office : `/api/kit/admin/*`) |
| Variables et secrets | `KIT_*` |
| Cookies | `kit.*` |
| CSS | classes `.kit-*`, variables `--kit-*` |

Les attributs propres à une app vont dans **sa** table de profil (1:1 avec `kit_user`), jamais dans `kit_user`.

## Serveur (`vibe-kit`)

```ts
import { createKit, currentUser, requireAdmin, type KitEnv } from "vibe-kit";

type Profile = { display_name: string | null };

const kit = createKit<Env & KitEnv, Profile>({
  appName: "Mon app",
  admins: ["admin@exemple.fr"],                       // back-office + toujours autorisés
  protect: { default: "private", public: ["/api/public/*"] },
  profile: { table: "profile", defaults: (u) => ({ display_name: u.name }) },
  onUserCreated: async (user, env) => { /* facultatif */ },
});

kit.app.get("/api/notes", async (c) => {
  const user = currentUser(c);
  const { results } = await c.env.DB.prepare("SELECT * FROM note WHERE user_id = ?").bind(user.id).all();
  return c.json(results);
});
kit.app.get("/api/profile", async (c) => c.json(await kit.profile.get(c)));
kit.app.get("/api/admin/stats", requireAdmin, (c) => c.json({ ok: true }));

export default kit.app;
```

| Export | Rôle |
|---|---|
| `createKit<Env, Profile>(options)` | Renvoie `{ app, profile }` : app Hono avec auth, protection et back-office branchés |
| `currentUser(c)` / `getUser(c)` | Utilisateur connecté (lève une erreur / ou `null`) |
| `requireUser`, `requireAdmin` | Middlewares 401 / 403 pour une route |
| `isAdmin(c)` | L'utilisateur connecté est-il admin ? |
| `kit.profile.get(c)` / `kit.profile.update(c, patch)` | Profil de l'app, créé à la première lecture avec `defaults` |

Options de `createKit` : `appName`, `admins`, `protect` (`default`, `public`, `private` — motifs exacts ou `/préfixe/*`, sur les routes `/api`), `profile` (`table`, `defaults`), `onUserCreated`, `sessionDays`.

### Accès

- **Admins** : emails de l'option `admins` + `KIT_ADMIN_EMAILS` (séparés par des virgules).
- **Mode restreint** (par défaut) : peuvent créer un compte les admins, les emails invités et les adresses des domaines autorisés. **Mode ouvert** : tout le monde. Réglable dans le back-office.
- Un utilisateur supprimé perd l'accès en 60 s au plus ; ses données d'app liées à `kit_user` par `ON DELETE CASCADE` sont supprimées.

## Client (`vibe-kit/react`)

```tsx
import { KitProvider, Protected, KitAdmin, useKit, api } from "vibe-kit/react";
import "vibe-kit/react/styles.css";

<KitProvider components={{ LoginPage: MaPageDeConnexion }}>
  <Protected><MesPages /></Protected>
  <Protected admin><KitAdmin sections={[{ id: "stats", label: "Stats", render: () => <Stats /> }]} /></Protected>
</KitProvider>
```

| Export | Rôle |
|---|---|
| `KitProvider` | Charge la session ; `components` remplace les écrans du kit |
| `useKit()` | `user`, `isAdmin`, `appName`, `providers`, `loading`, `signInWithGoogle`, `sendMagicLink`, `signOut`, `refresh` |
| `Protected` | Affiche ses enfants si connecté (`admin` : si admin), sinon la page de connexion |
| `KitAdmin` | Back-office (Accès, Utilisateurs) + `sections` de l'app |
| `api(path, { method, body })` | `fetch` JSON avec session ; lève `KitApiError` (`message`, `status`) |
| `useLoginForm()`, `useKitAdmin()` | Logique sans interface, pour construire ses propres écrans |

**Personnaliser l'interface**, du plus léger au plus complet :
1. **Thème** : redéfinir les variables `--kit-*` après l'import de `styles.css`.
2. **Remplacer un écran** : `components={{ LoginPage, Loading, Forbidden, Admin }}`.
3. **Tout refaire** : `useLoginForm()` et `useKitAdmin()` fournissent l'état et les actions.

## Variables d'environnement

| Nom | Obligatoire | Rôle |
|---|---|---|
| `DB` (binding D1) | oui | Base partagée (tables `kit_*` + tables de l'app) |
| `KIT_GOOGLE_CLIENT_ID` / `KIT_GOOGLE_CLIENT_SECRET` | pour Google | Connexion Google, celle que tout le monde a (l'ID n'est pas secret : variable dans `wrangler.jsonc` ; le secret dans Cloudflare) ; URL de retour : `https://<production>/api/kit/auth/callback/google` |
| `KIT_GITHUB_CLIENT_ID` / `KIT_GITHUB_CLIENT_SECRET` | pour GitHub | Connexion GitHub (facultative) ; URL de retour : `https://<production>/api/kit/auth/callback/github` |
| `KIT_PRODUCTION_URL` | recommandé | URL de production (`https://mon-app.compte.workers.dev`) : la connexion des aperçus passe par la production, une seule URL de retour à déclarer chez GitHub/Google |
| `KIT_AUTH_SECRET` | non | Secret des sessions ; généré automatiquement et stocké dans `kit_settings` s'il est absent |
| `KIT_ADMIN_EMAILS` | non | Admins en plus de l'option `admins` |
| `KIT_BASE_URL` | non | URL publique (déduite de la requête sinon) |
| `KIT_DEV_LOGIN` | non | `1` dans `.dev.vars` : connexion de test par simple email, **uniquement sur localhost** |

`GET /api/kit/status` (public, sans donnée secrète) indique si l'installation est prête : base, connexion configurée, admins, URL de production. L'assistant s'en sert pour vérifier un déploiement.

## Tester en local

Dans `.dev.vars` de l'app : `KIT_DEV_LOGIN=1`. Puis `npm run db:migrate` et `npm run dev` → http://localhost:5173 : la page de connexion propose « Mode local : se connecter avec un email ». Les règles d'accès s'appliquent (utiliser un email de la liste `admins`). Cette connexion est refusée hors de localhost, même si la variable est définie.

## Migrations

`npx vibe-kit sync` copie les migrations du kit manquantes dans `migrations/` de l'app (`NNNN_kit-*.sql`), à appliquer avec `wrangler d1 migrations apply DB`.

## CLI

| Commande | Effet |
|---|---|
| `npx vibe-kit version` | Version installée et dernière version (tags Git du dépôt) |
| `npx vibe-kit sync` | Copie les migrations du kit manquantes |
| `npx vibe-kit upgrade [vX.Y.Z]` | Pointe la dépendance sur le dernier tag (ou celui indiqué), `npm install`, puis `sync` |

## Développer le kit

```sh
npm install && npm run build
npm run test:install   # une fois : outils de test (sous-paquet test/)
npm test               # tests dans le runtime Workers + tests de la CLI
```

## Publier une version (mainteneur)

Une version est un **tag Git** `vX.Y.Z` :

```sh
npm version patch   # ou minor / major : met à jour package.json et src/version.ts, commit + tag
git push --follow-tags
```

Les apps la récupèrent avec `npm run kit:upgrade`.
