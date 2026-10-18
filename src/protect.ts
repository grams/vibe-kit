/**
 * Protection des routes /api côté serveur.
 * (Les pages d'une app React se protègent côté client avec <Protected> de vibe-kit/react.)
 *
 * Motifs : "/api/stats" (route exacte) ou "/api/public/*" (préfixe).
 * Ordre : `private` > `public` > `default`.
 */
export interface ProtectOptions {
  /** Comportement des routes /api non listées. Défaut "public". "private" est recommandé. */
  default?: "public" | "private";
  /** Routes /api accessibles sans connexion. */
  public?: string[];
  /** Routes /api réservées aux utilisateurs connectés (prioritaires sur `public`). */
  private?: string[];
}

/** Toujours publiques : les routes du kit (auth, /api/kit/me). */
const ALWAYS_PUBLIC = ["/api/kit/*"];

function normalize(path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return p || "/";
}

function toMatcher(pattern: string): (path: string) => boolean {
  if (pattern.endsWith("/*")) {
    const base = normalize(pattern.slice(0, -2));
    return (path) => path === base || path.startsWith(`${base}/`);
  }
  const exact = normalize(pattern);
  return (path) => path === exact;
}

export function compileRules(options: ProtectOptions | undefined) {
  const always = ALWAYS_PUBLIC.map(toMatcher);
  const priv = (options?.private ?? []).map(toMatcher);
  const pub = (options?.public ?? []).map(toMatcher);
  const defaultPrivate = options?.default === "private";

  return (rawPath: string): boolean => {
    if (!rawPath.startsWith("/api/")) return false;
    const path = normalize(rawPath);
    if (always.some((m) => m(path))) return false;
    if (priv.some((m) => m(path))) return true;
    if (pub.some((m) => m(path))) return false;
    return defaultPrivate;
  };
}
