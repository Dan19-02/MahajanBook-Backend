import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, isAiConfigured, isJwtSecretInsecure, isWhatsAppConfigured } from './config.js';
import { initDb } from './db.js';
import authRouter from './routes/auth.js';
import aiRouter from './routes/reminders.js';
import dataRouter from './routes/data.js';
import { authenticate } from './middleware/auth.js';
import { startScheduler } from './scheduler.js';

const app = express();
app.disable('x-powered-by');
// Trust the configured proxy so rate-limiting and req.ip see the real client IP.
app.set('trust proxy', config.trustProxy);

app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' })); // allows a small base64 shop logo

// Public
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: isAiConfigured(),
    whatsappConfigured: isWhatsAppConfigured(),
    model: config.nvidia.model,
  });
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
app.use('/api/auth', authLimiter, authRouter);

// AI drafting: authenticated + rate-limited (it is a paid endpoint).
const aiLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});
app.use('/api/ai', authenticate, aiLimiter, aiRouter);

// All business data: authenticated.
app.use('/api', authenticate, dataRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

/** Connect to Postgres (ensuring the schema) before accepting traffic. */
async function start(): Promise<void> {
  await initDb();
  app.listen(config.port, () => {
    console.log(`Ledgix backend listening on http://localhost:${config.port}`);
    if (!isAiConfigured()) {
      console.warn('⚠  NVIDIA_API_KEY is not set — /api/ai/draft will return 503 until it is configured.');
    }
    if (isJwtSecretInsecure()) {
      console.warn('⚠  JWT_SECRET is the insecure default — set JWT_SECRET in .env before production.');
    }
    startScheduler();
  });
}

start().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
