/**
 * Socket.IO server: authenticated handshake, tenant-scoped rooms, presence.
 * A client can only join a room after the server re-checks membership in the DB.
 */
import { Server } from 'socket.io';
import { config } from './config.js';
import { userFromToken } from './auth.js';
import { getTenantAccess } from './access.js';

let io = null;
const room = (tenantId) => `tenant:${tenantId}`;

// tenantId -> Map(userId -> { name, sockets:Set<socketId> }); a user with 2 tabs stays online until both close
const presence = new Map();
const snapshot = (tenantId) => [...(presence.get(tenantId) || [])].map(([id, v]) => ({ id, name: v.name }));

function addPresence(tenantId, user, sid) {
  if (!presence.has(tenantId)) presence.set(tenantId, new Map());
  const m = presence.get(tenantId);
  const wasOnline = m.has(user.id);
  if (!wasOnline) m.set(user.id, { name: user.name, sockets: new Set() });
  m.get(user.id).sockets.add(sid);
  return !wasOnline;
}

function removePresence(tenantId, userId, sid) {
  const m = presence.get(tenantId);
  const entry = m?.get(userId);
  if (!entry) return false;
  entry.sockets.delete(sid);
  if (entry.sockets.size) return false;
  m.delete(userId);
  if (!m.size) presence.delete(tenantId);
  return true;
}

function leaveCurrent(socket) {
  const tenantId = socket.data.tenantId;
  if (!tenantId) return;
  const user = socket.data.user;
  socket.leave(room(tenantId));
  socket.data.tenantId = null;
  if (removePresence(tenantId, user.id, socket.id)) io.to(room(tenantId)).emit('presence:offline', { user });
  io.to(room(tenantId)).emit('presence:update', { users: snapshot(tenantId) });
}

export function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: config.corsOrigin, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token);
      if (!user) throw new Error('no user');
      socket.data.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    socket.on('tenant:join', async (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      try {
        const tenantId = payload?.tenantId;
        const access = await getTenantAccess(user.id, tenantId); // authoritative DB check
        if (!access) return done({ ok: false, error: 'FORBIDDEN' });
        if (socket.data.tenantId && socket.data.tenantId !== tenantId) leaveCurrent(socket);
        if (socket.data.tenantId !== tenantId) {
          socket.join(room(tenantId));
          socket.data.tenantId = tenantId;
          if (addPresence(tenantId, user, socket.id)) socket.to(room(tenantId)).emit('presence:online', { user });
          io.to(room(tenantId)).emit('presence:update', { users: snapshot(tenantId) });
        }
        done({ ok: true, role: access.role, presence: snapshot(tenantId) });
      } catch (e) {
        console.error('tenant:join failed', e);
        done({ ok: false, error: 'SERVER_ERROR' });
      }
    });

    socket.on('tenant:leave', () => leaveCurrent(socket));
    socket.on('disconnect', () => leaveCurrent(socket));
  });
  return io;
}

/** Broadcast ONLY to the tenant's room. Call after the DB transaction has committed. */
export function emitTenant(tenantId, event, payload) {
  io?.to(room(tenantId)).emit(event, payload);
}
