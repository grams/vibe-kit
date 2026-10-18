import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { ADMIN, makeApp, resetDb } from "./helpers";
import { createProfileStore } from "../src/profile";

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
    expect(me.providers).toEqual({ google: false, magicLink: true });
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

  it("désactive le lien magique sans service d'email", async () => {
    const { request } = makeApp({ sendEmail: undefined });
    const me = await json(await request("/api/kit/me"));
    expect(me.providers.magicLink).toBe(false);
    const res = await request("/api/kit/auth/sign-in/magic-link", { method: "POST", json: { email: ADMIN } });
    expect(res.status).toBe(404);
  });

  it("explique clairement un secret manquant", async () => {
    const { request } = makeApp({}, { KIT_AUTH_SECRET: "" });
    const res = await request("/api/kit/me");
    expect(res.status).toBe(500);
    expect((await json(res)).error).toContain("KIT_AUTH_SECRET");
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
