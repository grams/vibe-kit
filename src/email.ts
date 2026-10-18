export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendEmail = (msg: EmailMessage) => Promise<void>;

interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/**
 * Envoie un email via Resend si RESEND_API_KEY est défini.
 * Sinon, affiche le contenu dans les logs (pratique en local avec `wrangler dev`).
 */
export async function sendEmail(env: EmailEnv, msg: EmailMessage): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`\n[vibe-kit] Email non envoyé (pas de RESEND_API_KEY)\nÀ : ${msg.to}\n${msg.text}\n`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "onboarding@resend.dev",
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`Envoi d'email échoué (${res.status}) : ${await res.text()}`);
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function magicLinkEmail(appName: string, to: string, url: string): EmailMessage {
  const name = escape(appName);
  return {
    to,
    subject: `Votre lien de connexion à ${appName}`,
    text: `Pour vous connecter à ${appName}, ouvrez ce lien (valable 15 minutes) :\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px">
<h2 style="margin:0 0 16px">${name}</h2>
<p>Cliquez sur le bouton pour vous connecter. Le lien est valable 15 minutes.</p>
<p><a href="${escape(url)}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Se connecter</a></p>
<p style="color:#666;font-size:13px">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
</div>`,
  };
}
