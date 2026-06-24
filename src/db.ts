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

export const pool: Pool = new PgPool({
  connectionString: config.databaseUrl,
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
  CREATE TABLE IF NOT EXISTS businesses (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    "joinCode"  TEXT NOT NULL UNIQUE,
    address     TEXT,
    "gstIn"     TEXT,
    phone       TEXT,
    logo        TEXT,
    "upiVpa"    TEXT,
    "createdAt" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    "businessId"   TEXT NOT NULL,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'STAFF',
    "createdAt"    TEXT NOT NULL
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

  CREATE INDEX IF NOT EXISTS idx_products_biz     ON products("businessId");
  CREATE INDEX IF NOT EXISTS idx_customers_biz    ON customers("businessId");
  CREATE INDEX IF NOT EXISTS idx_invoices_biz     ON invoices("businessId");
  CREATE INDEX IF NOT EXISTS idx_transactions_biz ON transactions("businessId");
  CREATE INDEX IF NOT EXISTS idx_reminders_biz    ON reminders("businessId");
  CREATE INDEX IF NOT EXISTS idx_reminders_due    ON reminders(status, "scheduledFor");
`;

/** Connects and ensures the schema exists. Call once before the server listens. */
export async function initDb(): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Provide a PostgreSQL connection string.');
  }
  await pool.query(SCHEMA);
}
