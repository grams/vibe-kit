import { describe, expect, it } from "vitest";
import { compileRules } from "../src/protect";

describe("compileRules", () => {
  it("laisse tout public par défaut", () => {
    const isProtected = compileRules(undefined);
    expect(isProtected("/api/notes")).toBe(false);
  });

  it("protège toutes les routes /api en mode privé", () => {
    const isProtected = compileRules({ default: "private" });
    expect(isProtected("/api/notes")).toBe(true);
    expect(isProtected("/api/notes/3")).toBe(true);
  });

  it("ne s'applique jamais hors de /api (pages servies par l'interface)", () => {
    const isProtected = compileRules({ default: "private" });
    expect(isProtected("/")).toBe(false);
    expect(isProtected("/app")).toBe(false);
    expect(isProtected("/apiculture")).toBe(false);
  });

  it("laisse toujours publiques les routes du kit", () => {
    const isProtected = compileRules({ default: "private", private: ["/api/kit/*"] });
    expect(isProtected("/api/kit/me")).toBe(false);
    expect(isProtected("/api/kit/auth/sign-in/social")).toBe(false);
  });

  it("applique les exceptions publiques", () => {
    const isProtected = compileRules({ default: "private", public: ["/api/public/*", "/api/stats"] });
    expect(isProtected("/api/public")).toBe(false);
    expect(isProtected("/api/public/hello")).toBe(false);
    expect(isProtected("/api/stats")).toBe(false);
    expect(isProtected("/api/stats/")).toBe(false);
    expect(isProtected("/api/stats/detail")).toBe(true);
    expect(isProtected("/api/publicite")).toBe(true);
  });

  it("donne la priorité à private sur public", () => {
    const isProtected = compileRules({ public: ["/api/docs/*"], private: ["/api/docs/brouillons/*"] });
    expect(isProtected("/api/docs/guide")).toBe(false);
    expect(isProtected("/api/docs/brouillons/1")).toBe(true);
    expect(isProtected("/api/autre")).toBe(false);
  });
});
