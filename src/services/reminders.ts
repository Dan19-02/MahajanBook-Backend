import { chatCompletion } from './minimax.js';
import type { WhatsAppReminder, ReminderTriggerType } from '../types.js';

// ---------------------------------------------------------------------------
// AI drafting (MiniMax-M3)
// ---------------------------------------------------------------------------

/** Each tone maps to a point in the recovery journey. */
export type ReminderTone = 'gentle' | 'due_today' | 'overdue' | 'serious' | 'final';

export const REMINDER_TONES: readonly ReminderTone[] = [
  'gentle',
  'due_today',
  'overdue',
  'serious',
  'final',
] as const;

export interface DraftReminderInput {
  customerName: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  payLink: string;
  tone: ReminderTone;
  businessName?: string;
  language?: string;
}

const TONE_GUIDE: Record<ReminderTone, string> = {
  gentle: 'A friendly, polite pre-due reminder — payment is due tomorrow. Warm and appreciative.',
  due_today: 'A clear reminder that payment is due today. Polite, with a gentle sense of urgency.',
  overdue: 'A firm first-overdue notice — payment is overdue. Respectful but clearly urgent.',
  serious: 'A serious overdue notice (several days late). Firm and professional; note consequences politely.',
  final: 'A final demand before escalation. Very firm and formal — never threatening, abusive, or unlawful.',
};

/** Builds the prompt and asks MiniMax-M3 for a WhatsApp-ready reminder message. */
export async function draftReminderMessage(input: DraftReminderInput): Promise<string> {
  const businessName = input.businessName?.trim() || 'MahajanBook';
  const language = input.language?.trim() || 'English';

  const system = [
    'You are a billing assistant for an Indian retail/wholesale business.',
    'You write short, WhatsApp-ready payment reminder messages.',
    'Rules:',
    '- Keep it under 60 words, as one short paragraph.',
    '- Use the Indian Rupee symbol ₹ for amounts.',
    '- Address the customer by name and reference the invoice number.',
    '- Include the payment link exactly as provided, exactly once.',
    '- Be professional and culturally appropriate. Never threaten, abuse, or imply anything unlawful.',
    '- Output ONLY the message text: no markdown, no surrounding quotes, no preamble.',
  ].join('\n');

  const user = [
    `Business name: ${businessName}`,
    `Customer name: ${input.customerName}`,
    `Invoice number: ${input.invoiceNumber}`,
    `Amount due: ₹${input.amount}`,
    `Due date: ${input.dueDate}`,
    `Payment link: ${input.payLink}`,
    `Language: ${language}`,
    `Tone & situation: ${TONE_GUIDE[input.tone]}`,
    '',
    'Write the reminder message now.',
  ].join('\n');

  return chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 512, temperature: 0.7 },
  );
}

// ---------------------------------------------------------------------------
// Reminder scheduling (owned by the backend)
//
// Cadence: the first reminder goes out the day BEFORE the PTP date, then every
// other day after the PTP date — i.e. a blank day is left between each send:
//   PTP-1, PTP+1, PTP+3, PTP+5, PTP+7, PTP+9, PTP+11
// A reminder only matters while the invoice is unpaid; paying cancels the rest.
// ---------------------------------------------------------------------------

export interface ScheduleInvoiceInput {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerMobile: string;
  grandTotal: number;
  ptpDate?: string;
  paymentStatus: 'PAID' | 'CREDIT';
}

const TRIGGERS: { type: ReminderTriggerType; offset: number }[] = [
  { type: 'PTP_MINUS_1', offset: -1 },
  { type: 'PTP_PLUS_1', offset: 1 },
  { type: 'PTP_PLUS_3', offset: 3 },
  { type: 'PTP_PLUS_5', offset: 5 },
  { type: 'PTP_PLUS_7', offset: 7 },
  { type: 'PTP_PLUS_9', offset: 9 },
  { type: 'PTP_PLUS_11', offset: 11 },
];

const toDateStr = (d: Date): string => d.toISOString().split('T')[0];

/** Builds the full reminder schedule for a credit invoice (empty otherwise). */
export function buildReminderSchedule(invoice: ScheduleInvoiceInput): WhatsAppReminder[] {
  if (invoice.paymentStatus !== 'CREDIT' || !invoice.ptpDate) return [];

  const ptp = new Date(invoice.ptpDate);
  const todayStr = toDateStr(new Date());
  const payLink = `https://rzp.io/i/mb_${invoice.invoiceNumber.toLowerCase()}`;

  return TRIGGERS.map(({ type, offset }) => {
    const triggerDate = new Date(ptp);
    triggerDate.setDate(ptp.getDate() + offset);
    const scheduledFor = toDateStr(triggerDate);
    const isPast = scheduledFor < todayStr;

    return {
      id: `rem-${invoice.id}-${type}`,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      customerMobile: invoice.customerMobile,
      invoiceAmount: invoice.grandTotal,
      ptpDate: invoice.ptpDate as string,
      triggerType: type,
      scheduledFor,
      status: isPast ? 'SENT' : 'QUEUED',
      razorpayPaymentLink: payLink,
      sentAt: isPast ? `${scheduledFor}T10:00:00Z` : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Send simulation (swap for a real WhatsApp Business API call when ready)
// ---------------------------------------------------------------------------

export interface SendReminderInput {
  customerName: string;
  customerMobile: string;
  triggerType?: string;
}

export interface SendResult {
  status: 'SENT';
  sentAt: string;
  providerMessageId: string;
  log: string;
}

/** Builds the WhatsApp text for auto-send (templated, escalating by milestone). */
export function autoReminderMessage(
  r: { customerName: string; invoiceAmount: number; ptpDate: string; razorpayPaymentLink: string; triggerType: ReminderTriggerType },
  businessName: string,
  invoiceNumber: string,
): string {
  const amt = `₹${r.invoiceAmount.toLocaleString('en-IN')}`;
  const link = r.razorpayPaymentLink;
  switch (r.triggerType) {
    case 'PTP_MINUS_1':
      return `Dear ${r.customerName}, a gentle reminder from ${businessName}: invoice #${invoiceNumber} of ${amt} is due tomorrow (${r.ptpDate}). Pay anytime here: ${link}. Thank you!`;
    case 'PTP_PLUS_1':
      return `Hello ${r.customerName}, invoice #${invoiceNumber} of ${amt} from ${businessName} is now overdue (was due ${r.ptpDate}). Kindly clear it here: ${link}. Thank you.`;
    case 'PTP_PLUS_3':
      return `Reminder from ${businessName}: your balance of ${amt} on invoice #${invoiceNumber} is a few days overdue. Please settle it today: ${link}.`;
    case 'PTP_PLUS_5':
      return `${r.customerName}, invoice #${invoiceNumber} of ${amt} from ${businessName} remains unpaid. Please pay now to avoid disruption to your credit: ${link}.`;
    default:
      return `Final reminder from ${businessName}: invoice #${invoiceNumber} of ${amt} is significantly overdue. Please clear it within 24 hours to avoid further action: ${link}.`;
  }
}

export function simulateSend(input: SendReminderInput): SendResult {
  const sentAt = new Date().toISOString();
  const providerMessageId = `wamid.${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const log =
    `${sentAt.replace('T', ' ').slice(0, 19)} - [WhatsAppBusinessAPI] Sent ` +
    `${input.triggerType ?? 'reminder'} to +91 ${input.customerMobile} (${input.customerName}): ` +
    `Status Accepted (200 OK) [${providerMessageId}]`;
  return { status: 'SENT', sentAt, providerMessageId, log };
}
