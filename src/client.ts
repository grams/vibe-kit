/**
 * Client navigateur servi sur /vibe-kit.js.
 * Dans une page : <script src="/vibe-kit.js"></script> puis utiliser `kit`.
 */
export const clientScript = `/* vibe-kit client — généré par la lib, ne pas modifier */
(function () {
  async function request(path, options) {
    options = options || {};
    var init = {
      method: options.method || (options.body !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: {},
    };
    if (options.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    var res = await fetch(path, init);
    var data = null;
    var text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
    if (!res.ok) {
      var message = (data && (data.error || data.message)) || ("Erreur " + res.status);
      if (typeof message === "object") message = message.message || JSON.stringify(message);
      var err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  var kit = {
    /** Utilisateur connecté (null sinon), rempli par kit.me(). */
    user: null,
    /** Méthodes de connexion disponibles : { google, magicLink }. */
    providers: { google: false, magicLink: true },

    /** Charge l'utilisateur courant. Renvoie l'utilisateur ou null. */
    me: async function () {
      var data = await request("/api/kit/me");
      kit.user = data.user;
      kit.providers = data.providers;
      return data.user;
    },

    /** Redirige vers la connexion Google, puis revient sur callbackURL (défaut : page actuelle). */
    signInWithGoogle: async function (callbackURL) {
      var data = await request("/api/auth/sign-in/social", {
        body: { provider: "google", callbackURL: callbackURL || location.pathname },
      });
      if (data && data.url) location.href = data.url;
    },

    /** Envoie un lien de connexion par email. */
    sendMagicLink: function (email, callbackURL) {
      return request("/api/auth/sign-in/magic-link", {
        body: { email: email, callbackURL: callbackURL || location.pathname },
      });
    },

    /** Déconnecte puis recharge la page. */
    signOut: async function () {
      await request("/api/auth/sign-out", { body: {} });
      kit.user = null;
      location.reload();
    },

    /**
     * Appelle une route de l'app.
     *   await kit.api("/api/notes")                                  // GET
     *   await kit.api("/api/notes", { body: { text: "..." } })       // POST
     *   await kit.api("/api/notes/3", { method: "DELETE" })
     * Lève une Error (avec .status) si la réponse n'est pas OK.
     */
    api: request,
  };

  window.kit = kit;
})();
`;
