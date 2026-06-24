/**
 * One-off data migration: copy every row from the legacy SQLite database into
 * the PostgreSQL database referenced by DATABASE_URL (see .env).
 *
 *   npx tsx scripts/migrate-from-sqlite.ts [path-to-sqlite.db]   # default: ./ledgix.db
 *
 * Re-runnable: every insert is `ON CONFLICT (id) DO NOTHING`, so running it
 * twice will not duplicate rows. Reads SQLite via the `sqlite3` CLI (no native
 * driver needed) and writes through the app's own pg pool so the schema and
 * connection settings stay in one place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pool, initDb } from '../src/db.js';

const SQLITE_DB = process.argv[2] ?? 'ledgix.db';

// No foreign keys exist, so order is cosmetic — parents first reads cleanly.
const TABLES = ['businesses', 'users', 'products', 'customers', 'invoices', 'transactions', 'reminders'] as const;

/** Reads one table out of the SQLite file as an array of row objects. */
function readTable(table: string): Record<string, unknown>[] {
  const out = execFileSync('sqlite3', [SQLITE_DB, '-json', `SELECT * FROM ${table}`], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as Record<string, unknown>[]) : [];
}

async function main(): Promise<void> {
  if (!existsSync(SQLITE_DB)) throw new Error(`SQLite file not found: ${SQLITE_DB}`);

  await initDb(); // create the PostgreSQL schema if it isn't there yet

  let total = 0;
  for (const table of TABLES) {
    const rows = readTable(table);
    for (const row of rows) {
      const cols = Object.keys(row);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const quoted = cols.map((c) => `"${c}"`).join(', ');
      await pool.query(
        `INSERT INTO ${table} (${quoted}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
        cols.map((c) => row[c]),
      );
    }
    console.log(`  ${table.padEnd(13)} ${rows.length} row(s)`);
    total += rows.length;
  }

  console.log(`\nMigrated ${total} row(s) into PostgreSQL.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
