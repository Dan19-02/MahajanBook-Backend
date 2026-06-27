import { pool } from './db.js';
import { config, isWhatsAppConfigured } from './config.js';
import { sendWhatsAppMessage } from './services/whatsapp.js';
import { autoReminderMessage } from './services/reminders.js';
import { assertReminderQuota, HttpError } from './store.js';
import type { WhatsAppReminder } from './types.js';

type DueReminder = WhatsAppReminder & {
  businessId: string;
  accountId: string | null;
  businessName: string | null;
  invNumber: string | null;
};

/** Finds due, still-queued reminders across all businesses and auto-sends them. */
async function processDueReminders(): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  const today = new Date().toISOString().split('T')[0];
  // Single JOIN instead of two extra lookups per reminder (no N+1).
  const { rows } = await pool.query(
    `SELECT r.*, b.name AS "businessName", b."accountId" AS "accountId", i."invoiceNumber" AS "invNumber"
       FROM reminders r
       LEFT JOIN businesses b ON b.id = r."businessId"
       LEFT JOIN invoices  i ON i.id = r."invoiceId"
      WHERE r.status = 'QUEUED' AND r."scheduledFor" <= $1`,
    [today],
  );

  for (const rem of rows as DueReminder[]) {
    // Isolate failures so one bad reminder can't abort the whole cycle.
    try {
      // Respect the account's monthly cap — leave over-quota reminders QUEUED.
      if (rem.accountId) {
        try {
          await assertReminderQuota(rem.accountId);
        } catch (err) {
          if (err instanceof HttpError) continue;
          throw err;
        }
      }
      const message = autoReminderMessage(rem, rem.businessName ?? 'MahajanBook', rem.invNumber ?? rem.invoiceId);
      const outcome = await sendWhatsAppMessage(rem.customerMobile, message);
      if (outcome.ok) {
        await pool.query(`UPDATE reminders SET status = 'SENT', "sentAt" = $1 WHERE id = $2`, [new Date().toISOString(), rem.id]);
        console.log(`[scheduler] sent ${rem.triggerType} to +91 ${rem.customerMobile}`);
      } else {
        await pool.query(`UPDATE reminders SET status = 'FAILED' WHERE id = $1`, [rem.id]);
        console.warn(`[scheduler] failed reminder ${rem.id}: ${outcome.error}`);
      }
    } catch (err) {
      console.error(`[scheduler] error processing reminder ${rem.id}:`, err);
    }
  }
}

/** Runs one cycle, swallowing any error so an unhandled rejection can't crash the process. */
const runCycle = (): void => {
  void processDueReminders().catch((err) => console.error('[scheduler] cycle failed:', err));
};

/** Starts the auto-send loop (no-op when WhatsApp API isn't configured). */
export function startScheduler(): void {
  if (!isWhatsAppConfigured()) {
    console.log('ℹ  WhatsApp API not configured — auto-send idle. One-click WhatsApp still works.');
    return;
  }
  const seconds = Math.round(config.whatsapp.schedulerIntervalMs / 1000);
  console.log(`✓ WhatsApp auto-send scheduler active (every ${seconds}s).`);
  setTimeout(runCycle, 10_000);
  setInterval(runCycle, config.whatsapp.schedulerIntervalMs);
}
