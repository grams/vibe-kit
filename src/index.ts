/**
 * vibe-kit — socle commun des apps Workers.
 *
 * Fournit :
 *  - createApp() : une app Hono avec l'auth déjà branchée (Google + lien magique par email)
 *  - requireUser  : middleware qui bloque les routes aux visiteurs non connectés
 *  - getUser(c)   : l'utilisateur connecté (ou null)
 *  - /vibe-kit.js : le client navigateur, servi automatiquement
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { clientScript } from "./client.js";
import { sendEmail, magicLinkEmail, type SendEmail } from "./email.js";
import { VERSION } from "./version.js";

export { VERSION };

/** Variables d'environnement attendues par le kit (bindings + secrets). */
export interface KitEnv {
  /** Base D1 (binding "DB" dans wrangler.jsonc). */
  DB: D1Database;
  /** Secret aléatoire de signature des sessions (wrangler secret put BETTER_AUTH_SECRET). */
  BETTER_AUTH_SECRET: string;
  /** URL publique de l'app, ex. https://mon-app.workers.dev. Déduite de la requête si absente. */
  BETTER_AUTH_URL?: string;
  /** Login Google : activé seulement si les deux sont définis. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Envoi des emails via Resend. Sans clé, le lien magique est affiché dans les logs. */
  RESEND_API_KEY?: string;
  /** Expéditeur des emails, ex. "Mon app <noreply@mondomaine.fr>". */
  EMAIL_FROM?: string;
}

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

export interface KitOptions {
  /** Nom affiché dans les emails. */
  appName: string;
  /** Remplace l'envoi d'email par défaut (Resend / logs). */
  sendEmail?: SendEmail;
  /** Durée de session en jours (défaut 30). */
  sessionDays?: number;
}

function createAuth(env: KitEnv, origin: string, options: KitOptions) {
  const baseURL = env.BETTER_AUTH_URL || origin;
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : undefined;
  const send = options.sendEmail ?? ((msg) => sendEmail(env, msg));

  return betterAuth({
    appName: options.appName,
    baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL],
    database: env.DB,
    session: { expiresIn: 60 * 60 * 24 * (options.sessionDays ?? 30) },
    socialProviders: google,
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

type Auth = ReturnType<typeof createAuth>;

/**
 * Crée l'app. Usage :
 *   const app = createApp<Env>({ appName: "Mon app" });
 *   app.get("/api/truc", requireUser, (c) => ...);
 *   export default app;
 */
export function createApp<E extends KitEnv = KitEnv>(options: KitOptions) {
  const app = new Hono<KitBindings<E>>();
  // Une instance d'auth par origine (localhost en dev, domaine en prod), réutilisée entre requêtes.
  const cache = new Map<string, Auth>();
  const authFor = (c: KitContext<E>) => {
    const origin = new URL(c.req.url).origin;
    let auth = cache.get(origin);
    if (!auth) {
      auth = createAuth(c.env, origin, options);
      cache.set(origin, auth);
    }
    return auth;
  };

  // Configuration manquante : message clair plutôt qu'une erreur obscure.
  app.use("/api/*", async (c, next) => {
    if (!c.env.DB) return c.json({ error: "Binding D1 'DB' manquant dans wrangler.jsonc" }, 500);
    if (!c.env.BETTER_AUTH_SECRET)
      return c.json({ error: "Secret BETTER_AUTH_SECRET manquant (lancer npm run setup)" }, 500);
    await next();
  });

  // Routes d'auth gérées par Better Auth.
  app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(c).handler(c.req.raw));

  // Charge l'utilisateur connecté sur toutes les routes /api.
  app.use("/api/*", async (c, next) => {
    const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
    c.set("user", (session?.user as KitUser | undefined) ?? null);
    await next();
  });

  // Utilisateur courant + méthodes de connexion disponibles (utilisé par le client).
  app.get("/api/kit/me", (c) =>
    c.json({
      user: c.get("user"),
      providers: {
        google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
        magicLink: true,
      },
      version: VERSION,
    }),
  );

  // Client navigateur, toujours à la version de la lib installée.
  app.get("/vibe-kit.js", (c) =>
    c.body(clientScript, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Erreur serveur" }, 500);
  });

  return app;
}

/** Bloque la route si personne n'est connecté (401). */
export const requireUser: MiddlewareHandler<KitBindings> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Connexion requise" }, 401);
  await next();
};

/** L'utilisateur connecté, ou null. */
export function getUser(c: KitContext<any>): KitUser | null {
  return c.get("user") ?? null;
}

/** L'utilisateur connecté ; à utiliser après requireUser. */
export function currentUser(c: KitContext<any>): KitUser {
  const user = c.get("user");
  if (!user) throw new Error("currentUser() appelé sans requireUser");
  return user;
}

export { sendEmail, type SendEmail, type EmailMessage } from "./email.js";
