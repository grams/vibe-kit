import { env } from "cloudflare:workers";
import { createKit, currentUser, requireAdmin, type KitEnv, type KitOptions } from "../src/index";

export const ORIGIN = "http://localhost";
export const ADMIN = "admin@test.fr";

type Profile = { display_name: string | null; theme: string | null };

/** Crée une app de test : options du kit + quelques routes d'app, emails capturés. */
export function makeApp(
  overrides: Partial<KitOptions<KitEnv, Profile>> = {},
  envOverrides: Partial<KitEnv> = {},
) {
  const created: string[] = [];
  const kit = createKit<KitEnv, Profile>({
    appName: "App de test",
    admins: [ADMIN],
    protect: { default: "private", public: ["/api/public/*"] },
    profile: { table: "profile", defaults: (u) => ({ display_name: u.email.split("@")[0] }) },
    onUserCreated: async (user) => {
      created.push(user.email);
    },
    ...overrides,
  });
  const app = kit.app;
  app.get("/api/public/ping", (c) => c.json({ ok: true }));
  app.get("/api/private/ping", (c) => c.json({ email: currentUser(c).email }));
  app.get("/api/profile", async (c) => c.json(await kit.profile.get(c)));
  app.put("/api/profile", async (c) => c.json(await kit.profile.update(c, await c.req.json())));
  app.get("/api/admin/ping", requireAdmin, (c) => c.json({ ok: true }));

  const testEnv = { ...env, ...envOverrides } as unknown as KitEnv;

  /** Requête vers l'app ; `cookie` = session d'un utilisateur. */
  async function request(path: string, init: RequestInit & { cookie?: string; json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", ORIGIN);
    if (init.cookie) headers.set("cookie", init.cookie);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return app.request(`${ORIGIN}${path}`, { ...init, headers, body, redirect: "manual" }, testEnv);
  }

  /**
   * Connexion de test (KIT_DEV_LOGIN=1 sur localhost). Renvoie le cookie de session, ou null si la
   * connexion est refusée (avec l'URL de redirection pour vérifier l'erreur).
   */
  async function login(email: string): Promise<{ cookie: string | null; location: string }> {
    const res = await request("/api/kit/dev/login", { method: "POST", json: { email, callbackURL: "/app" } });
    if (res.status !== 200) throw new Error(`dev/login : ${res.status} ${await res.text()}`);
    const url = new URL(((await res.json()) as { url: string }).url);
    const verify = await request(url.pathname + url.search);
    const location = verify.headers.get("location") ?? "";
    const cookies = verify.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("="));
    const hasSession = cookies.some((c) => c.startsWith("kit.session_token="));
    return { cookie: hasSession ? cookies.join("; ") : null, location };
  }

  return { app, kit, request, login, created };
}

/** Vide les tables entre deux tests. */
export async function resetDb() {
  await env.DB.batch(
    ["profile", "kit_session", "kit_account", "kit_verification", "kit_invitation", "kit_settings", "kit_user"].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
