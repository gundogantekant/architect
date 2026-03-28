/** Purge all sessions before any tests run — prevents stale data from prior runs */
export default async function globalSetup() {
  const BASE = 'http://127.0.0.1:3777';
  await fetch(`${BASE}/api/test/purge-all`, { method: 'POST' }).catch(() => {});
}
