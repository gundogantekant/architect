export default function telegramRoutes(deps) {
  const { db, json, err, parseBody, getTelegramHandle } = deps;

  async function readConfig() {
    const enabled = (await db.getPreference('telegram_enabled')) === 'true';
    const trigger = (await db.getPreference('telegram_trigger')) || 'questions';
    const rawAllowlist = await db.getPreference('telegram_allowlist');
    const defaultChat = await db.getPreference('telegram_default_chat_id');
    let allowlist = [];
    if (rawAllowlist) {
      try { allowlist = JSON.parse(rawAllowlist); } catch { allowlist = []; }
    }
    return {
      enabled,
      trigger,
      allowlist: Array.isArray(allowlist) ? allowlist.map(Number) : [],
      default_chat_id: defaultChat ? Number(defaultChat) : null,
    };
  }

  return [
    [/^\/api\/telegram\/config$/, 'GET', async (_m, _req, res) => {
      json(res, await readConfig());
    }],

    [/^\/api\/telegram\/config$/, 'PUT', async (_m, req, res) => {
      const body = await parseBody(req);
      if (body.enabled !== undefined) await db.setPreference('telegram_enabled', String(body.enabled === true || body.enabled === 'true'));
      if (body.trigger !== undefined) await db.setPreference('telegram_trigger', String(body.trigger));
      if (body.allowlist !== undefined) await db.setPreference('telegram_allowlist', JSON.stringify(body.allowlist ?? []));
      if (body.default_chat_id !== undefined) await db.setPreference('telegram_default_chat_id', String(body.default_chat_id ?? ''));
      json(res, await readConfig());
    }],

    [/^\/api\/telegram\/status$/, 'GET', async (_m, _req, res) => {
      const handle = getTelegramHandle();
      json(res, handle?.status() ?? { running: false });
    }],

    [/^\/api\/telegram\/test$/, 'POST', async (_m, req, res) => {
      const handle = getTelegramHandle();
      if (!handle) return err(res, 'telegram bridge not running', 400);
      const body = await parseBody(req);
      try {
        const result = await handle.sendTest(body.text ?? 'Architect Telegram bridge test');
        json(res, result ?? { ok: true });
      } catch (e) {
        err(res, `telegram test failed: ${e.message}`, 500);
      }
    }],
  ];
}
