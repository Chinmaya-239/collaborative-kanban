import { useEffect, useState } from 'react';
import { getSocket } from '../socket.js';

/**
 * Joins the active tenant's room (server re-checks membership), tracks presence and connection state.
 * `resyncKey` increments after every successful (re)join so data hooks can refetch authoritative state:
 * we never assume we received every event while disconnected.
 */
export function useRealtime(tenantId) {
  const [status, setStatus] = useState('connecting'); // connecting | online | reconnecting | denied
  const [presence, setPresence] = useState([]);
  const [resyncKey, setResyncKey] = useState(0);

  useEffect(() => {
    const s = getSocket();
    if (!s || !tenantId) return undefined;
    const join = () =>
      s.emit('tenant:join', { tenantId }, (res) => {
        if (res?.ok) { setStatus('online'); setPresence(res.presence); setResyncKey((k) => k + 1); }
        else setStatus('denied');
      });
    const onDisconnect = () => setStatus('reconnecting');
    const onPresence = ({ users }) => setPresence(users);
    s.on('connect', join); // fires on first connect AND after every automatic reconnect
    s.on('disconnect', onDisconnect);
    s.on('presence:update', onPresence);
    if (s.connected) join();
    return () => {
      s.off('connect', join); s.off('disconnect', onDisconnect); s.off('presence:update', onPresence);
      if (s.connected) s.emit('tenant:leave');
      setPresence([]);
    };
  }, [tenantId]);

  return { status, presence, resyncKey };
}
