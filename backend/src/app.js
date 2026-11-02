import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { errorHandler } from './errors.js';
import authRoutes from './routes/auth.js';
import { orgRouter, tenantRouter } from './routes/orgs.js';
import { boardRouter, columnRouter } from './routes/boards.js';
import taskRoutes from './routes/tasks.js';
import activityRoutes from './routes/activity.js';

export const app = express();
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/organizations', orgRouter);
app.use('/api/tenants', tenantRouter);
app.use('/api/boards', boardRouter);
app.use('/api/columns', columnRouter);
app.use('/api/tasks', taskRoutes);
app.use('/api/activity', activityRoutes);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);
