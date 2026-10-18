/**
 * vibe-kit — socle commun des apps Workers.
 *
 * Tout ce qui appartient au socle porte le préfixe « kit » :
 *   tables kit_*, routes /api/kit/*, variables KIT_*, cookies kit.*, migrations *_kit-*.sql,
 *   classes CSS kit-*, variables CSS --kit-*
 * L'app n'utilise jamais ce préfixe : c'est ce qui permet de mettre le kit à jour sans conflit.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { betterAuth } from "better-auth";
import { magicLink, oAuthProxy } from "better-auth/plugins";
import { createProfileStore, type ProfileOptions, type ProfileStore } from "./profile.js";
import { compileRules, type ProtectOptions } from "./protect.js";
import { adminEmails, adminRoutes, canSignUp, markInvitationAccepted } from "./access.js";
import { VERSION } from "./version.js";
import { resolveAuthSecret } from "./secret.js";

export { VERSION };

/** Bindings et secrets lus par le kit. */
export interface KitEnv {
  /** Base D1 partagée : le kit y possède les tables kit_*, l'app les siennes. */
  DB: D1Database;
  /** Fichiers statiques (binding "ASSETS"), servis quand aucune route de l'app ne correspond. */
  ASSETS?: Fetcher;
  /** Secret de signature des sessions. Facultatif : généré et stocké dans kit_settings s'il est absent. */
  KIT_AUTH_SECRET?: string;
  /** URL publique de l'app ; déduite de la requête si absente. */
  KIT_BASE_URL?: string;
  /**
   * URL de production, ex. https://mon-app.compte.workers.dev. Si définie, la connexion GitHub/Google
   * des aperçus passe par la production : une seule URL de retour à déclarer chez le fournisseur.
   */
  KIT_PRODUCTION_URL?: string;
  /** Connexion GitHub : activée si les deux sont définis (l'ID peut être une simple variable). */
  KIT_GITHUB_CLIENT_ID?: string;
  KIT_GITHUB_CLIENT_SECRET?: string;
  /** Connexion Google : activée si les deux sont définis. */
  KIT_GOOGLE_CLIENT_ID?: string;
  KIT_GOOGLE_CLIENT_SECRET?: string;
  /**
   * "1" en local uniquement (.dev.vars) : connexion de test par simple email, sans GitHub/Google.
   * Ne fonctionne que sur localhost, même si la variable est définie ailleurs.
   */
  KIT_DEV_LOGIN?: string;
  /** Admins supplémentaires (emails séparés par des virgules), en plus de l'option `admins`. */
  KIT_ADMIN_EMAILS?: string;
}

/** Utilisateur du socle (table kit_user). Les attributs propres à l'app vont dans son profil. */
export interface KitUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KitVariables {
  user: KitUser | null;
  /** true si l'utilisateur connecté est admin (email listé dans `admins` ou KIT_ADMIN_EMAILS). */
  isAdmin: boolean;
}

export type KitBindings<E extends KitEnv = KitEnv> = { Bindings: E; Variables: KitVariables };
export type KitContext<E extends KitEnv = KitEnv> = Context<KitBindings<E>>;

export interface KitOptions<E extends KitEnv, P> {
  /** Nom affiché sur la page de connexion. */
  appName: string;
  /** Emails des administrateurs de l'app (accès au back-office, toujours autorisés à se connecter). */
  admins?: string[];
  /** Routes /api réservées aux utilisateurs connectés (401 sinon). Défaut : publiques. Les pages se protègent côté React avec <Protected>. */
  protect?: ProtectOptions;
  /** Profil propre à l'app, lié 1:1 à kit_user (voir profile.get / profile.update). */
  profile?: ProfileOptions<P>;
  /** Appelé une fois, juste après la création d'un utilisateur. */
  onUserCreated?: (user: KitUser, env: E) => Promise<void> | void;
  /** Durée de session en jours (défaut 30). */
  sessionDays?: number;
}

export interface Kit<E extends KitEnv, P> {
  /** L'app Hono : y déclarer les routes, puis `export default kit.app`. */
  app: Hono<KitBindings<E>>;
  /** Profil de l'utilisateur connecté (si `profile` est configuré). */
  profile: ProfileStore<E, P>;
}

const AUTH_BASE = "/api/kit/auth";

/**
 * Crée l'app et ses outils.
 *   const kit = createKit<Env, Profile>({ appName: "Mon app", protect: { default: "private" } });
 *   kit.app.get("/api/notes", async (c) => { const user = currentUser(c); ... });
 *   export default kit.app;
 */
export function createKit<E extends KitEnv = KitEnv, P extends Record<string, unknown> = Record<string, never>>(
  options: KitOptions<E, P>,
): Kit<E, P> {
  const isProtected = compileRules(options.protect);
  const adminsFor = (c: KitContext<E>) => adminEmails(options.admins, c.env.KIT_ADMIN_EMAILS);
  const app = new Hono<KitBindings<E>>();

  // Une instance d'auth par origine (localhost en dev, domaine en prod), réutilisée entre requêtes.
  const authCache = new Map<string, Promise<ReturnType<typeof createAuth>>>();
  const authFor = (c: KitContext<E>) => {
    const origin = new URL(c.req.url).origin;
    let auth = authCache.get(origin);
    if (!auth) {
      auth = resolveAuthSecret(c.env.DB, c.env.KIT_AUTH_SECRET).then(({ secret }) =>
        createAuth(c.env, origin, secret, options),
      );
      auth.catch(() => authCache.delete(origin));
      authCache.set(origin, auth);
    }
    return auth;
  };

  // Diagnostic de l'installation (public, sans donnée sensible) : utilisé par l'assistant pour vérifier
  // qu'un déploiement est prêt. Déclaré avant tout accès à la base pour répondre même si elle est mal configurée.
  app.get("/api/kit/status", async (c) => c.json(await installStatus(c.env, options)));

  // Configuration manquante : message explicite plutôt qu'une erreur obscure.
  app.use("*", async (c, next) => {
    if (!c.env.DB) return c.json({ error: "vibe-kit : binding D1 'DB' manquant dans wrangler.jsonc" }, 500);
    await next();
  });

  // Routes d'authentification (Better Auth).
  app.on(["GET", "POST"], `${AUTH_BASE}/*`, async (c) => (await authFor(c)).handler(c.req.raw));

  // Utilisateur courant + protection des pages et des routes.
  app.use("*", async (c, next) => {
    const session = await (await authFor(c)).api.getSession({ headers: c.req.raw.headers });
    const user = (session?.user as KitUser | undefined) ?? null;
    c.set("user", user);
    c.set("isAdmin", Boolean(user && adminsFor(c).has(user.email.toLowerCase())));

    if (!user && isProtected(c.req.path)) return c.json({ error: "Connexion requise" }, 401);
    await next();
  });

  app.get("/api/kit/me", (c) =>
    c.json({
      user: c.get("user"),
      isAdmin: c.get("isAdmin"),
      appName: options.appName,
      providers: providersFor(c.env, c.req.url),
      version: VERSION,
    }),
  );

  // Mode local : connexion de test par email (KIT_DEV_LOGIN=1 et localhost uniquement).
  app.post("/api/kit/dev/login", async (c) => {
    if (!devLoginAllowed(c.env, c.req.url)) return c.json({ error: "Route inconnue" }, 404);
    type DevLoginBody = { email?: string; callbackURL?: string };
    const body = await c.req.json<DevLoginBody>().catch((): DevLoginBody => ({}));
    const callbackURL = body.callbackURL?.startsWith("/") ? body.callbackURL : "/";
    const email = (body.email ?? "").trim().toLowerCase();
    if (!email) return c.json({ error: "Email manquant" }, 400);
    const origin = new URL(c.req.url).origin;
    const res = await (await authFor(c)).handler(
      new Request(`${origin}${AUTH_BASE}/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email,
          callbackURL,
          errorCallbackURL: `${callbackURL}${callbackURL.includes("?") ? "&" : "?"}kit_error=1`,
        }),
      }),
    );
    const url = devLinks.get(email);
    devLinks.delete(email);
    if (!res.ok || !url) return c.json({ error: "Connexion locale impossible" }, 500);
    return c.json({ url });
  });

  // Back-office du socle : accès, invitations, utilisateurs.
  app.use("/api/kit/admin/*", requireAdmin);
  app.route(
    "/api/kit/admin",
    adminRoutes((env: E) => adminEmails(options.admins, env.KIT_ADMIN_EMAILS)) as any,
  );

  // Aucune route de l'app ne correspond : fichiers statiques (public/) ou 404.
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Route inconnue" }, 404);
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text("Introuvable", 404);
  });

  app.onError((err, c) => {
    console.error("[kit]", err);
    return c.req.path.startsWith("/api/") ? c.json({ error: "Erreur serveur" }, 500) : c.text("Erreur serveur", 500);
  });

  return { app, profile: createProfileStore<E, P>(options.profile) };
}

function createAuth<E extends KitEnv, P>(env: E, origin: string, secret: string, options: KitOptions<E, P>) {
  const baseURL = env.KIT_BASE_URL || origin;
  const productionURL = env.KIT_PRODUCTION_URL?.replace(/\/+$/, "");
  // Avec un relais : le fournisseur renvoie toujours vers la production, qui retransmet à l'aperçu.
  const redirect = (id: string) => (productionURL ? { redirectURI: `${productionURL}${AUTH_BASE}/callback/${id}` } : {});
  const socialProviders = {
    ...(env.KIT_GITHUB_CLIENT_ID && env.KIT_GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.KIT_GITHUB_CLIENT_ID, clientSecret: env.KIT_GITHUB_CLIENT_SECRET, ...redirect("github") } }
      : {}),
    ...(env.KIT_GOOGLE_CLIENT_ID && env.KIT_GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.KIT_GOOGLE_CLIENT_ID, clientSecret: env.KIT_GOOGLE_CLIENT_SECRET, ...redirect("google") } }
      : {}),
  };
  const hasSocial = Object.keys(socialProviders).length > 0;
  const trustedOrigins = [baseURL, ...(productionURL ? [productionURL, ...previewOrigins(productionURL)] : [])];
  const plugins = [
    ...(productionURL && hasSocial ? [oAuthProxy({ productionURL })] : []),
    // Connexion de test locale : lien à usage unique généré côté serveur, jamais envoyé ni exposé en ligne.
    ...(devLoginAllowed(env, origin)
      ? [
          magicLink({
            expiresIn: 60 * 5,
            sendMagicLink: async ({ email, url }) => {
              devLinks.set(email.toLowerCase(), url);
            },
          }),
        ]
      : []),
  ];

  return betterAuth({
    appName: options.appName,
    baseURL,
    basePath: AUTH_BASE,
    secret,
    trustedOrigins,
    database: env.DB,
    user: { modelName: "kit_user" },
    session: {
      modelName: "kit_session",
      expiresIn: 60 * 60 * 24 * (options.sessionDays ?? 30),
      // Session recopiée dans un cookie signé pendant 60 s : évite une lecture D1 à chaque requête.
      // (Un utilisateur supprimé garde donc l'accès 60 s au plus.)
      cookieCache: { enabled: true, maxAge: 60 },
    },
    account: { modelName: "kit_account" },
    verification: { modelName: "kit_verification" },
    advanced: { cookiePrefix: "kit" },
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          // Mode restreint : refuse la création des comptes non invités / hors domaines autorisés.
          before: async (user) => {
            const admins = adminEmails(options.admins, env.KIT_ADMIN_EMAILS);
            if (!(await canSignUp(env.DB, admins, user.email))) return false;
          },
          after: async (user) => {
            await markInvitationAccepted(env.DB, user.email);
            if (!options.onUserCreated) return;
            try {
              await options.onUserCreated(user as unknown as KitUser, env);
            } catch (err) {
              console.error("[kit] onUserCreated a échoué", err);
            }
          },
        },
      },
    },
    plugins,
  });
}

/** URL d'aperçu Cloudflare d'un Worker *.workers.dev : https://<version-ou-branche>-<worker>.<compte>.workers.dev */
function previewOrigins(productionURL: string): string[] {
  try {
    const { protocol, host } = new URL(productionURL);
    return host.endsWith(".workers.dev") ? [`${protocol}//*-${host}`] : [];
  } catch {
    return [];
  }
}

function providersFor(env: KitEnv, url?: string) {
  return {
    github: Boolean(env.KIT_GITHUB_CLIENT_ID && env.KIT_GITHUB_CLIENT_SECRET),
    google: Boolean(env.KIT_GOOGLE_CLIENT_ID && env.KIT_GOOGLE_CLIENT_SECRET),
    devLogin: Boolean(url && devLoginAllowed(env, url)),
  };
}

/** Liens de connexion locale en attente, par email (consommés aussitôt par /api/kit/dev/login). */
const devLinks = new Map<string, string>();

/** Connexion de test : seulement avec KIT_DEV_LOGIN=1 ET sur localhost (jamais en ligne). */
function devLoginAllowed(env: KitEnv, url: string) {
  if (env.KIT_DEV_LOGIN !== "1") return false;
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** État de l'installation, pour l'assistant et le dépannage. Aucune valeur secrète n'est renvoyée. */
async function installStatus(env: KitEnv, options: KitOptions<any, any>) {
  const providers = providersFor(env);
  let database: "ok" | "missing-binding" | "missing-tables" = "ok";
  if (!env.DB) database = "missing-binding";
  else {
    try {
      await env.DB.prepare("SELECT 1 FROM kit_user LIMIT 1").first();
      await env.DB.prepare("SELECT 1 FROM kit_settings LIMIT 1").first();
    } catch {
      database = "missing-tables";
    }
  }
  const admins = adminEmails(options.admins, env.KIT_ADMIN_EMAILS);
  const placeholderAdmins = [...admins].every((e) => /@(exemple|example)\.(fr|com|org)$/.test(e));
  const checks = {
    database,
    secret: env.KIT_AUTH_SECRET ? "env" : "auto",
    providers,
    loginReady: providers.github || providers.google,
    admins: admins.size === 0 ? "missing" : placeholderAdmins ? "placeholder" : "ok",
    productionUrl: Boolean(env.KIT_PRODUCTION_URL),
    githubPartial: Boolean(env.KIT_GITHUB_CLIENT_ID) !== Boolean(env.KIT_GITHUB_CLIENT_SECRET),
    // KIT_DEV_LOGIN ne doit exister qu'en local (.dev.vars) : signalé s'il est défini ailleurs.
    devLoginVar: env.KIT_DEV_LOGIN === "1",
  };
  const ready = checks.database === "ok" && checks.loginReady && checks.admins === "ok";
  return { ready, version: VERSION, appName: options.appName, ...checks };
}


/** Réserve une route aux admins (403). Pour les routes du back-office propres à l'app. */
export const requireAdmin: MiddlewareHandler<{ Variables: KitVariables }> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Connexion requise" }, 401);
  if (!c.get("isAdmin")) return c.json({ error: "Réservé aux administrateurs" }, 403);
  await next();
};

/** true si l'utilisateur connecté est admin. */
export function isAdmin(c: KitContext<any>): boolean {
  return Boolean(c.get("isAdmin"));
}

/** Bloque une route aux visiteurs non connectés (401). Inutile sur les routes déjà couvertes par `protect`. */
export const requireUser: MiddlewareHandler<{ Variables: KitVariables }> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Connexion requise" }, 401);
  await next();
};

/** L'utilisateur connecté, ou null. */
export function getUser(c: KitContext<any>): KitUser | null {
  return c.get("user") ?? null;
}

/** L'utilisateur connecté ; lève une erreur si personne ne l'est (à utiliser sur un chemin protégé). */
export function currentUser(c: KitContext<any>): KitUser {
  const user = c.get("user");
  if (!user) throw new Error("currentUser() appelé sans utilisateur connecté : protéger ce chemin");
  return user;
}

export type { ProtectOptions } from "./protect.js";
export type { AccessSettings, AccessMode, Invitation, AdminUser } from "./access.js";
export type { ProfileOptions, ProfileStore } from "./profile.js";
