import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { prisma } from './prisma.js';
import { HttpError, wrap } from './errors.js';

export const signToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpires });
export const verifyToken = (token) => jwt.verify(token, config.jwtSecret);
const PUBLIC_USER = { id: true, name: true, email: true };

export async function userFromToken(token) {
  const payload = verifyToken(token);
  return prisma.user.findUnique({ where: { id: payload.sub }, select: PUBLIC_USER });
}

export const authenticate = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
  let user;
  try {
    user = await userFromToken(h.slice(7));
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  if (!user) throw new HttpError(401, 'Invalid or expired token');
  req.user = user;
  next();
});
