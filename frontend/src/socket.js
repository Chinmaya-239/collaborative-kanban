import { io } from 'socket.io-client';
import { API_URL } from './api.js';

let socket = null;
export const getSocket = () => socket;
export function disconnectSocket() { socket?.close(); socket = null; }
export function connectSocket(token) {
  disconnectSocket();
  // Socket.IO reconnects automatically with backoff; we re-join the tenant room on every 'connect'.
  socket = io(API_URL, { auth: { token }, reconnection: true, reconnectionDelayMax: 5000 });
  return socket;
}
