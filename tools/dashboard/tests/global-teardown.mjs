export default async function globalTeardown() {
  const pids = (process.env._TEST_SERVER_PIDS || '').split(',').filter(Boolean);
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
}
