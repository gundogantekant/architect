/**
 * Minimal Telegram Bot API client over fetch.
 *
 * The bot token is captured in the closure and never logged, thrown, or
 * embedded in any error message. Errors carry only the method name and HTTP
 * status. Retry policy is the caller's responsibility; getUpdates long-polls.
 */

export function createTelegramClient(token, { fetchImpl = globalThis.fetch } = {}) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, payload) {
    let response;
    try {
      response = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error(`telegram ${method} request failed (network error)`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`telegram ${method} failed (HTTP ${response.status}): ${body?.description ?? 'unknown'}`);
    }
    const data = await response.json();
    if (!data || data.ok !== true) {
      throw new Error(`telegram ${method} returned ok:false (HTTP ${response.status})`);
    }
    return data.result;
  }

  async function sendMessage({ chat_id, text, reply_to_message_id }) {
    return call('sendMessage', { chat_id, text, reply_to_message_id });
  }

  async function getUpdates({ offset, timeout = 25 } = {}) {
    const result = await call('getUpdates', { offset, timeout });
    return Array.isArray(result) ? result : [];
  }

  return { sendMessage, getUpdates };
}
