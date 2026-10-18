/**
 * Règles de protection des chemins.
 *
 * Motifs : "/a-propos" (page exacte, avec ou sans .html / slash final) ou "/docs/*" (dossier entier).
 * Ordre : `private` > `public` > `default`.
 */
export interface ProtectOptions {
  /** Comportement des chemins non listés. Défaut "public". */
  default?: "public" | "private";
  /** Chemins accessibles sans connexion. */
  public?: string[];
  /** Chemins réservés aux utilisateurs connectés (prioritaires sur `public`). */
  private?: string[];
}

/** Toujours publics : le kit lui-même et les fichiers que les navigateurs demandent d'office. */
const ALWAYS_PUBLIC = ["/kit/*", "/api/kit/*", "/favicon.ico", "/robots.txt"];

function normalize(path: string): string {
  let p = path.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

function toMatcher(pattern: string): (path: string) => boolean {
  if (pattern.endsWith("/*")) {
    const base = normalize(pattern.slice(0, -2));
    return (path) => path === base || path.startsWith(base === "/" ? "/" : `${base}/`);
  }
  const exact = normalize(pattern);
  return (path) => path === exact;
}

export function compileRules(options: ProtectOptions | undefined, loginPath: string) {
  const always = [...ALWAYS_PUBLIC, loginPath].map(toMatcher);
  const priv = (options?.private ?? []).map(toMatcher);
  const pub = (options?.public ?? []).map(toMatcher);
  const defaultPrivate = options?.default === "private";

  return (rawPath: string): boolean => {
    const path = normalize(decodeURIComponent(rawPath));
    if (always.some((m) => m(path))) return false;
    if (priv.some((m) => m(path))) return true;
    if (pub.some((m) => m(path))) return false;
    return defaultPrivate;
  };
}
