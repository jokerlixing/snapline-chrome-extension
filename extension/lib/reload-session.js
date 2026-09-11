// The snapshot lives in IndexedDB so imported File objects survive a reload.
// Storage only holds the pointer needed by the new service worker.
export const RELOAD_SESSION_KEY = 'snaplinePendingReload';
export const RELOAD_SESSION_TTL = 15 * 60 * 1000;
export function validReloadSession(session) {
  return session && typeof session.id === 'string' && session.id.startsWith('reload-')
    && Number.isFinite(session.createdAt) && Date.now() - session.createdAt >= 0
    && Date.now() - session.createdAt < RELOAD_SESSION_TTL;
}
