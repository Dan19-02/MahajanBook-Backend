import crypto from 'node:crypto';
import { config, isBillingConfigured } from '../config.js';
import { isPlan, type Plan } from '../plans.js';

export { isBillingConfigured };

/** Error carrying an HTTP status so routes can translate it into a response. */
export class RazorpayError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
  }
}

const API = 'https://api.razorpay.com/v1';

const authHeader = (): string =>
  'Basic ' + Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');

/** The Razorpay Subscription Plan ID configured for a tier (empty if unset). */
export const planIdFor = (plan: Plan): string => config.razorpay.planIds[plan] ?? '';

/** Reverse lookup: which tier a Razorpay plan_id maps to (undefined if unknown). */
export function planFromId(planId: string): Plan | undefined {
  const entries = Object.entries(config.razorpay.planIds) as [Plan, string][];
  const hit = entries.find(([, id]) => id && id === planId);
  return hit ? hit[0] : undefined;
}

interface SubscriptionEntity {
  id: string;
  plan_id?: string;
  status?: string;
  current_end?: number | null;
  short_url?: string;
}

/** Creates a Razorpay subscription for a plan id. The customer authorises it via Checkout. */
export async function createSubscription(planId: string, notes: Record<string, string>): Promise<SubscriptionEntity> {
  if (!isBillingConfigured()) throw new RazorpayError('Billing is not configured on the server.', 503);
  let res: Response;
  try {
    res = await fetch(`${API}/subscriptions`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: planId, total_count: 12, customer_notify: 1, notes }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new RazorpayError(`Could not reach Razorpay: ${(e as Error).message}`, 502);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new RazorpayError(`Razorpay subscription create failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`, 502);
  }
  return (await res.json()) as SubscriptionEntity;
}

/** Fetches a subscription (used to learn its plan_id after payment). */
export async function getSubscription(subscriptionId: string): Promise<SubscriptionEntity> {
  if (!isBillingConfigured()) throw new RazorpayError('Billing is not configured on the server.', 503);
  let res: Response;
  try {
    res = await fetch(`${API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new RazorpayError(`Could not reach Razorpay: ${(e as Error).message}`, 502);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new RazorpayError(`Razorpay subscription fetch failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`, 502);
  }
  return (await res.json()) as SubscriptionEntity;
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifies the Checkout callback for a subscription:
 * signature == HMAC_SHA256(payment_id + '|' + subscription_id, key_secret).
 */
export function verifyPaymentSignature(paymentId: string, subscriptionId: string, signature: string): boolean {
  if (!config.razorpay.keySecret) return false;
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

/** Verifies a webhook payload against the configured webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  if (!config.razorpay.webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Maps a Razorpay subscription status to whether the paid plan should be active. */
export const isActiveStatus = (status?: string): boolean =>
  status === 'active' || status === 'authenticated' || status === 'charged' || status === 'completed';

export { isPlan };
