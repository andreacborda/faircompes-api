const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── CLIENTES ──────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── CONFIGURACIÓN ─────────────────────────────────────────
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "no-reply@faircompes.com";
const FROM_NAME  = process.env.RESEND_FROM_NAME  || "FairCompes AI";
const APP_URL    = process.env.APP_URL            || "https://fair-compes-app.surge.sh";
const JWT_SECRET = process.env.JWT_VERIFICATION_SECRET || "fallback-secret-change-in-production";
const TOKEN_TTL  = process.env.VERIFICATION_TOKEN_TTL  || "30m";

// Tokens ya usados (un solo uso). En producción migrar a base de datos.
const consumedTokens = new Set();

// Rate limiting simple: máx 3 reenvíos por correo cada 15 min
const resendBuckets = new Map();
function canResend(email) {
  const now = Date.now();
  const bucket = (resendBuckets.get(email) || []).filter(t => now - t < 15 * 60 * 1000);
  resendBuckets.set(email, bucket);
  if (bucket.length >= 3) return false;
  bucket.push(now);
  return true;
}

// ── PLANTILLA DE CORREO ───────────────────────────────────
function buildVerificationEmail({ name, verificationUrl, lang }) {
  const copy = {
    es: {
      subject: "Verifica tu correo — FairCompes AI",
      greeting: `Hola${name ? `, ${name}` : ""} 👋`,
      intro: "Gracias por crear tu cuenta en FairCompes AI.",
      instruction: "Haz clic en el botón para activar tu cuenta:",
      button: "Verificar mi correo",
      expiry: "Este enlace expira en 30 minutos.",
      ignore: "Si no creaste esta cuenta, ignora este correo.",
    },
    en: {
      subject: "Verify your email — FairCompes AI",
      greeting: `Hello${name ? `, ${name}` : ""} 👋`,
      intro: "Thank you for creating your FairCompes AI account.",
      instruction: "Click the button below to activate your account:",
      button: "Verify my email",
      expiry: "This link expires in 30 minutes.",
      ignore: "If you didn't create this account, you can ignore this email.",
    },
    fr: {
      subject: "Vérifiez votre e-mail — FairCompes AI",
      greeting: `Bonjour${name ? `, ${name}` : ""} 👋`,
      intro: "Merci d'avoir créé votre compte FairCompes AI.",
      instruction: "Cliquez sur le bouton pour activer votre compte :",
      button: "Vérifier mon e-mail",
      expiry: "Ce lien expire dans 30 minutes.",
      ignore: "Si vous n'avez pas créé ce compte, ignorez cet e-mail.",
    },
  };

  const t = copy[lang] || copy.es;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#060910;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060910;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0c1220;border:1px solid #182030;border-radius:16px;overflow:hidden;">
        <tr>
          <td align="center" style="padding:40px 32px 24px;">
            <div style="font-size:32px;margin-bottom:8px;">⚖️</div>
            <div style="font-size:18px;font-weight:800;color:#c9a84c;letter-spacing:0.5px;">FAIR COMPES AI</div>
            <div style="font-size:10px;color:#445577;letter-spacing:1.5px;margin-top:4px;">MONITOR ANTITRUST</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;">
            <p style="color:#e8edf5;font-size:16px;font-weight:700;margin:0 0 12px;">${t.greeting}</p>
            <p style="color:#8899bb;font-size:14px;line-height:1.6;margin:0 0 12px;">${t.intro}</p>
            <p style="color:#8899bb;font-size:14px;line-height:1.6;margin:0 0 24px;">${t.instruction}</p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td style="border-radius:8px;background:#c9a84c;">
                  <a href="${verificationUrl}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:800;color:#000;text-decoration:none;border-radius:8px;">
                    ${t.button} →
                  </a>
                </td>
              </tr>
            </table>
            <p style="color:#445577;font-size:11px;margin:0 0 4px;">⏱ ${t.expiry}</p>
            <p style="color:#445577;font-size:11px;margin:0 0 16px;">${t.ignore}</p>
            <p style="color:#2dd4bf;font-size:11px;word-break:break-all;margin:0;">${verificationUrl}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #182030;" align="center">
            <p style="color:#445577;font-size:11px;margin:0;">FairCompes AI — Antitrust Intelligence Platform</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: t.subject, html };
}

// ── ENDPOINT EXISTENTE: DICTAMEN IA ──────────────────────
app.post("/api/legal-opinion", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content?.map(b => b.text || "").join("") || "";
    res.json({ text });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// ── NUEVO: ENVIAR CORREO DE VERIFICACIÓN ──────────────────
app.post("/api/send-verification-email", async (req, res) => {
  const { email, name, lang } = req.body || {};
  if (!email || !email.includes("@")) {
    return res.status(400).json({ success: false, error: "invalid_email" });
  }

  const language = ["es","en","fr"].includes(lang) ? lang : "es";
  const jti = crypto.randomUUID();
  const token = jwt.sign({ email, type: "email_verification", jti }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  const verificationUrl = `${APP_URL}/?verify=${encodeURIComponent(token)}`;
  const { subject, html } = buildVerificationEmail({ name, verificationUrl, lang: language });

  try {
    const result = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject,
      html,
    });
    if (result.error) {
      console.error("Resend error:", result.error);
      return res.status(502).json({ success: false, error: "email_delivery_failed" });
    }
    console.log("Verification email sent:", email, result.data?.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Email exception:", err.message);
    res.status(502).json({ success: false, error: "email_delivery_failed" });
  }
});

// ── NUEVO: REENVIAR CORREO DE VERIFICACIÓN ────────────────
app.post("/api/resend-verification-email", async (req, res) => {
  const { email, name, lang } = req.body || {};
  if (!email || !email.includes("@")) {
    return res.status(400).json({ success: false, error: "invalid_email" });
  }
  if (!canResend(email)) {
    return res.status(429).json({ success: false, error: "too_many_requests" });
  }

  const language = ["es","en","fr"].includes(lang) ? lang : "es";
  const jti = crypto.randomUUID();
  const token = jwt.sign({ email, type: "email_verification", jti }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  const verificationUrl = `${APP_URL}/?verify=${encodeURIComponent(token)}`;
  const { subject, html } = buildVerificationEmail({ name, verificationUrl, lang: language });

  try {
    const result = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject,
      html,
    });
    if (result.error) {
      return res.status(502).json({ success: false, error: "email_delivery_failed" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ success: false, error: "email_delivery_failed" });
  }
});

// ── NUEVO: VERIFICAR TOKEN DEL ENLACE ─────────────────────
app.get("/api/verify-email", (req, res) => {
  const { token } = req.query || {};
  if (!token) return res.status(400).json({ success: false, error: "missing_token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== "email_verification") {
      return res.status(400).json({ success: false, error: "invalid_token_type" });
    }
    if (consumedTokens.has(payload.jti)) {
      return res.status(400).json({ success: false, error: "token_already_used" });
    }
    consumedTokens.add(payload.jti);
    console.log("Email verified:", payload.email);
    res.json({ success: true, email: payload.email });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(400).json({ success: false, error: "token_expired" });
    }
    res.status(400).json({ success: false, error: "invalid_token" });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Fair Compes API running on port ${PORT}`));
