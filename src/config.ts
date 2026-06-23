import 'dotenv/config';

const DEFAULT_JWT_SECRET = 'dev-insecure-secret-change-me';

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
  dbPath: process.env.DB_PATH?.trim() || './ledgix.db',
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
} as const;

/** True when an NVIDIA API key is available for MiniMax-M3 calls. */
export const isAiConfigured = (): boolean => config.nvidia.apiKey.length > 0;

/** True when WhatsApp Business API credentials are present (enables auto-send). */
export const isWhatsAppConfigured = (): boolean =>
  Boolean(config.whatsapp.token && config.whatsapp.phoneId);

/** True when the JWT secret is still the insecure default (warned at boot). */
export const isJwtSecretInsecure = (): boolean => config.jwt.secret === DEFAULT_JWT_SECRET;
