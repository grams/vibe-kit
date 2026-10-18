# vibe-kit

Socle pour apps **Cloudflare Workers + React** : connexion Google (et lien par email en option) sur D1, contrôle d'accès (admins, invitations, domaines autorisés), back-office extensible, profil d'app séparé du socle.

Le plus simple est de partir de **[vibe-template](https://github.com/grams/vibe-template)**, qui l'utilise et contient un `AGENTS.md` pour les agents IA.

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

Options de `createKit` : `appName`, `admins`, `protect` (`default`, `public`, `private` — motifs exacts ou `/préfixe/*`, sur les routes `/api`), `profile` (`table`, `defaults`), `onUserCreated`, `sendEmail`, `sessionDays`.

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
| `KIT_AUTH_SECRET` | oui | Signature des sessions |
| `KIT_GOOGLE_CLIENT_ID` / `KIT_GOOGLE_CLIENT_SECRET` | pour Google | Connexion Google ; redirection : `https://<domaine>/api/kit/auth/callback/google` |
| `KIT_BASE_URL` | non | URL publique (déduite de la requête sinon) |
| `KIT_ADMIN_EMAILS` | non | Admins en plus de l'option `admins` |
| `KIT_RESEND_API_KEY` / `KIT_EMAIL_FROM` | non | Active le lien de connexion par email (Resend) |
| `KIT_EMAIL_LOG` | non | `1` en local : lien par email affiché dans les logs, sans envoi |

## Migrations

`npx vibe-kit sync` copie les migrations du kit manquantes dans `migrations/` de l'app (`NNNN_kit-*.sql`), à appliquer avec `wrangler d1 migrations apply DB`.

## CLI

| Commande | Effet |
|---|---|
| `npx vibe-kit version` | Version installée et dernière version npm |
| `npx vibe-kit sync` | Copie les migrations du kit manquantes |
| `npx vibe-kit upgrade [X.Y.Z]` | `npm install vibe-kit@latest` puis `sync` |

## Publier une version (mainteneur)

Première fois uniquement :
1. `npm login` puis `npm publish` depuis ce dossier (crée le paquet sur npm).
2. Sur npmjs.com → paquet → *Settings* → *Trusted publishing* : ajouter GitHub Actions, dépôt `grams/vibe-kit`, workflow `publish.yml`, environnement `npm`.
3. Sur GitHub : *Settings* → *Environments* → créer `npm`.

Ensuite : `npm version patch | minor | major` puis `git push --follow-tags` ; la CI publie avec provenance.
