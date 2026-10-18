/**
 * Contrôle d'accès et back-office du socle.
 *
 * - Admins : emails déclarés dans la conf de l'app (option `admins`) + variable KIT_ADMIN_EMAILS.
 * - Mode "restricted" (défaut) : seuls les admins, les emails invités et les domaines autorisés
 *   peuvent créer un compte. Mode "open" : tout le monde.
 * - Réglages en base (kit_settings), invitations en base (kit_invitation).
 */
import { Hono } from "hono";

export type AccessMode = "open" | "restricted";

export interface AccessSettings {
  mode: AccessMode;
  /** Domaines autorisés, ex. ["famille.fr"]. */
  allowedDomains: string[];
}

export interface Invitation {
  email: string;
  invitedBy: string | null;
  createdAt: string;
  acceptedAt: string | null;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
  admin: boolean;
}

const DEFAULT_SETTINGS: AccessSettings = { mode: "restricted", allowedDomains: [] };

const normEmail = (email: string) => email.trim().toLowerCase();
const domainOf = (email: string) => normEmail(email).split("@")[1] ?? "";
const normDomain = (d: string) => d.trim().toLowerCase().replace(/^@/, "");
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isDomain = (s: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s);

export function adminEmails(configured: string[] | undefined, envValue: string | undefined): Set<string> {
  const fromEnv = (envValue ?? "").split(",");
  return new Set([...(configured ?? []), ...fromEnv].map(normEmail).filter(Boolean));
}

export async function readSettings(db: D1Database): Promise<AccessSettings> {
  const row = await db.prepare(`SELECT value FROM kit_settings WHERE key = 'access'`).first<{ value: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<AccessSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(db: D1Database, settings: AccessSettings) {
  await db
    .prepare(
      `INSERT INTO kit_settings (key, value, updatedAt) VALUES ('access', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    )
    .bind(JSON.stringify(settings), new Date().toISOString())
    .run();
}

/** Peut-on créer un compte pour cet email ? (appelé avant la création d'un utilisateur) */
export async function canSignUp(db: D1Database, admins: Set<string>, email: string): Promise<boolean> {
  const e = normEmail(email);
  if (admins.has(e)) return true;
  const settings = await readSettings(db);
  if (settings.mode === "open") return true;
  if (settings.allowedDomains.map(normDomain).includes(domainOf(e))) return true;
  const invite = await db.prepare(`SELECT email FROM kit_invitation WHERE email = ?`).bind(e).first();
  return Boolean(invite);
}

export async function markInvitationAccepted(db: D1Database, email: string) {
  await db
    .prepare(`UPDATE kit_invitation SET acceptedAt = ? WHERE email = ? AND acceptedAt IS NULL`)
    .bind(new Date().toISOString(), normEmail(email))
    .run();
}

type AdminEnv = { Bindings: { DB: D1Database }; Variables: { user: { id: string; email: string } | null } };

/** Routes /api/kit/admin/* (réservées aux admins, vérifié par l'appelant). */
export function adminRoutes(getAdmins: (env: any) => Set<string>) {
  const r = new Hono<AdminEnv>();

  r.get("/settings", async (c) => c.json(await readSettings(c.env.DB)));

  r.put("/settings", async (c) => {
    const body = await c.req.json<Partial<AccessSettings>>().catch(() => ({}) as Partial<AccessSettings>);
    const current = await readSettings(c.env.DB);
    const next: AccessSettings = { ...current };
    if (body.mode !== undefined) {
      if (body.mode !== "open" && body.mode !== "restricted") return c.json({ error: "Mode invalide" }, 400);
      next.mode = body.mode;
    }
    if (body.allowedDomains !== undefined) {
      const domains = [...new Set((body.allowedDomains ?? []).map(normDomain).filter(Boolean))];
      const bad = domains.find((d) => !isDomain(d));
      if (bad) return c.json({ error: `Domaine invalide : ${bad}` }, 400);
      next.allowedDomains = domains;
    }
    await writeSettings(c.env.DB, next);
    return c.json(next);
  });

  r.get("/invitations", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT email, invitedBy, createdAt, acceptedAt FROM kit_invitation ORDER BY createdAt DESC`,
    ).all<Invitation>();
    return c.json(results);
  });

  r.post("/invitations", async (c) => {
    const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
    const email = normEmail(body.email ?? "");
    if (!isEmail(email)) return c.json({ error: "Email invalide" }, 400);
    const user = c.get("user")!;
    await c.env.DB.prepare(
      `INSERT INTO kit_invitation (email, invitedBy, createdAt) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING`,
    )
      .bind(email, user.id, new Date().toISOString())
      .run();
    const row = await c.env.DB.prepare(
      `SELECT email, invitedBy, createdAt, acceptedAt FROM kit_invitation WHERE email = ?`,
    )
      .bind(email)
      .first<Invitation>();
    return c.json(row, 201);
  });

  r.delete("/invitations/:email", async (c) => {
    await c.env.DB.prepare(`DELETE FROM kit_invitation WHERE email = ?`)
      .bind(normEmail(decodeURIComponent(c.req.param("email"))))
      .run();
    return c.body(null, 204);
  });

  r.get("/users", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, email, image, createdAt FROM kit_user ORDER BY createdAt DESC`,
    ).all<Omit<AdminUser, "admin">>();
    const admins = getAdmins(c.env);
    return c.json(results.map((u) => ({ ...u, admin: admins.has(normEmail(u.email)) })));
  });

  r.delete("/users/:id", async (c) => {
    const id = c.req.param("id");
    if (id === c.get("user")!.id) return c.json({ error: "Impossible de supprimer son propre compte" }, 400);
    const target = await c.env.DB.prepare(`SELECT email FROM kit_user WHERE id = ?`).bind(id).first<{ email: string }>();
    if (!target) return c.json({ error: "Utilisateur introuvable" }, 404);
    if (getAdmins(c.env).has(normEmail(target.email))) return c.json({ error: "Un admin se retire dans la configuration de l'app" }, 400);
    // Supprime aussi ses sessions, comptes et, par cascade, les données de l'app liées à kit_user.
    await c.env.DB.prepare(`DELETE FROM kit_user WHERE id = ?`).bind(id).run();
    await c.env.DB.prepare(`DELETE FROM kit_invitation WHERE email = ?`).bind(normEmail(target.email)).run();
    return c.body(null, 204);
  });

  return r;
}
