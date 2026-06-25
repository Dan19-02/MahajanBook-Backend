/**
 * Subscription tiers. Limits are enforced server-side; the frontend reads the
 * same shape (via /api/auth/me) to drive the Plans UI and gating.
 *
 * `Infinity` represents "unlimited". It does not survive JSON, so
 * `serializeLimits()` maps it to `null` for API responses — clients treat
 * `null` as unlimited.
 */
export type Plan = 'STARTER' | 'GROWTH' | 'UNLIMITED';

export interface PlanLimits {
  label: string;
  priceMonthly: number; // INR / month
  stores: number; // max active stores (Infinity = unlimited)
  staff: number; // max STAFF logins, excluding the owner (Infinity = unlimited)
  reminderCap: number; // AI WhatsApp reminders per calendar month (Infinity = unlimited)
}

export const PLANS: Record<Plan, PlanLimits> = {
  STARTER: { label: 'Starter', priceMonthly: 1500, stores: 1, staff: 1, reminderCap: 150 },
  GROWTH: { label: 'Growth', priceMonthly: 2500, stores: 10, staff: 8, reminderCap: 750 },
  UNLIMITED: { label: 'Unlimited', priceMonthly: 5000, stores: Infinity, staff: Infinity, reminderCap: Infinity },
};

export const DEFAULT_PLAN: Plan = 'STARTER';

export const isPlan = (v: unknown): v is Plan =>
  v === 'STARTER' || v === 'GROWTH' || v === 'UNLIMITED';

/** Replaces Infinity with null (unlimited) so the limits serialize cleanly to JSON. */
export function serializeLimits(limits: PlanLimits): Record<string, number | string | null> {
  const fix = (n: number): number | null => (Number.isFinite(n) ? n : null);
  return {
    label: limits.label,
    priceMonthly: limits.priceMonthly,
    stores: fix(limits.stores),
    staff: fix(limits.staff),
    reminderCap: fix(limits.reminderCap),
  };
}
