const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

// ── STRIPE WEBHOOK (debe ir ANTES de express.json(), Stripe necesita el body crudo) ──
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId) {
        await pool.query(
          `UPDATE users SET is_premium = true, stripe_subscription_id = $1 WHERE id = $2`,
          [session.subscription, userId]
        );
        console.log('User upgraded to premium:', userId);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      await pool.query(
        `UPDATE users SET is_premium = false WHERE stripe_subscription_id = $1`,
        [subscription.id]
      );
      console.log('Subscription cancelled:', subscription.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

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
app.get("/api/verify-email", async (req, res) => {
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

    await pool.query(
      `UPDATE users SET is_verified = true WHERE email = $1`,
      [payload.email]
    );

    console.log("Email verified:", payload.email);
    res.json({ success: true, email: payload.email });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(400).json({ success: false, error: "token_expired" });
    }
    console.error("Verify email error:", err.message);
    res.status(400).json({ success: false, error: "invalid_token" });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// =====================================================================
// BLOQUE PARA AGREGAR A index.js — Fase 2A.2
// Copia todo este bloque y pégalo en index.js, ANTES de la línea:
//   const PORT = process.env.PORT || 3001;
// =====================================================================

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

// ─── REGISTRO (usa base de datos en vez de localStorage) ───────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName, country, language, company, role } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ success: false, error: 'invalid_email' });
  if (!password || password.length < 6) return res.status(400).json({ success: false, error: 'weak_password' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'email_already_exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const insertUser = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, country, language, company, role_title)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [email, passwordHash, firstName, lastName, country, language || 'es', company || '', role || '']
    );
    const userId = insertUser.rows[0].id;

    await pool.query(
      `INSERT INTO trial_usage (user_id, searches_used, search_limit) VALUES ($1, 0, 7)`,
      [userId]
    );

    await pool.query(
      `INSERT INTO audit_logs (user_id, event_type, metadata) VALUES ($1, 'account_created', $2)`,
      [userId, JSON.stringify({ email })]
    );

    // Reutiliza la lógica existente de envío de correo (misma que ya tienes)
    const language2 = ["es", "en", "fr"].includes(language) ? language : "es";
    const jti = crypto.randomUUID();
    const token = jwt.sign({ email, userId, type: "email_verification", jti }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    const verificationUrl = `${APP_URL}/?verify=${encodeURIComponent(token)}`;
    const { subject, html } = buildVerificationEmail({ name: firstName, verificationUrl, lang: language2 });

    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token_jti, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [userId, jti]
    );

    try {
      const result = await resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: email,
        subject,
        html,
      });
      if (result.error) {
        console.error("Resend error (register):", result.error);
        return res.json({ success: true, emailError: true });
      }
    } catch (err) {
      console.error("Email exception (register):", err.message);
      return res.json({ success: true, emailError: true });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, error: 'missing_fields' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await pool.query(
        `INSERT INTO audit_logs (user_id, event_type) VALUES ($1, 'login_failed')`,
        [user.id]
      );
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    const sessionToken = crypto.randomUUID();
    const tokenHash = require('crypto').createHash('sha256').update(sessionToken).digest('hex');
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
      [user.id, tokenHash]
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, event_type) VALUES ($1, 'login_success')`,
      [user.id]
    );

    res.json({
      success: true,
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        country: user.country,
        language: user.language,
        isVerified: user.is_verified,
        isPremium: user.is_premium,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ─── STRIPE: CREAR SESIÓN DE PAGO ───────────────────────────────────────
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { sessionToken } = req.body || {};
  if (!sessionToken) return res.status(400).json({ success: false, error: 'missing_token' });

  try {
    const tokenHash = require('crypto').createHash('sha256').update(sessionToken).digest('hex');
    const result = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'invalid_session' });
    }
    const user = result.rows[0];

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.first_name} ${user.last_name}`,
      });
      customerId = customer.id;
      await pool.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [customerId, user.id]);
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${APP_URL}/?subscribed=true`,
      cancel_url: `${APP_URL}/?subscribed=cancelled`,
      metadata: { userId: user.id },
    });

    res.json({ success: true, url: checkoutSession.url });
  } catch (err) {
    console.error('Create checkout session error:', err.message);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});
// ─── VALIDAR SESIÓN (para restaurar sesión al abrir la app) ────────────
app.post('/api/auth/session', async (req, res) => {
  const { sessionToken } = req.body || {};
  if (!sessionToken) return res.status(400).json({ success: false, error: 'missing_token' });

  try {
    const tokenHash = require('crypto').createHash('sha256').update(sessionToken).digest('hex');
    const result = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'invalid_session' });
    }
    const user = result.rows[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        country: user.country,
        language: user.language,
        isVerified: user.is_verified,
        isPremium: user.is_premium,
      },
    });
  } catch (err) {
    console.error("Session check error:", err.message);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// ─── TRIAL (backend, no manipulable desde localStorage) ────────────────
app.post('/api/trial/check', async (req, res) => {
  const { anonymousId } = req.body || {};
  if (!anonymousId) return res.status(400).json({ success: false, error: 'missing_id' });

  try {
    let result = await pool.query('SELECT * FROM trial_usage WHERE anonymous_id = $1', [anonymousId]);
    if (result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO trial_usage (anonymous_id, searches_used, search_limit) VALUES ($1, 0, 7) RETURNING *`,
        [anonymousId]
      );
    }
    const row = result.rows[0];
    res.json({ success: true, searchesUsed: row.searches_used, searchLimit: row.search_limit });
  } catch (err) {
    console.error("Trial check error:", err.message);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

app.post('/api/trial/increment', async (req, res) => {
  const { anonymousId } = req.body || {};
  if (!anonymousId) return res.status(400).json({ success: false, error: 'missing_id' });

  try {
    const result = await pool.query(
      `UPDATE trial_usage SET searches_used = searches_used + 1, updated_at = now()
       WHERE anonymous_id = $1 RETURNING *`,
      [anonymousId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'not_found' });
    }
    const row = result.rows[0];
    res.json({ success: true, searchesUsed: row.searches_used, searchLimit: row.search_limit });
  } catch (err) {
    console.error("Trial increment error:", err.message);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// =====================================================================
// FIN DEL BLOQUE A AGREGAR
// =====================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Fair Compes API running on port ${PORT}`));
