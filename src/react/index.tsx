/**
 * vibe-kit/react — interface du socle, entièrement surchargeable.
 *
 * Trois niveaux de personnalisation :
 *  1. Thème : importer "vibe-kit/react/styles.css" et redéfinir les variables CSS --kit-*.
 *  2. Composants : <KitProvider components={{ LoginPage: MaPage, Loading: MonSpinner, Forbidden, Admin }}>.
 *  3. Sans interface : hooks useKit(), useLoginForm(), useKitAdmin() pour tout refaire soi-même.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------- types

export interface KitUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KitProviders {
  google: boolean;
  magicLink: boolean;
}

export interface KitState {
  user: KitUser | null;
  isAdmin: boolean;
  appName: string;
  providers: KitProviders;
  loading: boolean;
  /** Recharge l'utilisateur courant. */
  refresh(): Promise<void>;
  /** Redirige vers Google ; revient sur `callbackURL` (défaut : page actuelle). */
  signInWithGoogle(callbackURL?: string): Promise<void>;
  /** Envoie un lien de connexion par email (si activé côté serveur). */
  sendMagicLink(email: string, callbackURL?: string): Promise<void>;
  /** Déconnecte puis recharge l'état. */
  signOut(): Promise<void>;
}

export interface KitComponents {
  /** Affiché par <Protected> quand personne n'est connecté. */
  LoginPage: ComponentType;
  /** Affiché pendant le chargement de la session. */
  Loading: ComponentType;
  /** Affiché par <Protected admin> à un utilisateur non admin. */
  Forbidden: ComponentType;
  /** Back-office du socle (rendu par <KitAdmin />). */
  Admin: ComponentType<KitAdminProps>;
}

// ---------------------------------------------------------------- API

export class KitApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Appelle une route /api de l'app (cookies de session inclus).
 *   await api("/api/notes")                              // GET
 *   await api("/api/notes", { body: { text: "…" } })     // POST JSON
 *   await api("/api/notes/3", { method: "DELETE" })
 */
export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    credentials: "same-origin",
    headers: options.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  };
  const res = await fetch(path, init);
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    let message = (data && (data.error || data.message)) || `Erreur ${res.status}`;
    if (typeof message === "object") message = message.message ?? JSON.stringify(message);
    throw new KitApiError(String(message), res.status);
  }
  return data as T;
}

// ---------------------------------------------------------------- contexte

const KitContext = createContext<(KitState & { components: KitComponents }) | null>(null);

function currentPath() {
  return window.location.pathname + window.location.search;
}

/** Enveloppe l'app : charge la session et fournit les composants du kit. */
export function KitProvider({
  children,
  components,
}: {
  children: ReactNode;
  components?: Partial<KitComponents>;
}) {
  const [data, setData] = useState<{
    user: KitUser | null;
    isAdmin: boolean;
    appName: string;
    providers: KitProviders;
  }>({ user: null, isAdmin: false, appName: "", providers: { google: false, magicLink: false } });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<typeof data>("/api/kit/me");
      setData(me);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch((err) => console.error("[kit]", err));
  }, [refresh]);

  const value = useMemo(
    () => ({
      ...data,
      loading,
      refresh,
      async signInWithGoogle(callbackURL?: string) {
        const target = callbackURL ?? currentPath();
        const res = await api<{ url?: string }>("/api/kit/auth/sign-in/social", {
          body: { provider: "google", callbackURL: target, errorCallbackURL: withParam(target, "kit_error", "1") },
        });
        if (res?.url) window.location.href = res.url;
      },
      async sendMagicLink(email: string, callbackURL?: string) {
        const target = callbackURL ?? currentPath();
        await api("/api/kit/auth/sign-in/magic-link", {
          body: { email, callbackURL: target, errorCallbackURL: withParam(target, "kit_error", "1") },
        });
      },
      async signOut() {
        await api("/api/kit/auth/sign-out", { body: {} });
        await refresh();
      },
      components: { ...defaultComponents, ...components },
    }),
    [data, loading, refresh, components],
  );

  return <KitContext.Provider value={value}>{children}</KitContext.Provider>;
}

function withParam(path: string, key: string, value: string) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set(key, value);
  return url.pathname + url.search;
}

/** État de session et actions de connexion. */
export function useKit(): KitState {
  const ctx = useContext(KitContext);
  if (!ctx) throw new Error("useKit() doit être utilisé sous <KitProvider>");
  return ctx;
}

function useKitComponents(): KitComponents {
  const ctx = useContext(KitContext);
  if (!ctx) throw new Error("Composant vibe-kit utilisé hors de <KitProvider>");
  return ctx.components;
}

// ---------------------------------------------------------------- protection

/**
 * Affiche `children` seulement si quelqu'un est connecté (et admin si `admin`).
 * Sinon affiche la page de connexion (ou `fallback`).
 */
export function Protected({
  children,
  admin = false,
  fallback,
}: {
  children: ReactNode;
  admin?: boolean;
  fallback?: ReactNode;
}) {
  const { user, isAdmin, loading } = useKit();
  const { LoginPage, Loading, Forbidden } = useKitComponents();
  if (loading) return <Loading />;
  if (!user) return <>{fallback ?? <LoginPage />}</>;
  if (admin && !isAdmin) return <Forbidden />;
  return <>{children}</>;
}

// ---------------------------------------------------------------- connexion (hook sans interface)

export interface LoginForm {
  providers: KitProviders;
  email: string;
  setEmail(value: string): void;
  status: "idle" | "sending" | "sent" | "error";
  /** Message d'erreur (accès refusé, envoi impossible…). */
  error: string | null;
  signInWithGoogle(): void;
  submitEmail(event?: FormEvent): void;
}

const ACCESS_DENIED =
  "Accès refusé : ce compte n'est pas autorisé. Demandez une invitation à l'administrateur de l'application.";

/** Toute la logique d'un écran de connexion, pour construire sa propre interface. */
export function useLoginForm(options: { callbackURL?: string } = {}): LoginForm {
  const kit = useKit();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<LoginForm["status"]>("idle");
  const [error, setError] = useState<string | null>(null);

  // Retour d'un échec de connexion (compte non autorisé, lien expiré…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("kit_error") || params.has("error")) {
      setError(ACCESS_DENIED);
      setStatus("error");
      params.delete("kit_error");
      params.delete("error");
      const query = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
    }
  }, []);

  const callbackURL = options.callbackURL;
  return {
    providers: kit.providers,
    email,
    setEmail,
    status,
    error,
    signInWithGoogle() {
      setError(null);
      kit.signInWithGoogle(callbackURL).catch((err: Error) => {
        setError(err.message);
        setStatus("error");
      });
    },
    submitEmail(event) {
      event?.preventDefault();
      setStatus("sending");
      setError(null);
      kit
        .sendMagicLink(email, callbackURL)
        .then(() => setStatus("sent"))
        .catch((err: Error) => {
          setError(err.message);
          setStatus("error");
        });
    },
  };
}

// ---------------------------------------------------------------- composants par défaut

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** Page de connexion par défaut (remplaçable via components.LoginPage). */
export function DefaultLoginPage() {
  const { appName } = useKit();
  const form = useLoginForm();
  const { google, magicLink } = form.providers;
  return (
    <div className="kit-center">
      <div className="kit-card kit-login">
        <h1 className="kit-title">{appName || "Connexion"}</h1>
        <p className="kit-muted">Connectez-vous pour continuer.</p>
        {google && (
          <button type="button" className="kit-btn kit-btn-outline kit-btn-block" onClick={form.signInWithGoogle}>
            <GoogleIcon /> Continuer avec Google
          </button>
        )}
        {google && magicLink && <p className="kit-divider">ou</p>}
        {magicLink && (
          <form className="kit-stack" onSubmit={form.submitEmail}>
            <label className="kit-label" htmlFor="kit-email">
              Recevoir un lien par email
            </label>
            <input
              id="kit-email"
              className="kit-input"
              type="email"
              required
              autoComplete="email"
              placeholder="vous@exemple.fr"
              value={form.email}
              onChange={(e) => form.setEmail(e.target.value)}
            />
            <button className="kit-btn kit-btn-primary" type="submit" disabled={form.status === "sending"}>
              Envoyer le lien
            </button>
          </form>
        )}
        {!google && !magicLink && (
          <p className="kit-error">Aucune méthode de connexion n'est configurée (KIT_GOOGLE_CLIENT_ID manquant).</p>
        )}
        {form.status === "sent" && <p className="kit-success">Lien envoyé ! Vérifiez votre boîte mail.</p>}
        {form.error && (
          <p className="kit-error" role="alert">
            {form.error}
          </p>
        )}
      </div>
    </div>
  );
}

export function DefaultLoading() {
  return (
    <div className="kit-center">
      <p className="kit-muted">Chargement…</p>
    </div>
  );
}

export function DefaultForbidden() {
  const { signOut } = useKit();
  return (
    <div className="kit-center">
      <div className="kit-card">
        <h1 className="kit-title">Accès réservé</h1>
        <p className="kit-muted">Cette page est réservée aux administrateurs.</p>
        <button type="button" className="kit-btn kit-btn-outline" onClick={() => signOut()}>
          Changer de compte
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- back-office

export interface AccessSettings {
  mode: "open" | "restricted";
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

export interface KitAdminState {
  loading: boolean;
  error: string | null;
  settings: AccessSettings | null;
  invitations: Invitation[];
  users: AdminUser[];
  reload(): Promise<void>;
  saveSettings(patch: Partial<AccessSettings>): Promise<void>;
  invite(email: string): Promise<void>;
  revokeInvitation(email: string): Promise<void>;
  deleteUser(id: string): Promise<void>;
}

/** Données et actions du back-office du socle, pour construire sa propre interface. */
export function useKitAdmin(): KitAdminState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AccessSettings | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await run(async () => {
        const [s, i, u] = await Promise.all([
          api<AccessSettings>("/api/kit/admin/settings"),
          api<Invitation[]>("/api/kit/admin/invitations"),
          api<AdminUser[]>("/api/kit/admin/users"),
        ]);
        setSettings(s);
        setInvitations(i);
        setUsers(u);
      });
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  return {
    loading,
    error,
    settings,
    invitations,
    users,
    reload,
    saveSettings: (patch) =>
      run(async () => setSettings(await api<AccessSettings>("/api/kit/admin/settings", { method: "PUT", body: patch }))),
    invite: (email) =>
      run(async () => {
        const inv = await api<Invitation>("/api/kit/admin/invitations", { body: { email } });
        setInvitations((list) => [inv, ...list.filter((x) => x.email !== inv.email)]);
      }),
    revokeInvitation: (email) =>
      run(async () => {
        await api(`/api/kit/admin/invitations/${encodeURIComponent(email)}`, { method: "DELETE" });
        setInvitations((list) => list.filter((x) => x.email !== email));
      }),
    deleteUser: (id) =>
      run(async () => {
        await api(`/api/kit/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
        setUsers((list) => list.filter((x) => x.id !== id));
      }),
  };
}

export interface KitAdminSection {
  id: string;
  label: string;
  render: () => ReactNode;
}

export interface KitAdminProps {
  /** Sections propres à l'app, ajoutées après celles du socle. */
  sections?: KitAdminSection[];
}

/** Back-office : rend components.Admin (par défaut DefaultAdmin). À placer sous <Protected admin>. */
export function KitAdmin(props: KitAdminProps) {
  const { Admin } = useKitComponents();
  return <Admin {...props} />;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("fr-FR");

/** Back-office par défaut : accès, invitations, utilisateurs + sections de l'app. */
export function DefaultAdmin({ sections = [] }: KitAdminProps) {
  const admin = useKitAdmin();
  const [tab, setTab] = useState("access");
  const [inviteEmail, setInviteEmail] = useState("");
  const [domains, setDomains] = useState<string | null>(null);

  const tabs: KitAdminSection[] = [
    { id: "access", label: "Accès", render: () => null },
    { id: "users", label: "Utilisateurs", render: () => null },
    ...sections,
  ];
  const custom = sections.find((s) => s.id === tab);
  const domainsValue = domains ?? admin.settings?.allowedDomains.join(", ") ?? "";

  return (
    <div className="kit-admin">
      <nav className="kit-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`kit-tab${tab === t.id ? " kit-tab-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {admin.error && (
        <p className="kit-error" role="alert">
          {admin.error}
        </p>
      )}
      {admin.loading && !admin.settings && <p className="kit-muted">Chargement…</p>}

      {tab === "access" && admin.settings && (
        <div className="kit-stack-lg">
          <section className="kit-card kit-stack">
            <h2 className="kit-subtitle">Qui peut se connecter ?</h2>
            <label className="kit-radio">
              <input
                type="radio"
                name="kit-mode"
                checked={admin.settings.mode === "restricted"}
                onChange={() => admin.saveSettings({ mode: "restricted" }).catch(() => {})}
              />
              Sur invitation ou domaine autorisé
            </label>
            <label className="kit-radio">
              <input
                type="radio"
                name="kit-mode"
                checked={admin.settings.mode === "open"}
                onChange={() => admin.saveSettings({ mode: "open" }).catch(() => {})}
              />
              Tout le monde
            </label>
          </section>

          <section className="kit-card kit-stack">
            <h2 className="kit-subtitle">Domaines autorisés</h2>
            <p className="kit-muted">Toute adresse de ces domaines peut créer un compte. Séparer par des virgules.</p>
            <form
              className="kit-row"
              onSubmit={(e) => {
                e.preventDefault();
                admin
                  .saveSettings({ allowedDomains: domainsValue.split(/[\s,;]+/).filter(Boolean) })
                  .then(() => setDomains(null))
                  .catch(() => {});
              }}
            >
              <input
                className="kit-input"
                placeholder="famille.fr, entreprise.com"
                value={domainsValue}
                onChange={(e) => setDomains(e.target.value)}
                aria-label="Domaines autorisés"
              />
              <button className="kit-btn kit-btn-primary" type="submit">
                Enregistrer
              </button>
            </form>
          </section>

          <section className="kit-card kit-stack">
            <h2 className="kit-subtitle">Invitations</h2>
            <form
              className="kit-row"
              onSubmit={(e) => {
                e.preventDefault();
                admin
                  .invite(inviteEmail)
                  .then(() => setInviteEmail(""))
                  .catch(() => {});
              }}
            >
              <input
                className="kit-input"
                type="email"
                required
                placeholder="personne@exemple.fr"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                aria-label="Email à inviter"
              />
              <button className="kit-btn kit-btn-primary" type="submit">
                Inviter
              </button>
            </form>
            <p className="kit-muted">La personne invitée se connecte ensuite avec ce compte (Google ou email).</p>
            {admin.invitations.length === 0 ? (
              <p className="kit-muted">Aucune invitation.</p>
            ) : (
              <ul className="kit-list">
                {admin.invitations.map((inv) => (
                  <li key={inv.email} className="kit-list-item">
                    <span>
                      {inv.email}{" "}
                      <span className="kit-badge">{inv.acceptedAt ? "acceptée" : "en attente"}</span>
                    </span>
                    <button
                      type="button"
                      className="kit-btn kit-btn-ghost"
                      onClick={() => admin.revokeInvitation(inv.email).catch(() => {})}
                    >
                      Retirer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === "users" && (
        <section className="kit-card">
          <ul className="kit-list">
            {admin.users.map((u) => (
              <li key={u.id} className="kit-list-item">
                <span className="kit-user">
                  {u.image ? <img className="kit-avatar" src={u.image} alt="" /> : <span className="kit-avatar" />}
                  <span>
                    <strong>{u.name || u.email}</strong>
                    <br />
                    <span className="kit-muted">
                      {u.email} · depuis le {formatDate(u.createdAt)}
                    </span>
                  </span>
                  {u.admin && <span className="kit-badge">admin</span>}
                </span>
                {!u.admin && (
                  <button
                    type="button"
                    className="kit-btn kit-btn-danger"
                    onClick={() => {
                      if (window.confirm(`Supprimer ${u.email} et toutes ses données ?`)) {
                        admin.deleteUser(u.id).catch(() => {});
                      }
                    }}
                  >
                    Supprimer
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {custom && <div>{custom.render()}</div>}
    </div>
  );
}

const defaultComponents: KitComponents = {
  LoginPage: DefaultLoginPage,
  Loading: DefaultLoading,
  Forbidden: DefaultForbidden,
  Admin: DefaultAdmin,
};
