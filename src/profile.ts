/**
 * Profil propre à l'app, lié 1:1 à kit_user.
 *
 * Le socle ne connaît pas les colonnes : l'app crée sa table (clé primaire `user_id`)
 * dans ses propres migrations. Le kit fournit seulement la lecture/création à la demande
 * et la mise à jour, pour que les attributs de l'app n'aient jamais à toucher kit_user.
 *
 *   CREATE TABLE profile (
 *     user_id TEXT PRIMARY KEY REFERENCES kit_user (id) ON DELETE CASCADE,
 *     display_name TEXT
 *   );
 */
import type { Context } from "hono";

interface UserLike {
  id: string;
  name: string;
  email: string;
}

export interface ProfileOptions<P> {
  /** Table de l'app (jamais préfixée kit_), clé primaire `user_id`. */
  table: string;
  /** Valeurs initiales quand le profil est créé (première lecture). */
  defaults?: (user: UserLike) => Partial<P>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface ProfileStore<E, P> {
  /** Profil de l'utilisateur connecté, créé avec `defaults` s'il n'existe pas encore. */
  get(c: Context<any>): Promise<P & { user_id: string }>;
  /** Met à jour des colonnes du profil et renvoie le profil complet. */
  update(c: Context<any>, patch: Partial<P>): Promise<P & { user_id: string }>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkIdent(name: string, what: string) {
  if (!IDENT.test(name)) throw new Error(`vibe-kit profil : ${what} invalide « ${name} »`);
}

export function createProfileStore<E extends { DB: D1Database }, P>(
  options: ProfileOptions<P> | undefined,
): ProfileStore<E, P> {
  const table = options?.table;
  if (table) {
    checkIdent(table, "nom de table");
    if (table.toLowerCase().startsWith("kit_")) {
      throw new Error("vibe-kit profil : le préfixe kit_ est réservé au socle, choisir un autre nom de table");
    }
  }

  const requireSetup = (c: { get(key: "user"): UserLike | null }) => {
    if (!table) throw new Error("vibe-kit : option `profile` absente de createKit()");
    const user = c.get("user");
    if (!user) throw new Error("vibe-kit : profil demandé sans utilisateur connecté");
    return { table, user };
  };

  const select = (db: D1Database, t: string, userId: string) =>
    db.prepare(`SELECT * FROM "${t}" WHERE user_id = ?`).bind(userId).first<P & { user_id: string }>();

  async function get(c: Context<any>) {
    const { table: t, user } = requireSetup(c);
    const db: D1Database = c.env.DB;
    const existing = await select(db, t, user.id);
    if (existing) return existing;

    const values: Record<string, unknown> = { ...(options?.defaults?.(user) ?? {}), user_id: user.id };
    const cols = Object.keys(values);
    cols.forEach((col) => checkIdent(col, "colonne"));
    await db
      .prepare(
        `INSERT INTO "${t}" (${cols.map((col) => `"${col}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (user_id) DO NOTHING`,
      )
      .bind(...cols.map((col) => values[col] ?? null))
      .run();
    return (await select(db, t, user.id))!;
  }

  async function update(c: Context<any>, patch: Partial<P>) {
    const { table: t, user } = requireSetup(c);
    await get(c); // garantit l'existence de la ligne
    const entries = Object.entries(patch as Record<string, unknown>).filter(
      ([col, value]) => col !== "user_id" && value !== undefined,
    );
    if (entries.length === 0) return get(c);
    entries.forEach(([col]) => checkIdent(col, "colonne"));
    const row = await (c.env.DB as D1Database)
      .prepare(`UPDATE "${t}" SET ${entries.map(([col]) => `"${col}" = ?`).join(", ")} WHERE user_id = ? RETURNING *`)
      .bind(...entries.map(([, value]) => value ?? null), user.id)
      .first<P & { user_id: string }>();
    return row!;
  }

  return { get, update } as ProfileStore<E, P>;
}
