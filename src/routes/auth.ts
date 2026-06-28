import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config, isButterbaseConfigured } from '../config.js';
import {
  createAccount,
  createStore,
  createUser,
  addMembership,
  findAccountByJoinCode,
  findUserByEmail,
  listAccessibleStores,
  listStoresForAccount,
  loadAccountView,
  countStaff,
} from '../store.js';
import { withTransaction } from '../db.js';
import { PLANS } from '../plans.js';
import { authenticate, type AuthedRequest } from '../middleware/auth.js';
import type { User } from '../types.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signToken = (userId: string): string =>
  jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresInSeconds });

/** True when a Postgres error is a unique-constraint violation. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/** Assembles the full client session: user, account (+plan/limits/usage), stores, active store. */
async function buildSession(user: User): Promise<Record<string, unknown>> {
  const [account, stores] = await Promise.all([loadAccountView(user.accountId), listAccessibleStores(user)]);
  const activeStoreId = stores.find((s) => s.id === user.businessId)?.id ?? stores[0]?.id ?? null;
  return { user, account, stores, activeStoreId };
}

/**
 * POST /api/auth/register
 *   - with `inviteCode`: join that account as STAFF (assigned to its first store).
 *   - otherwise: create a new account + its first store and become OWNER.
 */
router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password, businessName, inviteCode } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let user: User;

    if (typeof inviteCode === 'string' && inviteCode.trim()) {
      // Join an existing account as STAFF.
      const account = await findAccountByJoinCode(inviteCode);
      if (!account) return res.status(400).json({ error: 'Invalid invite code.' });

      const staffLimit = PLANS[account.plan].staff;
      if ((await countStaff(account.id)) >= staffLimit) {
        return res.status(403).json({
          error: `This account's ${PLANS[account.plan].label} plan allows ${staffLimit} staff login(s). Ask the owner to upgrade to add more.`,
        });
      }

      const stores = await listStoresForAccount(account.id);
      const firstStore = stores[0];
      user = await withTransaction(async (client) => {
        const u = await createUser(account.id, firstStore?.id ?? '', name.trim(), email, passwordHash, 'STAFF', client);
        if (firstStore) await addMembership(u.id, firstStore.id, client);
        return u;
      });
    } else {
      // Create a brand-new account + its first store; caller becomes OWNER.
      if (typeof businessName !== 'string' || !businessName.trim()) {
        return res.status(400).json({ error: 'Business name is required to create a new account.' });
      }
      user = await withTransaction(async (client) => {
        const account = await createAccount(businessName.trim(), client);
        const store = await createStore(account.id, businessName.trim(), client);
        return createUser(account.id, store.id, name.trim(), email, passwordHash, 'OWNER', client);
      });
    }

    return res.status(201).json({ token: signToken(user.id), ...(await buildSession(user)) });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('[auth/register] error:', err);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

/** POST /api/auth/login — exchange credentials for a JWT + session. */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const row = await findUserByEmail(email);
    if (!row || !(await bcrypt.compare(password, row.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user: User = { id: row.id, accountId: row.accountId, businessId: row.businessId, name: row.name, email: row.email, role: row.role };
    return res.json({ token: signToken(user.id), ...(await buildSession(user)) });
  } catch (err) {
    console.error('[auth/login] error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

/**
 * POST /api/auth/google — sign in / sign up with a butterbase Google session.
 *
 * Body: { butterbaseToken, businessName?, inviteCode? }
 *   - `butterbaseToken` is the access token issued by butterbase after the user
 *     completes Google OAuth (butterbase handles the Google handshake).
 *
 * We verify the token against butterbase's `/auth/{appId}/me`, then:
 *   - existing MahajanBook user (matched by verified email) → logged in;
 *   - new user → needs a business: `inviteCode` joins as STAFF, `businessName`
 *     creates an account+store as OWNER. If neither is supplied we respond 200
 *     with `{ needsBusiness: true, profile }` so the client can ask.
 *
 * Google users have no MahajanBook password — we store an unguessable random
 * hash so the (NOT NULL) column is satisfied and password login can't be used.
 */
router.post('/google', async (req: Request, res: Response) => {
  if (!isButterbaseConfigured()) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }

  const { butterbaseToken, businessName, inviteCode } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof butterbaseToken !== 'string' || !butterbaseToken) {
    return res.status(400).json({ error: 'Missing Google session token.' });
  }

  // 1. Verify the butterbase session and read the (Google-verified) profile.
  let email: string;
  let name: string;
  try {
    const resp = await fetch(`${config.butterbase.apiBase}/auth/${config.butterbase.appId}/me`, {
      headers: { Authorization: `Bearer ${butterbaseToken}` },
    });
    if (!resp.ok) {
      return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
    const profile = (await resp.json()) as Record<string, any>;
    const rawEmail = profile?.email ?? profile?.user?.email;
    if (!rawEmail || typeof rawEmail !== 'string') {
      return res.status(401).json({ error: 'Could not read your Google profile.' });
    }
    email = rawEmail.toLowerCase();
    const rawName = profile?.display_name ?? profile?.user?.display_name ?? '';
    name = (typeof rawName === 'string' ? rawName.trim() : '') || email.split('@')[0];
  } catch (err) {
    console.error('[auth/google] verification failed:', err);
    return res.status(502).json({ error: 'Could not reach the sign-in service. Please try again.' });
  }

  // 2. Log in an existing user, or create one (account+store as OWNER, or join as STAFF).
  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      const user: User = { id: existing.id, accountId: existing.accountId, businessId: existing.businessId, name: existing.name, email: existing.email, role: existing.role };
      return res.json({ token: signToken(user.id), ...(await buildSession(user)) });
    }

    const randomHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
    let user: User;

    if (typeof inviteCode === 'string' && inviteCode.trim()) {
      const account = await findAccountByJoinCode(inviteCode);
      if (!account) return res.status(400).json({ error: 'Invalid invite code.' });

      const staffLimit = PLANS[account.plan].staff;
      if ((await countStaff(account.id)) >= staffLimit) {
        return res.status(403).json({
          error: `This account's ${PLANS[account.plan].label} plan allows ${staffLimit} staff login(s). Ask the owner to upgrade to add more.`,
        });
      }

      const stores = await listStoresForAccount(account.id);
      const firstStore = stores[0];
      user = await withTransaction(async (client) => {
        const u = await createUser(account.id, firstStore?.id ?? '', name, email, randomHash, 'STAFF', client);
        if (firstStore) await addMembership(u.id, firstStore.id, client);
        return u;
      });
    } else if (typeof businessName === 'string' && businessName.trim()) {
      user = await withTransaction(async (client) => {
        const account = await createAccount(businessName.trim(), client);
        const store = await createStore(account.id, businessName.trim(), client);
        return createUser(account.id, store.id, name, email, randomHash, 'OWNER', client);
      });
    } else {
      return res.json({ needsBusiness: true, profile: { email, name } });
    }

    return res.status(201).json({ token: signToken(user.id), ...(await buildSession(user)) });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('[auth/google] error:', err);
    return res.status(500).json({ error: 'Google sign-in failed.' });
  }
});

/** GET /api/auth/me — current user + account + stores + active store. */
router.get('/me', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    return res.json(await buildSession(req.user!));
  } catch (err) {
    console.error('[auth/me] error:', err);
    return res.status(500).json({ error: 'Failed to load profile.' });
  }
});

export default router;
