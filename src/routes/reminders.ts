import { Router, type Request, type Response } from 'express';
import {
  draftReminderMessage,
  REMINDER_TONES,
  type DraftReminderInput,
  type ReminderTone,
} from '../services/reminders.js';
import { MiniMaxError } from '../services/minimax.js';

const router = Router();

const DRAFT_REQUIRED: (keyof DraftReminderInput)[] = [
  'customerName',
  'invoiceNumber',
  'amount',
  'dueDate',
  'payLink',
  'tone',
];

/** POST /api/ai/draft — generate a WhatsApp payment reminder via MiniMax-M3. */
router.post('/draft', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<DraftReminderInput>;

  const missing = DRAFT_REQUIRED.filter((field) => {
    const value = body[field];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}.` });
  }
  if (!REMINDER_TONES.includes(body.tone as ReminderTone)) {
    return res.status(400).json({ error: `Invalid tone. Expected one of: ${REMINDER_TONES.join(', ')}.` });
  }

  try {
    const message = await draftReminderMessage(body as DraftReminderInput);
    return res.json({ message });
  } catch (err) {
    if (err instanceof MiniMaxError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[ai/draft] Unexpected error:', err);
    return res.status(500).json({ error: 'Failed to draft reminder.' });
  }
});

export default router;
