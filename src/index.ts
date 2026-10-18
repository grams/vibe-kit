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
import { magicLink } from "better-auth/plugins";
import { sendEmail, magicLinkEmail, type SendEmail } from "./email.js";
import { createProfileStore, type ProfileOptions, type ProfileStore } from "./profile.js";
import { compileRules, type ProtectOptions } from "./protect.js";
import { adminEmails, adminRoutes, canSignUp, markInvitationAccepted } from "./access.js";
import { VERSION } from "./version.js";

export { VERSION };

/** Bindings et secrets lus par le kit. */
export interface KitEnv {
  /** Base D1 partagée : le kit y possède les tables kit_*, l'app les siennes. */
  DB: D1Database;
  /** Fichiers statiques (binding "ASSETS"), servis quand aucune route de l'app ne correspond. */
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
  /** "1" en local uniquement : active le lien magique et l'affiche dans les logs au lieu de l'envoyer. */
  KIT_EMAIL_LOG?: string;
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
  /** Nom affiché sur la page de connexion et dans les emails. */
  appName: string;
  /** Emails des administrateurs de l'app (accès au back-office, toujours autorisés à se connecter). */
  admins?: string[];
  /** Routes /api réservées aux utilisateurs connectés (401 sinon). Défaut : publiques. Les pages se protègent côté React avec <Protected>. */
  protect?: ProtectOptions;
  /** Profil propre à l'app, lié 1:1 à kit_user (voir profile.get / profile.update). */
  profile?: ProfileOptions<P>;
  /** Appelé une fois, juste après la création d'un utilisateur. */
  onUserCreated?: (user: KitUser, env: E) => Promise<void> | void;
  /** Envoi d'email personnalisé. Sans lui ni KIT_RESEND_API_KEY, le lien magique est désactivé. */
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
    if (!c.env.DB) return c.json({ error: "vibe-kit : binding D1 'DB' manquant dans wrangler.jsonc" }, 500);
    if (!c.env.KIT_AUTH_SECRET) return c.json({ error: "vibe-kit : secret KIT_AUTH_SECRET manquant" }, 500);
    await next();
  });

  // Routes d'authentification (Better Auth).
  app.on(["GET", "POST"], `${AUTH_BASE}/*`, (c) => authFor(c).handler(c.req.raw));

  // Utilisateur courant + protection des pages et des routes.
  app.use("*", async (c, next) => {
    const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
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
      providers: {
        google: Boolean(c.env.KIT_GOOGLE_CLIENT_ID && c.env.KIT_GOOGLE_CLIENT_SECRET),
        magicLink: emailEnabled(c.env, options),
      },
      version: VERSION,
    }),
  );

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
      // Session recopiée dans un cookie signé pendant 60 s : évite une lecture D1 à chaque requête.
      // (Un utilisateur supprimé garde donc l'accès 60 s au plus.)
      cookieCache: { enabled: true, maxAge: 60 },
    },
    account: { modelName: "kit_account" },
    verification: { modelName: "kit_verification" },
    advanced: { cookiePrefix: "kit" },
    socialProviders: google,
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
    plugins: emailEnabled(env, options)
      ? [
          magicLink({
            expiresIn: 60 * 15,
            sendMagicLink: async ({ email, url }) => {
              await send(magicLinkEmail(options.appName, email, url));
            },
          }),
        ]
      : [],
  });
}

function emailEnabled(env: KitEnv, options: { sendEmail?: SendEmail }) {
  return Boolean(options.sendEmail || env.KIT_RESEND_API_KEY || env.KIT_EMAIL_LOG === "1");
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
export { sendEmail, type SendEmail, type EmailMessage } from "./email.js";
