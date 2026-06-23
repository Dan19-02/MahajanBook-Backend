import { db } from './db.js';
import { config, isWhatsAppConfigured } from './config.js';
import { sendWhatsAppMessage } from './services/whatsapp.js';
import { autoReminderMessage } from './services/reminders.js';
import type { WhatsAppReminder } from './types.js';

type ReminderRow = WhatsAppReminder & { businessId: string };

/** Finds due, still-queued reminders across all businesses and auto-sends them. */
async function processDueReminders(): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  const today = new Date().toISOString().split('T')[0];
  const due = db
    .prepare("SELECT * FROM reminders WHERE status = 'QUEUED' AND scheduledFor <= ?")
    .all(today) as ReminderRow[];

  for (const rem of due) {
    const biz = db.prepare('SELECT name FROM businesses WHERE id = ?').get(rem.businessId) as { name: string } | undefined;
    const inv = db.prepare('SELECT invoiceNumber FROM invoices WHERE id = ?').get(rem.invoiceId) as { invoiceNumber: string } | undefined;
    const message = autoReminderMessage(rem, biz?.name ?? 'CreditFlow', inv?.invoiceNumber ?? rem.invoiceId);

    const outcome = await sendWhatsAppMessage(rem.customerMobile, message);
    if (outcome.ok) {
      db.prepare("UPDATE reminders SET status = 'SENT', sentAt = ? WHERE id = ?").run(new Date().toISOString(), rem.id);
      console.log(`[scheduler] sent ${rem.triggerType} to +91 ${rem.customerMobile}`);
    } else {
      db.prepare("UPDATE reminders SET status = 'FAILED' WHERE id = ?").run(rem.id);
      console.warn(`[scheduler] failed reminder ${rem.id}: ${outcome.error}`);
    }
  }
}

/** Starts the auto-send loop (no-op when WhatsApp API isn't configured). */
export function startScheduler(): void {
  if (!isWhatsAppConfigured()) {
    console.log('ℹ  WhatsApp API not configured — auto-send idle. One-click WhatsApp still works.');
    return;
  }
  const seconds = Math.round(config.whatsapp.schedulerIntervalMs / 1000);
  console.log(`✓ WhatsApp auto-send scheduler active (every ${seconds}s).`);
  setTimeout(() => void processDueReminders(), 10_000);
  setInterval(() => void processDueReminders(), config.whatsapp.schedulerIntervalMs);
}
