/**
 * vibe-kit — socle commun des apps Workers.
 *
 * Tout ce qui appartient au socle porte le préfixe « kit » :
 *   tables kit_*, routes /api/kit/* et /kit/*, variables KIT_*, cookies kit.*, migrations *_kit-*.sql
 * L'app n'utilise jamais ce préfixe : c'est ce qui permet de mettre le kit à jour sans conflit.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { clientScript } from "./client.js";
import { loginPage } from "./login.js";
import { sendEmail, magicLinkEmail, type SendEmail } from "./email.js";
import { createProfileStore, type ProfileOptions, type ProfileStore } from "./profile.js";
import { compileRules, type ProtectOptions } from "./protect.js";
import { VERSION } from "./version.js";

export { VERSION };

/** Bindings et secrets lus par le kit. */
export interface KitEnv {
  /** Base D1 partagée : le kit y possède les tables kit_*, l'app les siennes. */
  DB: D1Database;
  /** Fichiers statiques (binding "ASSETS" de wrangler.jsonc). Nécessaire pour protéger des pages. */
  ASSETS?: Fetcher;
  /** Secret de signature des sessions. */
  KIT_AUTH_SECRET: string;
  /** URL publique de l'app ; déduite de la requête si absente. */
  KIT_BASE_URL?: string;
  /** Connexion Google : activée si les deux sont définis. */
  KIT_GOOGLE_CLIENT_ID?: string;
  KIT_GOOGLE_CLIENT_SECRET?: string;
  /** Envoi des emails via Resend ; sans clé, le lien magique est affiché dans les logs. */
  KIT_RESEND_API_KEY?: string;
  /** Expéditeur, ex. "Mon app <noreply@mondomaine.fr>". */
  KIT_EMAIL_FROM?: string;
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
}

export type KitBindings<E extends KitEnv = KitEnv> = { Bindings: E; Variables: KitVariables };
export type KitContext<E extends KitEnv = KitEnv> = Context<KitBindings<E>>;

export interface KitOptions<E extends KitEnv, P> {
  /** Nom affiché sur la page de connexion et dans les emails. */
  appName: string;
  /** Pages et routes réservées aux utilisateurs connectés. Défaut : tout est public. */
  protect?: ProtectOptions;
  /** Page de connexion. Défaut "/kit/login" (fournie par le kit). Une page de l'app est rendue publique automatiquement. */
  loginPath?: string;
  /** Profil propre à l'app, lié 1:1 à kit_user (voir profile.get / profile.update). */
  profile?: ProfileOptions<P>;
  /** Appelé une fois, juste après la création d'un utilisateur. */
  onUserCreated?: (user: KitUser, env: E) => Promise<void> | void;
  /** Remplace l'envoi d'email par défaut. */
  sendEmail?: SendEmail;
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
 *   const kit = createKit<Env, Profile>({ appName: "Mon app", protect: { default: "private", public: ["/"] } });
 *   kit.app.get("/api/notes", async (c) => { const user = currentUser(c); ... });
 *   export default kit.app;
 */
export function createKit<E extends KitEnv = KitEnv, P extends Record<string, unknown> = Record<string, never>>(
  options: KitOptions<E, P>,
): Kit<E, P> {
  const loginPath = options.loginPath ?? "/kit/login";
  const isProtected = compileRules(options.protect, loginPath);
  const app = new Hono<KitBindings<E>>();

  // Une instance d'auth par origine (localhost en dev, domaine en prod), réutilisée entre requêtes.
  const authCache = new Map<string, ReturnType<typeof createAuth>>();
  const authFor = (c: KitContext<E>) => {
    const origin = new URL(c.req.url).origin;
    let auth = authCache.get(origin);
    if (!auth) {
      auth = createAuth(c.env, origin, options);
      authCache.set(origin, auth);
    }
    return auth;
  };

  // Configuration manquante : message explicite plutôt qu'une erreur obscure.
  app.use("*", async (c, next) => {
    if (!c.env.DB) return c.text("vibe-kit : binding D1 'DB' manquant dans wrangler.jsonc", 500);
    if (!c.env.KIT_AUTH_SECRET) return c.text("vibe-kit : secret KIT_AUTH_SECRET manquant (npm run setup)", 500);
    await next();
  });

  // Routes d'authentification (Better Auth).
  app.on(["GET", "POST"], `${AUTH_BASE}/*`, (c) => authFor(c).handler(c.req.raw));

  // Utilisateur courant + protection des pages et des routes.
  app.use("*", async (c, next) => {
    const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
    const user = (session?.user as KitUser | undefined) ?? null;
    c.set("user", user);

    const url = new URL(c.req.url);
    if (!user && isProtected(url.pathname)) {
      if (url.pathname.startsWith("/api/")) return c.json({ error: "Connexion requise" }, 401);
      const target = `${loginPath}?next=${encodeURIComponent(url.pathname + url.search)}`;
      return c.redirect(target, 302);
    }
    await next();
  });

  app.get("/api/kit/me", (c) =>
    c.json({
      user: c.get("user"),
      providers: {
        google: Boolean(c.env.KIT_GOOGLE_CLIENT_ID && c.env.KIT_GOOGLE_CLIENT_SECRET),
        magicLink: true,
      },
      loginPath,
      version: VERSION,
    }),
  );

  app.get("/kit/client.js", (c) =>
    c.body(clientScript, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  if (loginPath === "/kit/login") {
    app.get("/kit/login", (c) => c.html(loginPage(options.appName)));
  }

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

function createAuth<E extends KitEnv, P>(env: E, origin: string, options: KitOptions<E, P>) {
  const baseURL = env.KIT_BASE_URL || origin;
  const google =
    env.KIT_GOOGLE_CLIENT_ID && env.KIT_GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.KIT_GOOGLE_CLIENT_ID, clientSecret: env.KIT_GOOGLE_CLIENT_SECRET } }
      : undefined;
  const send = options.sendEmail ?? ((msg) => sendEmail(env, msg));

  return betterAuth({
    appName: options.appName,
    baseURL,
    basePath: AUTH_BASE,
    secret: env.KIT_AUTH_SECRET,
    trustedOrigins: [baseURL],
    database: env.DB,
    user: { modelName: "kit_user" },
    session: {
      modelName: "kit_session",
      expiresIn: 60 * 60 * 24 * (options.sessionDays ?? 30),
      // Session recopiée dans un cookie signé : évite une lecture D1 à chaque page.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: { modelName: "kit_account" },
    verification: { modelName: "kit_verification" },
    advanced: { cookiePrefix: "kit" },
    socialProviders: google,
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
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
    plugins: [
      magicLink({
        expiresIn: 60 * 15,
        sendMagicLink: async ({ email, url }) => {
          await send(magicLinkEmail(options.appName, email, url));
        },
      }),
    ],
  });
}

/** Bloque une route aux visiteurs non connectés (401). Inutile sur les chemins déjà couverts par `protect`. */
export const requireUser: MiddlewareHandler<KitBindings<any>> = async (c, next) => {
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
export type { ProfileOptions, ProfileStore } from "./profile.js";
export { sendEmail, type SendEmail, type EmailMessage } from "./email.js";
