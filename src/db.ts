import Database from 'better-sqlite3';
import { config } from './config.js';

/**
 * Shared SQLite database. The app is multi-tenant: every row in the business
 * tables carries a `businessId`, and the API only ever reads/writes rows for the
 * authenticated user's business. Swap this module for Postgres later without
 * touching the route/business layers.
 *
 * Column names are camelCase to map 1:1 onto the domain types in ./types.ts.
 */
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    joinCode  TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    businessId   TEXT NOT NULL,
    name         TEXT NOT NULL,
    email        TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'STAFF',
    createdAt    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id                TEXT PRIMARY KEY,
    businessId        TEXT NOT NULL,
    sku               TEXT NOT NULL,
    name              TEXT NOT NULL,
    category          TEXT NOT NULL,
    unitType          TEXT NOT NULL,
    costPrice         REAL NOT NULL,
    retailPrice       REAL NOT NULL,
    wholesalePrice    REAL NOT NULL,
    currentStock      INTEGER NOT NULL,
    lowStockThreshold INTEGER NOT NULL,
    createdAt         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customers (
    id           TEXT PRIMARY KEY,
    businessId   TEXT NOT NULL,
    name         TEXT NOT NULL,
    mobile       TEXT NOT NULL,
    businessName TEXT,
    gstIn        TEXT,
    customerType TEXT NOT NULL,
    balance      REAL NOT NULL DEFAULT 0,
    createdAt    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id             TEXT PRIMARY KEY,
    businessId     TEXT NOT NULL,
    invoiceNumber  TEXT NOT NULL,
    customerId     TEXT NOT NULL,
    customerName   TEXT NOT NULL,
    customerMobile TEXT NOT NULL,
    subtotal       REAL NOT NULL,
    discount       REAL NOT NULL,
    tax            REAL NOT NULL,
    grandTotal     REAL NOT NULL,
    paymentStatus  TEXT NOT NULL,
    ptpDate        TEXT,
    createdAt      TEXT NOT NULL,
    items          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            TEXT PRIMARY KEY,
    businessId    TEXT NOT NULL,
    customerId    TEXT NOT NULL,
    customerName  TEXT NOT NULL,
    invoiceId     TEXT,
    invoiceNumber TEXT,
    amount        REAL NOT NULL,
    type          TEXT NOT NULL,
    description   TEXT NOT NULL,
    createdAt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id                  TEXT PRIMARY KEY,
    businessId          TEXT NOT NULL,
    invoiceId           TEXT NOT NULL,
    customerId          TEXT NOT NULL,
    customerName        TEXT NOT NULL,
    customerMobile      TEXT NOT NULL,
    invoiceAmount       REAL NOT NULL,
    ptpDate             TEXT NOT NULL,
    triggerType         TEXT NOT NULL,
    scheduledFor        TEXT NOT NULL,
    status              TEXT NOT NULL,
    razorpayPaymentLink TEXT NOT NULL,
    sentAt              TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_products_biz     ON products(businessId);
  CREATE INDEX IF NOT EXISTS idx_customers_biz    ON customers(businessId);
  CREATE INDEX IF NOT EXISTS idx_invoices_biz     ON invoices(businessId);
  CREATE INDEX IF NOT EXISTS idx_transactions_biz ON transactions(businessId);
  CREATE INDEX IF NOT EXISTS idx_reminders_biz    ON reminders(businessId);
  CREATE INDEX IF NOT EXISTS idx_reminders_due    ON reminders(status, scheduledFor);
`);

/** Adds a column to an existing table if it isn't already present (safe migration). */
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Shop-profile fields (added to existing databases without data loss).
ensureColumn('businesses', 'address', 'TEXT');
ensureColumn('businesses', 'gstIn', 'TEXT');
ensureColumn('businesses', 'phone', 'TEXT');
ensureColumn('businesses', 'logo', 'TEXT');
ensureColumn('businesses', 'upiVpa', 'TEXT');
ensureColumn('products', 'barcode', 'TEXT');
