import 'dotenv/config';

const DEFAULT_JWT_SECRET = 'dev-insecure-secret-change-me';
// Publicly-known placeholders that must never reach production.
const KNOWN_WEAK_SECRETS = new Set([DEFAULT_JWT_SECRET, 'change-me-to-a-long-random-string']);

/**
 * Centralised, validated runtime configuration.
 *
 * The NVIDIA API key is intentionally NOT required at boot — the server still
 * starts (so `/api/health` works) and only the AI endpoint returns 503 when the
 * key is missing. This keeps local dev and health checks friction-free.
 */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Proxy hops to trust so req.ip / rate-limiting see the real client behind a
  // reverse proxy. Set TRUST_PROXY=1 on Render/Heroku/Nginx; unset for direct exposure.
  trustProxy: ((): boolean | number => {
    const v = process.env.TRUST_PROXY?.trim();
    if (!v || v === 'false') return false;
    if (v === 'true') return true;
    const n = Number(v);
    return Number.isFinite(n) ? n : false;
  })(),
  // PostgreSQL connection string, e.g. postgresql://user:pass@host:5432/dbname
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  // SSL override: 'true'/'false' force it; anything else auto-detects from the host.
  databaseSsl: process.env.DATABASE_SSL?.trim().toLowerCase() ?? '',
  jwt: {
    secret: process.env.JWT_SECRET?.trim() || DEFAULT_JWT_SECRET,
    expiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 60 * 60 * 24 * 7),
  },
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY?.trim() ?? '',
    baseUrl: (process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    model: process.env.MINIMAX_MODEL?.trim() || 'minimaxai/minimax-m3',
    timeoutMs: Number(process.env.NVIDIA_TIMEOUT_MS ?? 30_000),
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN?.trim() ?? '',
    phoneId: process.env.WHATSAPP_PHONE_ID?.trim() ?? '',
    apiVersion: process.env.WHATSAPP_API_VERSION?.trim() || 'v21.0',
    schedulerIntervalMs: Number(process.env.WHATSAPP_SCHEDULER_INTERVAL_MS ?? 5 * 60 * 1000),
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID?.trim() ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET?.trim() ?? '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? '',
    // Razorpay Subscription Plan IDs, one per tier (created in the Razorpay dashboard).
    planIds: {
      STARTER: process.env.RAZORPAY_PLAN_STARTER?.trim() ?? '',
      GROWTH: process.env.RAZORPAY_PLAN_GROWTH?.trim() ?? '',
      UNLIMITED: process.env.RAZORPAY_PLAN_UNLIMITED?.trim() ?? '',
    },
  },
  butterbase: {
    // Butterbase app id (e.g. app_xxxx). When set, /api/auth/google verifies a
    // butterbase end-user token against this app and signs the user into MahajanBook.
    appId: process.env.BUTTERBASE_APP_ID?.trim() ?? '',
    apiBase: (process.env.BUTTERBASE_API_BASE ?? 'https://api.butterbase.ai').replace(/\/+$/, ''),
  },
} as const;

/** True when butterbase Google sign-in is wired (a butterbase app id is set). */
export const isButterbaseConfigured = (): boolean => config.butterbase.appId.length > 0;

/** True when Razorpay API credentials are present (enables subscription billing). */
export const isBillingConfigured = (): boolean =>
  Boolean(config.razorpay.keyId && config.razorpay.keySecret);

/** True when an NVIDIA API key is available for MiniMax-M3 calls. */
export const isAiConfigured = (): boolean => config.nvidia.apiKey.length > 0;

/** True when WhatsApp Business API credentials are present (enables auto-send). */
export const isWhatsAppConfigured = (): boolean =>
  Boolean(config.whatsapp.token && config.whatsapp.phoneId);

/** True when the JWT secret is a known placeholder or too short to be safe (warned at boot). */
export const isJwtSecretInsecure = (): boolean =>
  KNOWN_WEAK_SECRETS.has(config.jwt.secret) || config.jwt.secret.length < 32;
