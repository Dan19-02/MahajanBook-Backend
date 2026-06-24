import { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { findUserById } from '../store.js';
import type { User } from '../types.js';

export interface AuthedRequest extends Request {
  user?: User;
}

/** Express middleware that requires a valid Bearer JWT and attaches req.user. */
export async function authenticate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  let userId: string;
  try {
    const payload = jwt.verify(token, config.jwt.secret) as { sub: string };
    userId = payload.sub;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }
  try {
    const user = await findUserById(userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid token.' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth middleware] error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
}
