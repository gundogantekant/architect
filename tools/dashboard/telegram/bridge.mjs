/**
 * Telegram terminal bridge.
 *
 * Wires the question detector, terminal lifecycle, and inbound Telegram long-poll
 * into a single handle. All I/O (client, db, terminals, injection, timers) is
 * injected via deps so the loop can be driven with fakes in tests — this module
 * imports no pg, no network, and no timers of its own. The bot token never
 * touches this file; only the pre-built client does.
 */

import {
  buildNotification,
  resolveTarget,
  deliveredMsg,
  busyMsg,
  exitedMsg,
  unresolvedMsg,
  sessionsListMsg,
} from './format.mjs';

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PRUNE_MAX_AGE_DAYS = 7;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_ERROR_BACKOFF_MS = 3000;
const START_HELP =
  'Reply to a notification to answer that session. Use T-id: text to target a session, /sessions to list waiting sessions.';

function triggerSendsQuestions(trigger) {
  return trigger === 'questions' || trigger === 'questions_lifecycle';
}

function triggerSendsLifecycle(trigger) {
  return trigger === 'questions_lifecycle';
}

function waitingTerminalList(terminals, waiting) {
  const list = [];
  for (const id of waiting) {
    const terminal = terminals.get(id);
    if (!terminal) continue;
    list.push({
      id: terminal.id,
      project_key: terminal.project_key,
      work_item_id: terminal.work_item_id,
      questionText: terminal._tgQuestion ?? '',
    });
  }
  return list;
}

function buildTerminalsById(terminals, waiting) {
  const byId = new Map();
  for (const [id, terminal] of terminals) {
    byId.set(id, {
      id: terminal.id,
      status: terminal.status,
      project_key: terminal.project_key,
      work_item_id: terminal.work_item_id,
      isWaiting: waiting.has(id),
      questionText: terminal._tgQuestion,
    });
  }
  return byId;
}

async function buildBindings(update, db) {
  const bindings = new Map();
  const repliedTo = update.message?.reply_to_message?.message_id;
  if (repliedTo === undefined) return bindings;
  const binding = await db.getTelegramBindingByMessageId(repliedTo);
  if (binding) bindings.set(repliedTo, binding);
  return bindings;
}

function injectionReply(kind, terminalId, result) {
  if (result.ok) return deliveredMsg(terminalId, { fallback: kind === 'single' });
  if (result.reason === 'busy') return busyMsg(terminalId);
  return exitedMsg(terminalId);
}

export function startTelegramBridge(deps) {
  const {
    client,
    terminals,
    injectIntoTerminal,
    terminalEvents,
    makeDetector,
    db,
    config,
    setTimeoutFn = setTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    logger = console,
  } = deps;

  const waiting = new Set();
  const allow = new Set((config.allowlist || []).map(Number));
  const enabled = config.enabled === true && !!client;
  let offset = 0;
  let stopped = !enabled;
  let pruneTimer = null;

  function defaultChatId() {
    return config.default_chat_id;
  }

  async function notify(terminal, kind, bodyText, messageKind) {
    const chatId = defaultChatId();
    if (chatId === undefined || chatId === null) return;
    const sent = await client.sendMessage({
      chat_id: chatId,
      text: buildNotification(terminal, kind, bodyText),
    });
    const messageId = sent?.message_id;
    if (messageId === undefined) return;
    await db.saveTelegramBinding({
      message_id: messageId,
      terminal_id: terminal.id,
      chat_id: chatId,
      kind: messageKind,
    });
  }

  async function onNeedsInput(terminal, questionText) {
    waiting.add(terminal.id);
    terminal._tgQuestion = questionText;
    if (!triggerSendsQuestions(config.trigger)) return;
    try {
      await notify(terminal, 'question', questionText, 'question');
    } catch (e) {
      logger.warn(`[telegram] question notify failed: ${e.message}`);
    }
  }

  function onCleared(terminal) {
    waiting.delete(terminal.id);
  }

  async function onExit(terminal) {
    waiting.delete(terminal.id);
    if (!triggerSendsLifecycle(config.trigger)) return;
    try {
      await notify(terminal, 'lifecycle', terminal.status, 'lifecycle');
    } catch (e) {
      logger.warn(`[telegram] lifecycle notify failed: ${e.message}`);
    }
  }

  async function replyTo(update, text) {
    const chatId = update.message?.chat?.id;
    if (chatId === undefined) return;
    try {
      await client.sendMessage({
        chat_id: chatId,
        text,
        reply_to_message_id: update.message.message_id,
      });
    } catch (e) {
      logger.warn(`[telegram] reply failed: ${e.message}`);
    }
  }

  async function handleInjection(update, target) {
    const terminal = terminals.get(target.terminalId);
    const result = await injectIntoTerminal(terminal, target.text);
    if (result.ok) waiting.delete(target.terminalId);
    await replyTo(update, injectionReply(target.kind, target.terminalId, result));
  }

  async function handleCommand(update, target) {
    const list = waitingTerminalList(terminals, waiting);
    if (target.command === 'start') {
      await replyTo(update, START_HELP);
      return;
    }
    await replyTo(update, sessionsListMsg(list));
  }

  async function dispatchTarget(update, target) {
    if (target.kind === 'reply' || target.kind === 'single' || target.kind === 'prefix') {
      await handleInjection(update, target);
      return;
    }
    if (target.kind === 'command') {
      await handleCommand(update, target);
      return;
    }
    if (target.kind === 'target_gone') {
      await replyTo(update, exitedMsg(target.terminalId));
      return;
    }
    await replyTo(update, unresolvedMsg(waitingTerminalList(terminals, waiting)));
  }

  async function persistOffset(updateId) {
    offset = updateId + 1;
    await db.setPreference('telegram_offset', String(offset));
  }

  async function handleUpdate(update) {
    const chatId = update.message?.chat?.id;
    if (!allow.has(Number(chatId))) {
      logger.warn(`[telegram] dropped update from non-allowlisted chat ${chatId}`);
      await persistOffset(update.update_id);
      return;
    }
    const bindings = await buildBindings(update, db);
    const terminalsById = buildTerminalsById(terminals, waiting);
    const target = resolveTarget(update, bindings, terminalsById);
    await dispatchTarget(update, target);
    await persistOffset(update.update_id);
  }

  async function pollOnce() {
    const updates = await client.getUpdates({ offset, timeout: POLL_TIMEOUT_SECONDS });
    for (const update of updates) {
      await handleUpdate(update);
    }
    return updates.length;
  }

  async function runLoop() {
    while (!stopped) {
      try {
        await pollOnce();
        await new Promise(resolve => setTimeoutFn(resolve, 0));
      } catch (e) {
        logger.warn(`[telegram] poll error: ${e.message}`);
        await new Promise(resolve => setTimeoutFn(resolve, POLL_ERROR_BACKOFF_MS));
      }
    }
  }

  async function reclassifyOnStart() {
    for (const terminal of terminals.values()) {
      if (terminal.status !== 'running') continue;
      detector.track(terminal);
      try {
        const result = await detector.scanOnce(terminal);
        if (result?.fired) await onNeedsInput(terminal, result.questionText);
      } catch (e) {
        logger.warn(`[telegram] startup scan failed: ${e.message}`);
      }
    }
  }

  async function loadOffset() {
    const stored = await db.getPreference('telegram_offset');
    if (stored != null && stored !== '') offset = Number(stored);
  }

  function stop() {
    stopped = true;
    detector.stop();
    if (pruneTimer !== null) {
      clearIntervalFn(pruneTimer);
      pruneTimer = null;
    }
    terminalEvents.removeListener('exit', onExit);
  }

  async function sendTest(text = 'Architect Telegram bridge test') {
    const chatId = defaultChatId();
    if (chatId === undefined || chatId === null) return { ok: false, reason: 'no_default_chat' };
    await client.sendMessage({ chat_id: chatId, text });
    return { ok: true };
  }

  function status() {
    return {
      running: enabled && !stopped,
      enabled,
      waitingCount: waiting.size,
      offset,
    };
  }

  const detector = makeDetector({ onNeedsInput, onCleared });

  if (enabled) {
    terminalEvents.on('exit', onExit);
    pruneTimer = setIntervalFn(
      () => db.pruneTelegramBindings(PRUNE_MAX_AGE_DAYS).catch(() => {}),
      PRUNE_INTERVAL_MS,
    );
    loadOffset()
      .then(reclassifyOnStart)
      .then(runLoop)
      .catch(e => logger.warn(`[telegram] bridge start failed: ${e.message}`));
  }

  return { stop, status, sendTest, pollOnce, _waiting: waiting };
}
