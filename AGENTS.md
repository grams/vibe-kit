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

## Compatibilité avec les apps

1. **Migrations** : ne jamais modifier une migration publiée. Toute évolution = nouveau fichier, **additif uniquement** (ajout de table ou de colonne nullable / avec défaut). Jamais de `DROP` ni de renommage.
2. **API publique** (exports de `vibe-kit` et `vibe-kit/react`, options, routes `/api/kit/*`, variables `KIT_*`, classes et variables CSS) : ajouter plutôt que modifier. Un changement incompatible impose une version majeure.
3. **Interface surchargeable** : tout nouvel écran du kit doit passer par `KitComponents` (remplaçable), s'appuyer sur un hook sans interface, et n'utiliser que des classes `.kit-*` stylées par des variables `--kit-*`.
4. **Pas de nouvelle dépendance lourde** côté client : React est la seule dépendance d'exécution de `vibe-kit/react`.

## Vérifier un changement

1. `npm run typecheck` puis `npm run build`.
2. Tester dans le template : dans `vibe-template`, `npm install ../vibe-kit` (ou `npm install git+https://github.com/grams/vibe-kit.git#<branche>`), `npm run kit:sync`, `npm run db:migrate`, `npm run dev` avec `KIT_EMAIL_LOG=1` dans `.dev.vars` (le lien de connexion s'affiche dans le terminal).
3. Vérifier : connexion, refus d'un compte non invité, back-office (accès, invitations, utilisateurs), profil, mode sombre.

## Versions

Le kit s'installe depuis GitHub ; une version est un tag `vX.Y.Z`. Pas de version tant que le mainteneur ne l'a pas décidé. Publication : `npm version …` puis `git push --follow-tags` (voir README).
