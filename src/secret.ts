/**
 * Secret de signature des sessions.
 *
 * Priorité au secret KIT_AUTH_SECRET s'il est défini. Sinon, le kit en génère un au premier
 * démarrage et le garde dans kit_settings : aucune étape manuelle, et la production comme les
 * aperçus (même base D1) partagent le même secret, ce qu'exige le relais OAuth.
 */
const KEY = "auth_secret";
let cached: string | null = null;

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function resolveAuthSecret(db: D1Database, fromEnv: string | undefined): Promise<{ secret: string; source: "env" | "auto" }> {
  if (fromEnv) return { secret: fromEnv, source: "env" };
  if (cached) return { secret: cached, source: "auto" };
  // Création concurrente possible au tout premier démarrage : la première insertion gagne, tout le monde relit.
  await db
    .prepare(`INSERT INTO kit_settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING`)
    .bind(KEY, JSON.stringify(randomSecret()), new Date().toISOString())
    .run();
  const row = await db.prepare(`SELECT value FROM kit_settings WHERE key = ?`).bind(KEY).first<{ value: string }>();
  if (!row) throw new Error("vibe-kit : impossible de lire le secret de session");
  cached = JSON.parse(row.value) as string;
  return { secret: cached, source: "auto" };
}

/** Pour les tests uniquement. */
export function resetSecretCache() {
  cached = null;
}
