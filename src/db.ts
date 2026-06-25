import pgPkg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { config } from './config.js';

const { Pool: PgPool } = pgPkg;

/**
 * Shared PostgreSQL connection pool. The app is multi-tenant: every row in the
 * business tables carries a `businessId`, and the API only ever reads/writes
 * rows for the authenticated user's business.
 *
 * NOTE: column names are camelCase to map 1:1 onto the domain types in
 * ./types.ts. Postgres folds unquoted identifiers to lowercase, so every
 * camelCase column is double-quoted in the schema and in every query.
 */
function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const flag = config.databaseSsl;
  if (flag === 'false' || flag === 'disable' || flag === 'off') return false;
  if (flag === 'true' || flag === 'require' || flag === 'on') return { rejectUnauthorized: false };
  // Auto: local Postgres has no SSL; hosted providers (Render/Supabase/Neon) require it.
  const url = config.databaseUrl;
  const isLocal = url.includes('@localhost') || url.includes('@127.0.0.1') || url.includes('@::1');
  return isLocal ? false : { rejectUnauthorized: false };
}

/**
 * Removes ssl-related query params (`sslmode`, `ssl`) from the connection string.
 * Hosted Postgres URLs (Neon/Supabase/Render external) often carry
 * `?sslmode=require`, which pg ≥8.22 treats as `verify-full`. That enforces full
 * certificate verification and overrides the `ssl` option below, so the
 * provider's private-CA / self-signed chain is rejected
 * (SELF_SIGNED_CERT_IN_CHAIN). We drive TLS via `resolveSsl()` instead, so these
 * params are stripped to avoid the conflict. Only the query string is touched.
 */
function cleanConnectionString(raw: string): string {
  if (!raw.includes('?')) return raw;
  const [base, query] = raw.split('?');
  const kept = query
    .split('&')
    .filter((kv) => {
      const key = kv.split('=')[0].toLowerCase();
      return key !== 'sslmode' && key !== 'ssl';
    });
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

export const pool: Pool = new PgPool({
  connectionString: cleanConnectionString(config.databaseUrl),
  ssl: resolveSsl(),
});

/** Either the shared pool or a transaction-bound client — both expose `.query`. */
export type Executor = Pool | PoolClient;

/**
 * Runs `fn` inside a single transaction. All queries issued on the passed
 * `client` share the transaction; it commits on success and rolls back on throw.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure — surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
  -- An account is the billing entity (the owner's organisation). It holds the
  -- subscription plan and owns one or more stores (the "businesses" table).
  CREATE TABLE IF NOT EXISTS accounts (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    "joinCode"               TEXT NOT NULL UNIQUE,
    plan                     TEXT NOT NULL DEFAULT 'STARTER',
    "razorpaySubscriptionId" TEXT,
    "subscriptionStatus"     TEXT,
    "currentPeriodEnd"       TEXT,
    "createdAt"              TEXT NOT NULL
  );

  -- A "business" row is a STORE belonging to an account.
  CREATE TABLE IF NOT EXISTS businesses (
    id          TEXT PRIMARY KEY,
    "accountId" TEXT,
    name        TEXT NOT NULL,
    "joinCode"  TEXT NOT NULL UNIQUE,
    address     TEXT,
    "gstIn"     TEXT,
    phone       TEXT,
    logo        TEXT,
    "upiVpa"    TEXT,
    "gstRate"   DOUBLE PRECISION NOT NULL DEFAULT 18,
    locked      BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    "accountId"    TEXT,
    "businessId"   TEXT NOT NULL,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'STAFF',
    "createdAt"    TEXT NOT NULL
  );

  -- Which stores a STAFF user may access. Owners implicitly access every store
  -- in their account, so they don't need rows here.
  CREATE TABLE IF NOT EXISTS memberships (
    id           TEXT PRIMARY KEY,
    "userId"     TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdAt"  TEXT NOT NULL,
    UNIQUE ("userId", "businessId")
  );

  CREATE TABLE IF NOT EXISTS products (
    id                  TEXT PRIMARY KEY,
    "businessId"        TEXT NOT NULL,
    sku                 TEXT NOT NULL,
    barcode             TEXT,
    name                TEXT NOT NULL,
    category            TEXT NOT NULL,
    "unitType"          TEXT NOT NULL,
    "costPrice"         DOUBLE PRECISION NOT NULL,
    "retailPrice"       DOUBLE PRECISION NOT NULL,
    "wholesalePrice"    DOUBLE PRECISION NOT NULL,
    "currentStock"      INTEGER NOT NULL,
    "lowStockThreshold" INTEGER NOT NULL,
    "createdAt"         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customers (
    id             TEXT PRIMARY KEY,
    "businessId"   TEXT NOT NULL,
    name           TEXT NOT NULL,
    mobile         TEXT NOT NULL,
    "businessName" TEXT,
    "gstIn"        TEXT,
    "customerType" TEXT NOT NULL,
    balance        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt"    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id               TEXT PRIMARY KEY,
    "businessId"     TEXT NOT NULL,
    "invoiceNumber"  TEXT NOT NULL,
    "customerId"     TEXT NOT NULL,
    "customerName"   TEXT NOT NULL,
    "customerMobile" TEXT NOT NULL,
    subtotal         DOUBLE PRECISION NOT NULL,
    discount         DOUBLE PRECISION NOT NULL,
    tax              DOUBLE PRECISION NOT NULL,
    "grandTotal"     DOUBLE PRECISION NOT NULL,
    "taxRate"        DOUBLE PRECISION NOT NULL DEFAULT 18,
    "paymentStatus"  TEXT NOT NULL,
    "ptpDate"        TEXT,
    "createdAt"      TEXT NOT NULL,
    items            TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id              TEXT PRIMARY KEY,
    "businessId"    TEXT NOT NULL,
    "customerId"    TEXT NOT NULL,
    "customerName"  TEXT NOT NULL,
    "invoiceId"     TEXT,
    "invoiceNumber" TEXT,
    amount          DOUBLE PRECISION NOT NULL,
    type            TEXT NOT NULL,
    description     TEXT NOT NULL,
    "createdAt"     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id                    TEXT PRIMARY KEY,
    "businessId"          TEXT NOT NULL,
    "invoiceId"           TEXT NOT NULL,
    "customerId"          TEXT NOT NULL,
    "customerName"        TEXT NOT NULL,
    "customerMobile"      TEXT NOT NULL,
    "invoiceAmount"       DOUBLE PRECISION NOT NULL,
    "ptpDate"             TEXT NOT NULL,
    "triggerType"         TEXT NOT NULL,
    "scheduledFor"        TEXT NOT NULL,
    status                TEXT NOT NULL,
    "razorpayPaymentLink" TEXT NOT NULL,
    "sentAt"              TEXT
  );

  -- Column migrations for databases created before these columns existed
  -- (idempotent). MUST run before the indexes below, which reference them.
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS "gstRate"   DOUBLE PRECISION NOT NULL DEFAULT 18;
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS "accountId" TEXT;
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS locked      BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE invoices   ADD COLUMN IF NOT EXISTS "taxRate"   DOUBLE PRECISION NOT NULL DEFAULT 18;
  ALTER TABLE users      ADD COLUMN IF NOT EXISTS "accountId" TEXT;

  CREATE INDEX IF NOT EXISTS idx_products_biz     ON products("businessId");
  CREATE INDEX IF NOT EXISTS idx_customers_biz    ON customers("businessId");
  CREATE INDEX IF NOT EXISTS idx_invoices_biz     ON invoices("businessId");
  CREATE INDEX IF NOT EXISTS idx_transactions_biz ON transactions("businessId");
  CREATE INDEX IF NOT EXISTS idx_reminders_biz    ON reminders("businessId");
  CREATE INDEX IF NOT EXISTS idx_reminders_due    ON reminders(status, "scheduledFor");
  CREATE INDEX IF NOT EXISTS idx_businesses_acct  ON businesses("accountId");
  CREATE INDEX IF NOT EXISTS idx_users_acct       ON users("accountId");
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships("userId");
  CREATE INDEX IF NOT EXISTS idx_memberships_biz  ON memberships("businessId");
`;

const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * One-time backfill for the single-store → multi-store migration. Every legacy
 * `business` (which had no accountId) becomes its own account: the store is
 * linked to a fresh account, that account inherits the store's joinCode, the
 * store's users are attached to the account, and STAFF users get a membership to
 * the store (owners get implicit all-store access). Idempotent: only touches
 * businesses whose accountId is still NULL.
 */
async function backfillAccounts(): Promise<void> {
  await withTransaction(async (client) => {
    const { rows: legacy } = await client.query<{ id: string; name: string; joinCode: string; createdAt: string }>(
      'SELECT id, name, "joinCode", "createdAt" FROM businesses WHERE "accountId" IS NULL',
    );
    for (const biz of legacy) {
      const accountId = genId('acc');
      await client.query(
        'INSERT INTO accounts (id, name, "joinCode", plan, "createdAt") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("joinCode") DO NOTHING',
        [accountId, biz.name, biz.joinCode, 'STARTER', biz.createdAt],
      );
      // If the joinCode collided (shouldn't, codes are unique per business), look it up.
      const { rows: acctRows } = await client.query<{ id: string }>(
        'SELECT id FROM accounts WHERE "joinCode" = $1',
        [biz.joinCode],
      );
      const acctId = acctRows[0]?.id ?? accountId;
      await client.query('UPDATE businesses SET "accountId" = $1 WHERE id = $2', [acctId, biz.id]);
      await client.query('UPDATE users SET "accountId" = $1 WHERE "businessId" = $2 AND "accountId" IS NULL', [acctId, biz.id]);
      // STAFF of this store need an explicit membership; owners are implicit.
      const { rows: staff } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE "businessId" = $1 AND role = 'STAFF'`,
        [biz.id],
      );
      for (const u of staff) {
        await client.query(
          'INSERT INTO memberships (id, "userId", "businessId", "createdAt") VALUES ($1, $2, $3, $4) ON CONFLICT ("userId", "businessId") DO NOTHING',
          [genId('mem'), u.id, biz.id, biz.createdAt],
        );
      }
    }
  });
}

/** Connects and ensures the schema exists. Call once before the server listens. */
export async function initDb(): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Provide a PostgreSQL connection string.');
  }
  await pool.query(SCHEMA);
  await backfillAccounts();
}
