import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import {
  createBusiness,
  findBusinessById,
  findBusinessByJoinCode,
  createUser,
  findUserByEmail,
} from '../store.js';
import { authenticate, type AuthedRequest } from '../middleware/auth.js';
import type { Business } from '../types.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signToken = (userId: string): string =>
  jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresInSeconds });

/** True when a Postgres error is a unique-constraint violation. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/**
 * POST /api/auth/register
 *   - with `inviteCode`: join that business as STAFF.
 *   - otherwise: create a new business (with `businessName`) and become its OWNER.
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

    let business: Business;
    let role: 'OWNER' | 'STAFF';
    if (typeof inviteCode === 'string' && inviteCode.trim()) {
      const found = await findBusinessByJoinCode(inviteCode);
      if (!found) return res.status(400).json({ error: 'Invalid invite code.' });
      business = found;
      role = 'STAFF';
    } else {
      if (typeof businessName !== 'string' || !businessName.trim()) {
        return res.status(400).json({ error: 'Business name is required to create a new business.' });
      }
      business = await createBusiness(businessName.trim());
      role = 'OWNER';
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(business.id, name.trim(), email, passwordHash, role);
    return res.status(201).json({ token: signToken(user.id), user, business });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('[auth/register] error:', err);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

/** POST /api/auth/login — exchange credentials for a JWT. */
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

    const user = { id: row.id, businessId: row.businessId, name: row.name, email: row.email, role: row.role };
    return res.json({ token: signToken(user.id), user, business: await findBusinessById(user.businessId) });
  } catch (err) {
    console.error('[auth/login] error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

/** GET /api/auth/me — the current authenticated user + their business. */
router.get('/me', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user!;
    return res.json({ user, business: await findBusinessById(user.businessId) });
  } catch (err) {
    console.error('[auth/me] error:', err);
    return res.status(500).json({ error: 'Failed to load profile.' });
  }
});

export default router;
