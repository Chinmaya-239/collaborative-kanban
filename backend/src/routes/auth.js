import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { HttpError, wrap } from '../errors.js';
import { authenticate, signToken } from '../auth.js';
import { listAuthorized } from '../access.js';

const r = Router();
const registerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

r.post('/register', wrap(async (req, res) => {
  const { name, email, password } = registerSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'Email already registered');
  const user = await prisma.user.create({ data: { name, email, passwordHash: await bcrypt.hash(password, 10) } });
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
}));

r.post('/login', wrap(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  // Same message for unknown email and wrong password (no account enumeration)
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Invalid email or password');
  res.json({ user: publicUser(user), token: signToken(user) });
}));

r.get('/me', authenticate, wrap(async (req, res) => {
  res.json({ user: req.user, organizations: await listAuthorized(req.user.id) });
}));

export default r;
