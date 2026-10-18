# AGENTS.md — maintenance de vibe-kit

vibe-kit est le **socle partagé** de plusieurs apps Cloudflare Workers + React. Chaque changement doit pouvoir être installé dans une app existante par `npx vibe-kit upgrade` sans casser son code ni ses données.

## Règle n° 1 : le préfixe `kit` est réservé au socle

Tout ce que le kit crée porte ce préfixe, et seulement ce qu'il crée :

| Élément | Convention |
|---|---|
| Tables D1 | `kit_*` |
| Fichiers de migration | `migrations/NNN-description.sql` (copiés dans l'app en `NNNN_kit-NNN-description.sql`) |
| Routes HTTP | `/api/kit/*` |
| Variables et secrets | `KIT_*` |
| Cookies | préfixe `kit` |
| CSS | classes `.kit-*`, variables `--kit-*` |
| Logs | `[kit] …` |

Le kit **ne lit ni n'écrit jamais** les tables, routes ou variables d'une app (hors table de profil, uniquement via le nom fourni par l'app dans `profile.table`).

## Structure

| Fichier | Rôle |
|---|---|
| `src/index.ts` | `createKit()` : app Hono, auth Better Auth sur D1, protection `/api`, `/api/kit/me`, montage du back-office |
| `src/access.ts` | Admins, mode d'accès, domaines, invitations, routes `/api/kit/admin/*` |
| `src/profile.ts` | Profil d'app 1:1 (lecture/création à la demande, mise à jour) |
| `src/protect.ts` | Règles de protection des routes `/api` |
| `src/email.ts` | Envoi d'email (Resend) et contenu du lien magique |
| `src/react/index.tsx` | `vibe-kit/react` : provider, hooks, écrans par défaut, back-office |
| `src/react/styles.css` | Styles des écrans par défaut (`.kit-*`, `--kit-*`) |
| `migrations/` | Schéma des tables `kit_*` |
| `bin/vibe-kit.mjs` | CLI `version`, `sync`, `upgrade` |
| `test/` | Tests (sous-paquet à part : ses outils ne sont jamais installés par les apps) |

## Compatibilité avec les apps

1. **Migrations** : ne jamais modifier une migration publiée. Toute évolution = nouveau fichier, **additif uniquement** (ajout de table ou de colonne nullable / avec défaut). Jamais de `DROP` ni de renommage.
2. **API publique** (exports de `vibe-kit` et `vibe-kit/react`, options, routes `/api/kit/*`, variables `KIT_*`, classes et variables CSS) : ajouter plutôt que modifier. Un changement incompatible impose une version majeure.
3. **Interface surchargeable** : tout nouvel écran du kit doit passer par `KitComponents` (remplaçable), s'appuyer sur un hook sans interface, et n'utiliser que des classes `.kit-*` stylées par des variables `--kit-*`.
4. **Pas de nouvelle dépendance lourde** côté client : React est la seule dépendance d'exécution de `vibe-kit/react`.
5. **Relais OAuth des aperçus** (`KIT_PRODUCTION_URL`) : la connexion Google d'un aperçu passe par la **production**, qui exécute la version du kit qu'elle a déployée. Un changement qui touche au relais (routes `/api/kit/auth/*`, plugin `oauth-proxy`, format de l'état chiffré) doit rester compatible avec la version précédente, ou être déployé en production avant d'être utilisé sur un aperçu. À signaler dans la note de version.

## Vérifier un changement

1. `npm run typecheck` puis `npm run build`.
2. **Tests** : `npm run test:install` (une fois) puis `npm test`.
   - `test/kit.test.ts` : intégration dans le runtime Workers avec une base D1 locale (connexion par lien magique, accès restreint, invitations, domaines, back-office, profil, suppression en cascade) ;
   - `test/protect.test.ts` : règles de protection ;
   - `test/cli.test.mjs` : CLI (`sync`, erreurs).
   Tout changement de comportement s'accompagne d'un test ; tout bug corrigé, d'un test qui l'aurait détecté.
3. La CI (`.github/workflows/ci.yml`) rejoue tout cela et construit **vibe-template** avec le kit du commit : un changement qui casse le template casse la CI.
4. Pour un essai manuel : dans `vibe-template`, `npm install ../vibe-kit`, `npm run kit:sync`, `npm run db:migrate`, `npm run dev` avec `KIT_EMAIL_LOG=1` dans `.dev.vars` (le lien de connexion s'affiche dans le terminal).

**Ne jamais ajouter d'outil de test aux `devDependencies` racine** : une app qui installe le kit depuis GitHub installe ces dépendances pour le construire. Les outils de test vont dans `test/package.json`.

## Versions

Le kit s'installe depuis GitHub ; une version est un tag `vX.Y.Z`. Pas de version tant que le mainteneur ne l'a pas décidé. Publication : `npm version …` puis `git push --follow-tags` (voir README).
