export default function telegramRoutes(deps) {
  const { db, json, err, parseBody, getTelegramHandle } = deps;

  function resolveNotifyToggles({ rawQuestions, rawIdle, rawLifecycle, legacyTrigger }) {
    if (rawQuestions === null && rawIdle === null && rawLifecycle === null) {
      const lifecycle = legacyTrigger === 'questions_lifecycle';
      return { notify_questions: true, notify_idle: false, notify_lifecycle: lifecycle };
    }
    return {
      notify_questions: rawQuestions === null ? true : rawQuestions === 'true',
      notify_idle: rawIdle === null ? false : rawIdle === 'true',
      notify_lifecycle: rawLifecycle === null ? false : rawLifecycle === 'true',
    };
  }

  async function readConfig() {
    const enabled = (await db.getPreference('telegram_enabled')) === 'true';
    const rawAllowlist = await db.getPreference('telegram_allowlist');
    const defaultChat = await db.getPreference('telegram_default_chat_id');
    const toggles = resolveNotifyToggles({
      rawQuestions: await db.getPreference('telegram_notify_questions'),
      rawIdle: await db.getPreference('telegram_notify_idle'),
      rawLifecycle: await db.getPreference('telegram_notify_lifecycle'),
      legacyTrigger: await db.getPreference('telegram_trigger'),
    });
    let allowlist = [];
    if (rawAllowlist) {
      try { allowlist = JSON.parse(rawAllowlist); } catch { allowlist = []; }
    }
    return {
      enabled,
      allowlist: Array.isArray(allowlist) ? allowlist.map(Number) : [],
      default_chat_id: defaultChat ? Number(defaultChat) : null,
      ...toggles,
    };
  }

  return [
    [/^\/api\/telegram\/config$/, 'GET', async (_m, _req, res) => {
      json(res, await readConfig());
    }],

    [/^\/api\/telegram\/config$/, 'PUT', async (_m, req, res) => {
      const body = await parseBody(req);
      const toBool = (v) => String(v === true || v === 'true');
      if (body.enabled !== undefined) await db.setPreference('telegram_enabled', toBool(body.enabled));
      if (body.trigger !== undefined) await db.setPreference('telegram_trigger', String(body.trigger));
      if (body.notify_questions !== undefined) await db.setPreference('telegram_notify_questions', toBool(body.notify_questions));
      if (body.notify_idle !== undefined) await db.setPreference('telegram_notify_idle', toBool(body.notify_idle));
      if (body.notify_lifecycle !== undefined) await db.setPreference('telegram_notify_lifecycle', toBool(body.notify_lifecycle));
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
