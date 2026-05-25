export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { verifyDatabaseSchema } = await import('./lib/startup');
    await verifyDatabaseSchema();
  }
}
