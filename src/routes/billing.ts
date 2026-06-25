import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  RazorpayError,
  isBillingConfigured,
  createSubscription,
  getSubscription,
  planIdFor,
  planFromId,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../services/razorpay.js';
import { isPlan, type Plan } from '../plans.js';
import {
  findAccountBySubscriptionId,
  setAccountSubscription,
  enforcePlanStoreLimit,
  loadAccountView,
} from '../store.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const router = Router();

/** POST /api/billing/subscribe — owner starts a subscription; returns ids for Checkout. */
router.post('/subscribe', async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  const account = req.account;
  if (!user || !account) return res.status(401).json({ error: 'Authentication required.' });
  if (user.role !== 'OWNER') return res.status(403).json({ error: 'Only the owner can manage billing.' });
  if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.' });

  const plan = String((req.body as Record<string, unknown>)?.plan ?? '').toUpperCase();
  if (!isPlan(plan)) return res.status(400).json({ error: 'Invalid plan.' });
  const planId = planIdFor(plan);
  if (!planId) return res.status(400).json({ error: `No Razorpay plan is configured for ${plan}.` });

  try {
    const sub = await createSubscription(planId, { accountId: account.id, plan });
    await setAccountSubscription(account.id, { razorpaySubscriptionId: sub.id, subscriptionStatus: sub.status ?? 'created' });
    return res.json({ keyId: config.razorpay.keyId, subscriptionId: sub.id, plan });
  } catch (err) {
    if (err instanceof RazorpayError) return res.status(err.status).json({ error: err.message });
    console.error('[billing/subscribe]', err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
});

/** POST /api/billing/verify — confirm the Checkout signature and activate the plan. */
router.post('/verify', async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  const account = req.account;
  if (!user || !account) return res.status(401).json({ error: 'Authentication required.' });
  if (user.role !== 'OWNER') return res.status(403).json({ error: 'Only the owner can manage billing.' });

  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = (req.body ?? {}) as Record<string, string>;
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment fields.' });
  }
  if (!verifyPaymentSignature(razorpay_payment_id, razorpay_subscription_id, razorpay_signature)) {
    return res.status(400).json({ error: 'Payment verification failed.' });
  }

  try {
    const sub = await getSubscription(razorpay_subscription_id);
    const plan = sub.plan_id ? planFromId(sub.plan_id) : undefined;
    if (!plan) return res.status(400).json({ error: 'Unknown subscription plan.' });
    await setAccountSubscription(account.id, {
      plan,
      razorpaySubscriptionId: sub.id,
      subscriptionStatus: sub.status ?? 'active',
      currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
    });
    await enforcePlanStoreLimit(account.id);
    return res.json({ account: await loadAccountView(account.id) });
  } catch (err) {
    if (err instanceof RazorpayError) return res.status(err.status).json({ error: err.message });
    console.error('[billing/verify]', err);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

interface WebhookSub {
  id?: string;
  plan_id?: string;
  status?: string;
  current_end?: number | null;
}

/**
 * POST /api/billing/webhook — Razorpay subscription events. Public, but the raw
 * body is HMAC-verified against RAZORPAY_WEBHOOK_SECRET. Mounted with
 * express.raw() in index.ts so `req.body` is the exact Buffer that was signed.
 */
export async function webhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.header('x-razorpay-signature') ?? '';
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, signature)) {
    res.status(400).json({ error: 'Invalid signature.' });
    return;
  }

  let event: { event?: string; payload?: { subscription?: { entity?: WebhookSub } } };
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Bad payload.' });
    return;
  }

  try {
    const sub = event.payload?.subscription?.entity;
    if (sub?.id) {
      const account = await findAccountBySubscriptionId(sub.id);
      if (account) {
        const evt = String(event.event ?? '');
        const downgrade = evt === 'subscription.cancelled' || evt === 'subscription.halted' || evt === 'subscription.completed';
        let plan: Plan | undefined;
        if (downgrade) plan = 'STARTER';
        else if (sub.plan_id) plan = planFromId(sub.plan_id);
        await setAccountSubscription(account.id, {
          plan,
          subscriptionStatus: sub.status ?? evt,
          currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
        });
        await enforcePlanStoreLimit(account.id);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[billing/webhook]', err);
    res.status(500).json({ error: 'Webhook handling failed.' });
  }
}

export default router;
