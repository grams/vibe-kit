import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { ADMIN, makeApp, resetDb } from "./helpers";
import { createProfileStore } from "../src/profile";
import { resetSecretCache } from "../src/secret";

beforeEach(resetDb);

async function json(res: Response) {
  return (await res.json()) as any;
}

describe("session et protection des routes", () => {
  it("renvoie un visiteur anonyme et les méthodes de connexion", async () => {
    const { request } = makeApp();
    const me = await json(await request("/api/kit/me"));
    expect(me.user).toBeNull();
    expect(me.isAdmin).toBe(false);
    expect(me.appName).toBe("App de test");
    expect(me.providers).toEqual({ github: false, google: false, devLogin: true });
  });

  it("bloque les routes privées sans session et laisse passer les publiques", async () => {
    const { request } = makeApp();
    expect((await request("/api/private/ping")).status).toBe(401);
    expect((await request("/api/public/ping")).status).toBe(200);
  });

  it("répond 404 en JSON sur une route /api inconnue", async () => {
    const { request, login } = makeApp();
    const { cookie } = await login(ADMIN);
    const res = await request("/api/inconnue", { cookie: cookie! });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "Route inconnue" });
  });

  it("génère et réutilise un secret de session si KIT_AUTH_SECRET est absent", async () => {
    resetSecretCache();
    const { request, login } = makeApp({}, { KIT_AUTH_SECRET: "" });
    const { cookie } = await login(ADMIN);
    expect(cookie).not.toBeNull();
    const row = await env.DB.prepare("SELECT value FROM kit_settings WHERE key = 'auth_secret'").first<{ value: string }>();
    expect(JSON.parse(row!.value)).toHaveLength(43);
    // Une autre instance (nouvel isolat) relit le même secret : la session reste valide.
    resetSecretCache();
    const again = makeApp({}, { KIT_AUTH_SECRET: "" });
    const me = await json(await again.request("/api/kit/me", { cookie: cookie! }));
    expect(me.user?.email).toBe(ADMIN);
    resetSecretCache();
  });

  it("active la connexion GitHub quand l'ID et le secret sont définis", async () => {
    const { request } = makeApp({}, { KIT_GITHUB_CLIENT_ID: "Iv1.test", KIT_GITHUB_CLIENT_SECRET: "s" });
    expect((await json(await request("/api/kit/me"))).providers.github).toBe(true);
    const res = await request("/api/kit/auth/sign-in/social", { method: "POST", json: { provider: "github", callbackURL: "/app" } });
    const url = new URL((await json(res)).url);
    expect(url.host).toBe("github.com");
    expect(url.searchParams.get("client_id")).toBe("Iv1.test");
  });

  it("fait passer la connexion des aperçus par la production (relais)", async () => {
    const { request } = makeApp(
      {},
      { KIT_GITHUB_CLIENT_ID: "Iv1.test", KIT_GITHUB_CLIENT_SECRET: "s", KIT_PRODUCTION_URL: "https://mon-app.compte.workers.dev/" },
    );
    const res = await request("/api/kit/auth/sign-in/social", { method: "POST", json: { provider: "github", callbackURL: "/app" } });
    const url = new URL((await json(res)).url);
    expect(url.searchParams.get("redirect_uri")).toBe("https://mon-app.compte.workers.dev/api/kit/auth/callback/github");
  });
});

describe("connexion et contrôle d'accès", () => {
  it("connecte un admin déclaré dans la configuration", async () => {
    const { request, login, created } = makeApp();
    const { cookie } = await login(ADMIN);
    expect(cookie).not.toBeNull();
    const me = await json(await request("/api/kit/me", { cookie: cookie! }));
    expect(me.user.email).toBe(ADMIN);
    expect(me.isAdmin).toBe(true);
    expect((await request("/api/private/ping", { cookie: cookie! })).status).toBe(200);
    expect(created).toEqual([ADMIN]);
  });

  it("reconnaît les admins de KIT_ADMIN_EMAILS (insensible à la casse)", async () => {
    const { request, login } = makeApp({}, { KIT_ADMIN_EMAILS: " Autre@Test.fr , x@y.fr" });
    const { cookie } = await login("autre@test.fr");
    expect((await json(await request("/api/kit/me", { cookie: cookie! }))).isAdmin).toBe(true);
  });

  it("refuse un inconnu en mode restreint, sans créer de compte", async () => {
    const { login, created } = makeApp();
    const { cookie, location } = await login("inconnu@ailleurs.com");
    expect(cookie).toBeNull();
    expect(location).toContain("kit_error=1");
    expect(created).toEqual([]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM kit_user").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("accepte un invité et marque l'invitation comme acceptée", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    const res = await request("/api/kit/admin/invitations", {
      method: "POST",
      cookie: admin.cookie!,
      json: { email: "  Ami@Ailleurs.com " },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).email).toBe("ami@ailleurs.com");

    const ami = await login("ami@ailleurs.com");
    expect(ami.cookie).not.toBeNull();
    const invitations = await json(await request("/api/kit/admin/invitations", { cookie: admin.cookie! }));
    expect(invitations[0].acceptedAt).not.toBeNull();
  });

  it("accepte les adresses d'un domaine autorisé", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    const res = await request("/api/kit/admin/settings", {
      method: "PUT",
      cookie: admin.cookie!,
      json: { allowedDomains: ["@Famille.fr", " "] },
    });
    expect(await json(res)).toEqual({ mode: "restricted", allowedDomains: ["famille.fr"] });
    expect((await login("bob@famille.fr")).cookie).not.toBeNull();
    expect((await login("bob@famille.fr.evil.com")).cookie).toBeNull();
  });

  it("rejette un domaine ou un mode invalide", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    const bad = await request("/api/kit/admin/settings", {
      method: "PUT",
      cookie: admin.cookie!,
      json: { allowedDomains: ["pas un domaine"] },
    });
    expect(bad.status).toBe(400);
    const badMode = await request("/api/kit/admin/settings", { method: "PUT", cookie: admin.cookie!, json: { mode: "x" } });
    expect(badMode.status).toBe(400);
  });

  it("accepte tout le monde en mode ouvert", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    await request("/api/kit/admin/settings", { method: "PUT", cookie: admin.cookie!, json: { mode: "open" } });
    expect((await login("nimporte@qui.com")).cookie).not.toBeNull();
  });
});

describe("back-office", () => {
  it("réserve les routes d'administration aux admins", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    await request("/api/kit/admin/settings", { method: "PUT", cookie: admin.cookie!, json: { mode: "open" } });
    const user = await login("user@test.fr");

    for (const path of ["/api/kit/admin/users", "/api/kit/admin/settings", "/api/admin/ping"]) {
      expect((await request(path)).status, `${path} anonyme`).toBe(401);
      expect((await request(path, { cookie: user.cookie! })).status, `${path} utilisateur`).toBe(403);
      expect((await request(path, { cookie: admin.cookie! })).status, `${path} admin`).toBe(200);
    }
  });

  it("liste les utilisateurs avec leur statut d'admin", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    await request("/api/kit/admin/settings", { method: "PUT", cookie: admin.cookie!, json: { mode: "open" } });
    await login("user@test.fr");
    const users = await json(await request("/api/kit/admin/users", { cookie: admin.cookie! }));
    expect(users.map((u: any) => [u.email, u.admin]).sort()).toEqual([
      [ADMIN, true],
      ["user@test.fr", false],
    ]);
  });

  it("supprime un utilisateur et ses données liées, mais ni soi-même ni un admin", async () => {
    const { request, login } = makeApp({}, { KIT_ADMIN_EMAILS: "admin2@test.fr" });
    const admin = await login(ADMIN);
    await request("/api/kit/admin/settings", { method: "PUT", cookie: admin.cookie!, json: { mode: "open" } });
    const user = await login("user@test.fr");
    await login("admin2@test.fr");
    await request("/api/profile", { cookie: user.cookie! }); // crée le profil

    const users = await json(await request("/api/kit/admin/users", { cookie: admin.cookie! }));
    const id = (email: string) => users.find((u: any) => u.email === email).id;

    expect((await request(`/api/kit/admin/users/${id(ADMIN)}`, { method: "DELETE", cookie: admin.cookie! })).status).toBe(400);
    expect(
      (await request(`/api/kit/admin/users/${id("admin2@test.fr")}`, { method: "DELETE", cookie: admin.cookie! })).status,
    ).toBe(400);
    expect(
      (await request(`/api/kit/admin/users/${id("user@test.fr")}`, { method: "DELETE", cookie: admin.cookie! })).status,
    ).toBe(204);

    const left = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM kit_user WHERE email = 'user@test.fr') AS users, (SELECT COUNT(*) FROM profile) AS profiles, (SELECT COUNT(*) FROM kit_session WHERE userId = ?) AS sessions",
    )
      .bind(id("user@test.fr"))
      .first();
    expect(left).toEqual({ users: 0, profiles: 0, sessions: 0 });
  });

  it("retire une invitation", async () => {
    const { request, login } = makeApp();
    const admin = await login(ADMIN);
    await request("/api/kit/admin/invitations", { method: "POST", cookie: admin.cookie!, json: { email: "a@b.fr" } });
    const del = await request(`/api/kit/admin/invitations/${encodeURIComponent("a@b.fr")}`, {
      method: "DELETE",
      cookie: admin.cookie!,
    });
    expect(del.status).toBe(204);
    expect(await json(await request("/api/kit/admin/invitations", { cookie: admin.cookie! }))).toEqual([]);
    expect((await login("a@b.fr")).cookie).toBeNull();
  });
});

describe("profil d'app", () => {
  it("crée le profil à la première lecture avec les valeurs par défaut", async () => {
    const { request, login } = makeApp();
    const { cookie } = await login(ADMIN);
    const profile = await json(await request("/api/profile", { cookie: cookie! }));
    expect(profile.display_name).toBe("admin");
    expect(profile.theme).toBeNull();
    // Une deuxième lecture ne recrée rien.
    await request("/api/profile", { cookie: cookie! });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM profile").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("met à jour les colonnes sans toucher à user_id", async () => {
    const { request, login } = makeApp();
    const { cookie } = await login(ADMIN);
    const before = await json(await request("/api/profile", { cookie: cookie! }));
    const after = await json(
      await request("/api/profile", { method: "PUT", cookie: cookie!, json: { theme: "sombre", user_id: "pirate" } }),
    );
    expect(after).toEqual({ ...before, theme: "sombre" });
  });

  it("refuse un nom de colonne invalide", async () => {
    const { request, login } = makeApp();
    const { cookie } = await login(ADMIN);
    const res = await request("/api/profile", { method: "PUT", cookie: cookie!, json: { "theme = 'x'; --": "y" } });
    expect(res.status).toBe(500);
  });

  it("refuse une table de profil préfixée kit_", () => {
    expect(() => createProfileStore({ table: "kit_profile" })).toThrow(/réservé au socle/);
    expect(() => createProfileStore({ table: "profile; DROP" })).toThrow(/invalide/);
  });
});

describe("connexion en mode local", () => {
  it("connecte par simple email sur localhost avec KIT_DEV_LOGIN=1", async () => {
    const { request, login } = makeApp();
    const { cookie } = await login(ADMIN.toUpperCase());
    expect((await json(await request("/api/kit/me", { cookie: cookie! }))).user.email).toBe(ADMIN);
  });

  it("applique les règles d'accès à la connexion locale", async () => {
    const { login } = makeApp();
    const { cookie, location } = await login("inconnu@ailleurs.com");
    expect(cookie).toBeNull();
    expect(location).toContain("kit_error=1");
  });

  it("refuse la connexion locale sans KIT_DEV_LOGIN", async () => {
    const { request } = makeApp({}, { KIT_DEV_LOGIN: "" });
    expect((await json(await request("/api/kit/me"))).providers.devLogin).toBe(false);
    expect((await request("/api/kit/dev/login", { method: "POST", json: { email: ADMIN } })).status).toBe(404);
    // Et le lien magique interne n'est pas exposé.
    expect((await request("/api/kit/auth/sign-in/magic-link", { method: "POST", json: { email: ADMIN } })).status).toBe(404);
  });

  it("refuse la connexion locale hors de localhost, même avec KIT_DEV_LOGIN", async () => {
    const { app } = makeApp();
    const base = "https://mon-app.compte.workers.dev";
    const post = (path: string) =>
      app.request(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email: ADMIN }),
      }, env);
    expect((await post("/api/kit/dev/login")).status).toBe(404);
    expect((await post("/api/kit/auth/sign-in/magic-link")).status).toBe(404);
    const me = (await (await app.request(`${base}/api/kit/me`, {}, env)).json()) as any;
    expect(me.providers.devLogin).toBe(false);
    const status = (await (await app.request(`${base}/api/kit/status`, {}, env)).json()) as any;
    expect(status.devLoginVar).toBe(true);
  });
});

describe("diagnostic d'installation", () => {
  it("signale ce qui manque, sans rien de secret", async () => {
    const { request } = makeApp({ admins: ["admin@exemple.fr"] });
    const status = await json(await request("/api/kit/status"));
    expect(status).toMatchObject({
      ready: false,
      database: "ok",
      loginReady: false,
      admins: "placeholder",
      productionUrl: false,
      providers: { github: false, google: false },
    });
    expect(JSON.stringify(status)).not.toContain("secret-de-test");
  });

  it("est prêt quand base, connexion et admins sont configurés", async () => {
    const { request } = makeApp({}, { KIT_GITHUB_CLIENT_ID: "Iv1.test", KIT_GITHUB_CLIENT_SECRET: "s" });
    const status = await json(await request("/api/kit/status"));
    expect(status).toMatchObject({ ready: true, loginReady: true, admins: "ok", githubPartial: false });
  });

  it("repère un identifiant GitHub sans secret", async () => {
    const { request } = makeApp({}, { KIT_GITHUB_CLIENT_ID: "Iv1.test" });
    expect((await json(await request("/api/kit/status"))).githubPartial).toBe(true);
  });

  it("répond même sans base D1", async () => {
    const { request } = makeApp({}, { DB: undefined as unknown as D1Database });
    const res = await request("/api/kit/status");
    expect(res.status).toBe(200);
    expect((await json(res)).database).toBe("missing-binding");
  });
});
